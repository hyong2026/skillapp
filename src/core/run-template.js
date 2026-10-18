/**
 * run-template.js — 按 Template 执行：逐行读多维表格 → 跑 Skill → 回写结果
 *
 * 边界：多维表格只承担 IO（读输入 / 写输出），不写任何状态。
 *       Run 与其中的 RunItem 都记在 .data/runs/<run_id>/run.json。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { lark, larkAsync } from './lark.js';
import { createCodexEvents } from './live-log.js';
import { skillHash } from './skill-hash.js';
import { DATA_DIR, RUNS_DIR } from './paths.js';
const UPLOAD_CHUNK = 50; // 单次上传文件的个数上限
const RECORD_PAGE_SIZE = 200; // JSON 模式 record-list 的上限
const RUN_CONCURRENCY_DEFAULT = 4;
const RUN_CONCURRENCY_MAX = 8;

const TERMINAL_STATUSES = new Set(['completed', 'partial', 'failed', 'canceled', 'interrupted']);

/**
 * 宿主提供给 Skill 的通用生图入口（`node "$SKILLAPP_IMAGE_CLI" --prompt … --out …`）。
 *
 * 它是 SkillApp 自带的 Skill（`.agents/skills/image-generator`），模型 / 中转站 / 密钥来自
 * `SKILLAPP_IMAGE_*`。给绝对路径是为了让 Skill 不必知道自己在哪个仓库里、cwd 是什么。
 */
const IMAGE_CLI = path.resolve(import.meta.dirname, '..', '..', '.agents', 'skills', 'image-generator', 'scripts', 'generate.js');

/**
 * 同一 Run 内同时跑几行：`SKILLAPP_RUN_CONCURRENCY`（`.env` / Settings 里改，默认 4）。
 * 每次调用时读取，所以改完不必重启；上限 8——再高只会让飞书接口和本机 CPU 互相排队。
 */
function runConcurrency() {
  const value = Number.parseInt(process.env.SKILLAPP_RUN_CONCURRENCY ?? '', 10);
  if (!Number.isFinite(value) || value < 1) return RUN_CONCURRENCY_DEFAULT;
  return Math.min(value, RUN_CONCURRENCY_MAX);
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function generateRunId(date = new Date()) {
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    + `-${Math.random().toString(16).slice(2, 6)}`;
}

const noop = () => {};

// ─── 多维表格读写 ─────────────────────────────────────────────────────────

const tableFlags = (tpl, ...rest) => [
  '--base-token', tpl.target.base_token,
  '--table-id', tpl.target.table_id,
  '--as', 'user',
  ...rest,
];

async function updateRow(tpl, recordId, patch) {
  await larkAsync(['base', '+record-batch-update', ...tableFlags(tpl,
    '--json', JSON.stringify({ update_records: { [recordId]: patch } }))]);
}

/** stdout / stderr 按原样落成 .log：它是给人（和 WebUI）看的文本，不做 JSON 包装。 */
function writeStreamLog(recordDir, stream, text) {
  const logsDir = path.join(recordDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, `${stream}.log`), text || '');
}

/**
 * 边跑边落盘：长跑的 Skill（尤其 prompt 型，动辄十几分钟）在进程被打断时也该留下日志，
 * 刷新页面也能读回已经产出的部分。跑完后仍会整段重写一次，保证文件与服务端缓冲一致。
 */
function appendStreamLog(recordDir, stream, text) {
  const logsDir = path.join(recordDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.appendFileSync(path.join(logsDir, `${stream}.log`), text || '');
}

/** 记录列表 → [{ record_id, cells }]，cells 是 field_id → 值 */
function readRows(tpl, fieldIds) {
  const rows = [];
  const projection = fieldIds.flatMap((fieldId) => ['--field-id', fieldId]);

  for (let offset = 0; ;) {
    const d = lark(['base', '+record-list', ...tableFlags(tpl,
      '--format', 'json', '--limit', String(RECORD_PAGE_SIZE), '--offset', String(offset), ...projection,
    )]).data;
    const zip = (values) => Object.fromEntries(d.field_id_list.map((fid, i) => [fid, values[i]]));
    for (let i = 0; i < d.record_id_list.length; i++) {
      rows.push({ record_id: d.record_id_list[i], cells: zip(d.data[i]) });
    }
    if (d.record_id_list.length < RECORD_PAGE_SIZE) break;
    offset += d.record_id_list.length;
  }

  return rows;
}

// 按行发生的调用一律走异步版：并行时它们才能真正重叠（详见 larkAsync 的说明）。
const download = (tpl, recordId, att, dest) => larkAsync(['base', '+record-download-attachment', ...tableFlags(tpl,
  '--record-id', recordId, '--file-token', att.file_token, '--output', dest, '--overwrite')]);

const upload = (tpl, recordId, fieldId, files) => larkAsync(['base', '+record-upload-attachment', ...tableFlags(tpl,
  '--record-id', recordId, '--field-id', fieldId, ...files.flatMap((f) => ['--file', f]))]);

// ─── 取值与命令组装 ───────────────────────────────────────────────────────

/**
 * 按点分路径取值，结果始终是数组。
 * 段尾的 `[]` 表示对上一步结果逐项取值——注意必须**原样返回该数组**，
 * 靠 flatMap 拍平一层把它摊成多个元素，否则后续段会拿到数组本身而不是元素。
 */
function walk(root, segments) {
  let cur = [root];
  for (const seg of segments) {
    const pluck = seg.endsWith('[]');
    const key = pluck ? seg.slice(0, -2) : seg;
    cur = cur.flatMap((v) => {
      if (v == null) return [];
      const val = v[key];
      return pluck ? (Array.isArray(val) ? val : []) : [val];
    });
  }
  return cur;
}

const resolvePath = (root, dotted) => walk(root, dotted.split('.'))[0];

/**
 * 求值 mapping 的 from 表达式：
 *   "stdout.canvas.width"     值
 *   "stdout.fileSize / 1024"  值 / 1024
 *   "stdout.files[].path"     数组（产物是一组文件时用）
 */
function evalFrom(expr, stdout) {
  const m = /^stdout\.([\w.\[\]]+?)(?:\s*\/\s*([\d.]+))?$/.exec(expr.trim());
  if (!m) throw new Error(`Unsupported expression (must start with stdout.): ${expr}`);

  const plucked = m[1].includes('[]');
  let out = walk(stdout, m[1].split('.'));
  if (!plucked) out = out[0];
  if (out == null || out.length === 0) throw new Error(`Expression resolved to empty: ${expr}`);

  if (m[2]) {
    const d = parseFloat(m[2]);
    out = plucked ? out.map((v) => v / d) : out / d;
  }
  return out;
}

/**
 * 按空白切分命令，但 `{}` 内部与引号内部的空白不算：
 *   - `{--flag key}` 这种成对参数要写成单个 token；
 *   - 整段自然语言提示词（prompt 型 Skill 的 cmd）用双引号包成单个 token。
 * 引号本身不进入结果（相当于 shell 的去引号），token 内部的 `{key}` 照常留给后续替换。
 */
function tokenize(cmd) {
  const tokens = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  let started = false;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else { cur += ch; started = true; }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (started) tokens.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  return started ? [...tokens, cur] : tokens;
}

// mapping.cmd 的三种 token 写法。整块就是一个花括号的才按命令参数处理，嵌在文本里的按文本处理。
const PAIRED_TOKEN = /^\{(\S+)\s+(\w+)\}$/; // {--flag key}
const SPLAT_TOKEN = /^\{(\w+)\.\.\.\}$/; // {key...}
const SINGLE_TOKEN = /^\{([\w.]+)\}$/; // {key} / {skill.entry}
const POSITIONAL_TOKEN = /^\{(\w+)(?:\.\.\.)?\}$/; // 必须有值的位置参数
const TEXT_PLACEHOLDER = /\{([\w.]+?)(\.\.\.)?\}/g; // 文本里的占位符（可能带 ... 后缀）

/** 文本里数组怎么落地：`{key...}` 空格连接（贴近位置参数），`{key}` 逗号连接。 */
function spliceText(value, splat) {
  if (Array.isArray(value)) return value.join(splat ? ' ' : ', ');
  return value === null || value === undefined ? '' : String(value);
}

/**
 * mapping.cmd 的模板语法：
 *   {key}         该值；未定义则报错 —— 必填参数
 *   {key...}      展开为数组，位置参数传多个文件
 *   {--flag key}  成对参数：值为空或该列已被删除时整对省略 —— 可选参数
 *
 * prompt 型 Skill 的整段指令带引号，是**一个** token：那里没有 argv 的位置概念，
 * 占位符就地替换成文本——`{key...}` 展开成空格分隔的列表，可选值留空渲染成空串
 * （留空是它的常态：`参考图=` / `补充备注=` 照原样进指令，必填缺失由 prepareInputs 报）。
 */
function buildArgv(cmd, vars) {
  const argv = [];
  for (const tok of tokenize(cmd)) {
    const paired = PAIRED_TOKEN.exec(tok);
    if (paired) {
      const v = resolvePath(vars, paired[2]);
      if (v !== undefined && v !== null && v !== '') argv.push(paired[1], String(v));
      continue;
    }

    const splat = SPLAT_TOKEN.exec(tok);
    if (splat) {
      const arr = resolvePath(vars, splat[1]);
      if (!Array.isArray(arr)) throw new Error(`{${splat[1]}...} in cmd is not an array`);
      argv.push(...arr);
      continue;
    }

    const single = SINGLE_TOKEN.exec(tok);
    if (single) {
      const v = resolvePath(vars, single[1]);
      if (v === undefined) throw new Error(`{${single[1]}} in cmd is undefined`);
      // 位置参数传数组只有 `{key...}` 一种写法，别让它悄悄变成 "a,b" 一个参数。
      if (Array.isArray(v)) throw new Error(`{${single[1]}} is an array; write {${single[1]}...} to expand it`);
      argv.push(String(v));
      continue;
    }

    argv.push(tok.replace(TEXT_PLACEHOLDER, (whole, key, dots) => spliceText(resolvePath(vars, key), dots)));
  }
  return argv;
}

/** cmd 里的内置变量，不是输入列（与 bind-table 的 checkCmd 保持一致）。 */
const BUILTIN_VARS = new Set(['outdir', 'skill']);

/**
 * prompt 型 Skill 的 cmd 是 `codex exec …`。默认它会把整段 agent 会话打进 stderr，
 * 补上 `--json` 后 stdout 变成事件流，才有 live.log 可读（见 live-log.js）。
 * Template 里自己写了这两个参数的以 Template 为准。
 */
function withCodexEvents(argv) {
  if (argv[0] !== 'codex' || argv[1] !== 'exec') return argv;
  const rest = argv.slice(2);
  if (rest.includes('--json') && rest.includes('--color')) return argv;
  return [
    'codex',
    'exec',
    ...(rest.includes('--json') ? [] : ['--json']),
    ...(rest.includes('--color') ? [] : ['--color', 'never']),
    ...rest,
  ];
}

/**
 * 扫一遍 cmd，供运行前核对（preflight）：引用了哪些变量、哪些是必须有值的位置参数、
 * 哪些整块花括号根本不合法。运行前就能说清楚，不必等某一行跑起来才报错。
 */
function scanCmd(cmd) {
  const names = new Set();
  const positionals = new Set();
  const malformed = [];
  for (const token of tokenize(cmd)) {
    const paired = PAIRED_TOKEN.exec(token);
    if (paired) {
      for (const part of paired[1].split(/\s+/).filter(Boolean)) {
        if (!part.startsWith('-')) names.add(part);
      }
      names.add(paired[2]);
      continue;
    }
    const positional = POSITIONAL_TOKEN.exec(token);
    if (positional) {
      names.add(positional[1]);
      positionals.add(positional[1]);
      continue;
    }
    const single = SINGLE_TOKEN.exec(token);
    if (single) {
      names.add(single[1]);
      continue;
    }
    // 整块花括号却三种写法都不是（例如 `{--format}`）：写错了，别当普通文本传下去。
    if (/^\{[^{}]*\}$/.test(token)) {
      malformed.push(token);
      continue;
    }
    for (const match of token.matchAll(TEXT_PLACEHOLDER)) names.add(match[1]);
  }
  return { names, positionals: [...positionals], malformed };
}


// ─── 输入指纹与运行历史 ───────────────────────────────────────────────────

/** 覆盖全部输入单元格。附件计入 file_token，故换图即失效。 */
function fingerprint(cells) {
  const stable = Object.fromEntries(Object.entries(cells).sort(([a], [b]) => a.localeCompare(b)));
  // 和 skill_hash / work_hash 一样带算法前缀，界面上所有 hash 一个样。
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 16);
}

const fingerprintOf = (inputs, cells) =>
  fingerprint(Object.fromEntries(inputs.map((i) => [i.field_id, cells[i.field_id]])));

const withoutLiveName = ({ field_name, ...field }) => field;

const shortHash = (value) => 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/** 工作版本 = Skill + 命令 + 目标 + 输入 + 输出定义；任一变化都该让 --incremental 重跑。 */
function workHashOf(tpl, inputs, outputs) {
  return shortHash({
    skill_hash: tpl.skill.hash,
    target: tpl.target,
    cmd: tpl.mapping.cmd,
    inputs: inputs.map(withoutLiveName),
    outputs: outputs.map(withoutLiveName),
  });
}

/** 同一个工作版本里"要不要跑 Skill"的那半（不含输出定义）：续跑只认它，所以改 `from` 表达式不必重跑 Skill。 */
function execHashOf(tpl, inputs) {
  return shortHash({
    skill_hash: tpl.skill.hash,
    target: tpl.target,
    cmd: tpl.mapping.cmd,
    inputs: inputs.map(withoutLiveName),
  });
}

/**
 * 本 Template 的历史：record_id → 最近一次运行结果。
 *
 * 必须按 template_id 过滤——同一张表上可能挂着别的 Template，
 * 混进来会让「最近一次」变成别人的那次，导致本 Template 永远被判为待运行。
 * 按 run_id 从旧到新覆盖，因此内存里只需要保留每个 record 的最后状态。
 */
function loadHistory(templateId) {
  const history = new Map();
  if (!fs.existsSync(RUNS_DIR)) return history;

  for (const runId of fs.readdirSync(RUNS_DIR).sort()) {
    const file = path.join(RUNS_DIR, runId, 'run.json');
    if (!fs.existsSync(file)) continue;
    const run = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (run.template_id !== templateId) continue;
    for (const { record_id, status, input_hash } of run.items) {
      // run_id 指向这份记录的目录：失败行要续跑时得回去拿它的 stdout 与产物。
      history.set(record_id, { status, input_hash, work_hash: run.work_hash, exec_hash: run.exec_hash, run_id: runId });
    }
  }
  return history;
}

/**
 * 该行是否已是最新状态——只看**最近一次**运行。
 * 若改用「历史上任意一次成功」，把输入改回旧值会被误判为已完成，
 * 而表里的输出其实是另一组输入产生的。
 */
function upToDate(history, recordId, inputHash, workHash) {
  const last = history.get(recordId);
  return Boolean(last && last.status === 'succeeded'
    && last.input_hash === inputHash && last.work_hash === workHash);
}

// ─── 运行前核对 ───────────────────────────────────────────────────────────

/**
 * 返回实际生效的映射。
 *
 * 列可以被手工删除——那是预期用法：删掉的列从映射中剔除，执行时只读写剩下的。
 * 三类情况仍拒绝运行：Skill 指纹不符；必填输入被删除；列还在但类型不符。
 */
/**
 * 运行前核对里「只看本地文件」的那一半：归档、Skill 指纹、cmd 模板语法。
 *
 * 单独拆出来是给服务端用的——它不碰飞书，`start()` / `preview()` 就能在起 worker 之前
 * 拒绝，而不是先建一个 Run 再把它标成 Failed（那会留下一条谁也看不懂的空记录）。
 */
function templateProblems(tpl, dataDir) {
  const reload = `node src/cli/load-skill.js <source-dir>`;
  const skillDir = path.join(dataDir, tpl.skill.path);
  const problems = [];

  if (tpl.archived_at) {
    problems.push(`Template is archived (frozen at ${tpl.archived_at}); unarchive it before running`);
  } else if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
    problems.push(`Skill is not loaded: ${tpl.skill.path}\n  Run first: ${reload}`);
  } else {
    const live = skillHash(skillDir);
    if (live !== tpl.skill.hash) {
      problems.push(`Skill hash mismatch; run refused:\n  template = ${tpl.skill.hash}\n  on-disk  = ${live}\n  Reload: ${reload}`);
    }
  }

  // cmd 是纯文本模板，语法错、写错变量名都只会在某一行跑起来时才炸——先扫一遍。
  const scan = scanCmd(tpl.mapping.cmd);
  if (scan.malformed.length) {
    problems.push(`cmd has a malformed placeholder: ${scan.malformed.join(', ')}\n  Fix: use {key}, {key...} or {--flag key}`);
  }

  // 模板里只有已映射的输入；cmd 却把它当位置参数用时只能逐行报 undefined——提前说清楚。
  const mappedKeys = new Set(tpl.mapping.inputs.map((f) => f.key));
  const orphans = scan.positionals.filter((key) => !BUILTIN_VARS.has(key) && !mappedKeys.has(key));
  if (orphans.length) {
    problems.push(`Input is not mapped but cmd needs it:\n  - ${orphans.join('\n  - ')}\n  Fix: map the input, or drop its variable from cmd`);
  }

  const knownKeys = new Set(['skill.entry', ...BUILTIN_VARS, ...mappedKeys]);
  const unknown = [...scan.names].filter((key) => !knownKeys.has(key));
  if (unknown.length) {
    problems.push(`cmd references unknown variables:\n  - ${unknown.join('\n  - ')}\n  Fix: correct the name, or map an input with that key`);
  }
  return problems;
}

/**
 * 运行前核对：返回实际生效的映射；有任何一条不过就拒绝运行。
 *
 * 列可以被手工删除——那是预期用法：删掉的列从映射中剔除，执行时只读写剩下的。
 * 本地那几条（归档 / Skill 指纹 / cmd 语法）走 templateProblems，这里再核对活表：
 * 必填输入被删除、列还在但类型不符、主字段没了。
 */
function preflight(tpl) {
  const local = templateProblems(tpl, DATA_DIR);
  if (local.length) throw new Error(local.join('\n\n'));

  const skillDir = path.join(DATA_DIR, tpl.skill.path);
  const fields = lark(['base', '+field-list', ...tableFlags(tpl)]).data.fields;
  const byId = new Map(fields.map((f) => [f.id, f]));
  const problems = [];

  // 列名以活表为准——模板里不重复存。已删除的列取不到名字，退回 field_id。
  const named = (f) => ({ ...f, field_name: byId.get(f.field_id)?.name ?? f.field_id });

  const stillThere = (f) => {
    const actual = byId.get(f.field_id);
    if (!actual) return false;
    if (actual.type !== f.type) problems.push(`Type mismatch: ${actual.name} template=${f.type} table=${actual.type}`);
    return true;
  };

  const inputs = tpl.mapping.inputs.filter(stillThere).map(named);
  const outputs = tpl.mapping.outputs.filter(stillThere).map(named);

  for (const f of tpl.mapping.inputs) {
    if (f.required && !byId.has(f.field_id)) problems.push(`Required input is missing: ${named(f).field_name} (${f.field_id})`);
  }
  if (!byId.has(tpl.target.primary_field_id)) problems.push(`Primary field is missing: ${tpl.target.primary_field_id}`);
  if (problems.length) throw new Error(`Template does not match the current table; run refused:\n  - ${problems.join('\n  - ')}`);

  const dropped = [...tpl.mapping.inputs, ...tpl.mapping.outputs]
    .filter((f) => !byId.has(f.field_id))
    .map(named);
  return { skillDir, inputs, outputs, dropped };
}

// ─── 断点续跑 ─────────────────────────────────────────────────────────────

/** 行目录里的 stdout.json：Skill 解析后的输出，回写失败后靠它续跑（也方便排查"到底吐了什么"）。 */
function writeStdoutJson(recordDir, stdout) {
  const file = path.join(recordDir, 'stdout.json');
  fs.mkdirSync(recordDir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stdout, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** 把 stdout JSON 里指向上一次行目录的路径改写到这次的行目录（其余原样，例如 /tmp 下的中间文件）。 */
function remapPaths(value, from, to) {
  if (typeof value === 'string') {
    return value.startsWith(`${from}${path.sep}`) ? path.join(to, path.relative(from, value)) : value;
  }
  if (Array.isArray(value)) return value.map((entry) => remapPaths(entry, from, to));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, remapPaths(entry, from, to)]));
  }
  return value;
}

/** 这次 Run 里实际要用到的附件产物（按 from 表达式从 stdout 取出来的绝对路径）。 */
function attachmentPaths(outputs, stdout) {
  const files = [];
  for (const output of outputs) {
    if (output.type !== 'attachment') continue;
    for (const file of [].concat(evalFrom(output.from, stdout))) {
      if (typeof file === 'string' && file.trim()) files.push(file);
    }
  }
  return [...new Set(files)];
}

/** 上次失败、输入与 exec 版本没变、stdout.json 在、要回写的产物都还在 → 返回它；否则 null（老实重跑）。 */
function resumePoint(ctx, recordId, inputHash, runsDir = RUNS_DIR) {
  if (ctx.dryRun || ctx.trigger !== 'incremental') return null; // 全量 = 无条件重跑
  const last = ctx.history?.get(recordId);
  if (!last || last.status !== 'failed') return null;
  if (last.input_hash !== inputHash || last.exec_hash !== ctx.execHash) return null;
  const prevRecordDir = path.join(runsDir, last.run_id, recordId);
  const file = path.join(prevRecordDir, 'stdout.json');
  if (!fs.existsSync(file)) return null;
  let stdout;
  try {
    stdout = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  try {
    if (attachmentPaths(ctx.outputs, stdout).some((entry) => !fs.existsSync(entry))) return null;
  } catch {
    return null; // 表达式对不上这份 stdout
  }
  return { runId: last.run_id, prevRecordDir, stdout };
}

/** 把上一次的产物搬进这次的行目录（硬链接优先，跨卷则复制），并返回改写过路径的 stdout。 */
function reuseOutputs(ctx, resume, recordDir) {
  let reused = 0;
  for (const file of attachmentPaths(ctx.outputs, resume.stdout)) {
    if (!file.startsWith(`${resume.prevRecordDir}${path.sep}`)) continue; // 行目录之外的文件（例如 /tmp）不动
    const dest = path.join(recordDir, path.relative(resume.prevRecordDir, file));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      fs.linkSync(file, dest);
    } catch {
      fs.copyFileSync(file, dest);
    }
    reused += 1;
  }
  const stdout = remapPaths(resume.stdout, resume.prevRecordDir, recordDir);
  writeStdoutJson(recordDir, stdout);
  return { stdout, reused };
}

// ─── 单行执行 ─────────────────────────────────────────────────────────────

/**
 * 飞书文本列里的链接会被存成 `[标题](URL)`，而 Skill 要的是裸 URL。
 * 只在整个单元格就是一个 Markdown 链接时解开——其余原样透传。
 */
function unwrapLinkMarkup(value) {
  const match = /^\s*\[[^\]]*\]\((\S+)\)\s*$/.exec(String(value ?? ''));
  return match ? match[1] : value;
}

/** 校验输入、下载附件、组装命令。返回 cmd 变量；校验不过则返回错误信息。 */
async function prepareInputs(ctx, recordId, recordDir, cells) {
  const { tpl, skillDir } = ctx;
  // 入口给绝对路径：Skill 进程的 cwd 是内容层根，不是 Skill 目录（见 spawnSkill 的说明）。
  const vars = { skill: { ...tpl.skill, entry: path.resolve(skillDir, tpl.skill.entry) } };

  for (const inp of ctx.inputs) {
    const value = cells[inp.field_id];
    const rule = inp.validate || {};

    if (inp.type === 'attachment') {
      const atts = Array.isArray(value) ? value : [];
      if (rule.count !== undefined && atts.length !== rule.count) {
        return { error: `${inp.field_name} requires exactly ${rule.count} file(s), got ${atts.length}` };
      }
      const min = rule.min_count ?? (inp.required ? 1 : 0);
      if (atts.length < min) return { error: `${inp.field_name} requires at least ${min} file(s), got ${atts.length}` };
      if (rule.max_count !== undefined && atts.length > rule.max_count) {
        return { error: `${inp.field_name} allows at most ${rule.max_count} file(s), got ${atts.length}` };
      }
      // 每行独立目录，避免同名附件互相覆盖；同名时才加后缀，保留原文件名
      const dir = path.join(recordDir, 'downloads');
      fs.mkdirSync(dir, { recursive: true });
      const seen = new Map();
      if (!ctx.dryRun && atts.length) ctx.emit({ type: 'item-stage', record_id: recordId, stage: 'download' });
      // 同一行的多个附件一起下（Promise.all 保序），不同行之间也互不阻塞。
      vars[inp.key] = await Promise.all(atts.map((att) => {
        const n = (seen.get(att.name) || 0) + 1;
        seen.set(att.name, n);
        const ext = path.extname(att.name);
        const name = n === 1 ? att.name : `${path.basename(att.name, ext)}-${n}${ext}`;
        const dest = path.join(dir, name);
        return ctx.dryRun ? dest : download(tpl, recordId, att, dest).then(() => dest);
      }));
      continue;
    }

    let v = Array.isArray(value) ? value[0] : value;
    if (v === null || v === undefined || v === '') {
      if (inp.required && inp.default === undefined) return { error: `${inp.field_name} is required` };
      v = inp.default;
    }
    if (inp.type === 'text') v = unwrapLinkMarkup(v);
    if (rule.enum && !rule.enum.includes(v)) {
      return { error: `${inp.field_name} value ${JSON.stringify(v)} is not in ${JSON.stringify(rule.enum)}` };
    }
    if (rule.min !== undefined && v < rule.min) return { error: `${inp.field_name} must be at least ${rule.min}, got ${v}` };
    if (rule.max !== undefined && v > rule.max) return { error: `${inp.field_name} must be at most ${rule.max}, got ${v}` };
    if (inp.transform && inp.transform[v] !== undefined) v = inp.transform[v];

    vars[inp.key] = v;
  }
  return { vars };
}

/** 表达式对不上时点出 Skill 实际吐的形状：`stdout.files[]` 与 `stdout.files[].path` 只差一个后缀。 */
function shapeHint(expression, stdout) {
  const root = /^stdout\.([\w]+)/.exec(expression || '')?.[1];
  if (!root || !stdout || typeof stdout !== 'object' || !(root in stdout)) {
    const keys = stdout && typeof stdout === 'object' ? Object.keys(stdout).join(', ') || '(none)' : typeof stdout;
    return `\n  stdout has: ${keys}`;
  }
  const value = stdout[root];
  const shape = Array.isArray(value) ? `an array of ${typeof value[0]}` : typeof value;
  return `\n  stdout.${root} is ${shape}`;
}

/**
 * 按 mapping 回写该行：先解析全部输出，再提交。
 *
 * 附件类型的输出即产物——它只能靠上传文件写入，所以按类型判定，不需要额外标记。
 * 同一个解析式返回数组（一组文件）或字符串（单个文件）都可以。
 */
async function writeBack(ctx, item, stdout) {
  const { tpl, outputs } = ctx;
  const scalars = {};
  for (const o of outputs) {
    if (o.type === 'attachment') continue;
    let v = evalFrom(o.from, stdout);
    if (o.round !== undefined) v = Number(v.toFixed(o.round));
    scalars[o.field_id] = v;
  }

  for (const o of outputs) {
    if (o.type !== 'attachment') continue;
    // 取值表达式和 Skill 实际输出对不上时（例如输出的是路径数组，表达式却按对象数组取 .path），
    // walk 会摊出一串 undefined；带着它去调 lark-cli 只会换来一句看不懂的参数校验错误。
    const files = [...new Set([].concat(evalFrom(o.from, stdout)).filter((p) => typeof p === 'string' && p.trim()))];
    if (!files.length) throw new Error(`Expression resolved to no file paths: ${o.from}${shapeHint(o.from, stdout)}`);
    item.stage = 'writeback';
    ctx.emit({ type: 'item-stage', record_id: item.record_id, stage: 'writeback' });
    await updateRow(tpl, item.record_id, { [o.field_id]: null }); // 上传是追加语义，先清空
    item.stage = 'upload';
    ctx.emit({ type: 'item-stage', record_id: item.record_id, stage: 'upload' });
    for (let i = 0; i < files.length; i += UPLOAD_CHUNK) {
      await upload(tpl, item.record_id, o.field_id, files.slice(i, i + UPLOAD_CHUNK));
    }
  }

  if (Object.keys(scalars).length) {
    item.stage = 'writeback';
    ctx.emit({ type: 'item-stage', record_id: item.record_id, stage: 'writeback' });
    await updateRow(tpl, item.record_id, scalars);
  }
}

function spawnSkill(bin, args, options) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // 除了继承环境（.env 里的 SKILLAPP_IMAGE_* 等），再告诉 Skill 生图入口在哪。
      env: { ...process.env, SKILLAPP_IMAGE_CLI: IMAGE_CLI },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // Process already exited.
      }
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* Process already exited. */ }
      }, 1000).unref();
    }, options.timeoutMs);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      options.onStdout(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      options.onStderr(text);
    });
    child.on('error', (err) => finish({ status: -1, signal: null, stdout, stderr: `${stderr}${err.message}`, timedOut }));
    child.on('close', (status, signal) => finish({ status, signal, stdout, stderr, timedOut }));
  });
}

/**
 * 一行怎么跑。
 *
 * 包一层 catch：行内的意外错误（飞书 CLI 抛错、cmd 拼不出来…）只算**这一行**失败，
 * 不能让它冒泡出去打断 Run——那会留下一个永远 Running 的 Item（Run 是记录，行是明细，
 * 两者不能各说各话）。可控的错误（校验不过、退出码非 0）仍在下面 return fail(...)。
 */
async function runRow(ctx, row) {
  const item = { record_id: row.record_id, status: 'pending', stage: 'validate', ms: null, error: null, input_hash: null };
  try {
    return await runRowSteps(ctx, row, item);
  } catch (err) {
    return { ...item, status: 'failed', error: err?.message || String(err), stage: item.stage || null };
  }
}

async function runRowSteps(ctx, row, item) {
  const { tpl, skillDir, workdir, dryRun } = ctx;
  const { record_id: recordId, cells } = row;
  const recordDir = path.join(workdir, recordId);
  const fail = (error) => ({ ...item, status: 'failed', error, stage: item.stage || null });

  // 1) 先算指纹（失败行也要有，便于诊断）
  item.input_hash = fingerprintOf(ctx.inputs, cells);

  // 2) 能续就续：只补回写，不再跑 Skill（判定见 resumePoint）。
  const resume = resumePoint(ctx, recordId, item.input_hash);
  let stdout = null;
  if (resume) {
    item.resumed_from = resume.runId;
    item.stage = 'writeback';
    const { stdout: reusedStdout, reused } = reuseOutputs(ctx, resume, recordDir);
    stdout = reusedStdout;
    // 日志里留一句：这行没有重跑 Skill，免得看日志的人以为它什么都没干。
    const note = `[skillapp] resumed from ${resume.runId}: reused ${reused} file(s); the Skill was not run again\n`;
    const stream = /^SKILL\.md$/i.test(String(ctx.tpl.skill?.entry || '')) ? 'live' : 'stdout';
    appendStreamLog(recordDir, stream, note);
    ctx.emit({ type: 'item-log', record_id: recordId, stream, chunk: note });
    return (await finishRow(ctx, item, stdout, fail)) ?? { ...item, status: 'succeeded', stage: null };
  }

  // 3) 校验输入并组装命令
  const { vars, error } = await prepareInputs(ctx, recordId, recordDir, cells);
  if (error) return fail(error);

  item.stage = 'exec';
  ctx.emit({ type: 'item-stage', record_id: recordId, stage: 'exec' });
  vars.outdir = path.join(recordDir, 'artifacts');
  fs.mkdirSync(vars.outdir, { recursive: true });
  const argv = withCodexEvents(buildArgv(tpl.mapping.cmd, vars));
  if (dryRun) return { ...item, status: 'dry-run', argv };

  // 3) 执行
  const [bin, ...binArgs] = argv; // cmd 是完整命令行，首个 token 即可执行文件
  const t0 = Date.now();
  // prompt 型（命令带 --json）的进度整理进 live.log；它的 stderr 就那么点诊断信息，
  // 也并进这一份，不再单开 stderr.log —— 会话原文不再是 SkillApp 的日志。
  const live = argv.includes('--json') ? createCodexEvents() : null;
  let liveText = '';
  const appendLive = (chunk) => {
    if (!chunk) return;
    liveText += chunk;
    appendStreamLog(recordDir, 'live', chunk);
    ctx.emit({ type: 'item-log', record_id: recordId, stream: 'live', chunk });
  };
  // 清空本次要写的文件：本次没输出就应该是空的，别留下上一次（同目录不会复用，仅为稳妥）。
  writeStreamLog(recordDir, 'stdout', '');
  writeStreamLog(recordDir, live ? 'live' : 'stderr', '');
  const res = await spawnSkill(bin, binArgs, {
    // cwd 不能用 Skill 目录：lark-cli 只允许把文件写到 cwd / /tmp / ~/files，
    // 而 Skill 的产物目录在 .data/runs/ 之下——cwd 必须是它的祖先，Skill 自己的
    // lark-cli 调用（例如 --output 写 ndjson）才不会被白名单拒绝。
    cwd: DATA_DIR,
    timeoutMs: (tpl.limits?.timeout_s || 60) * 1000,
    onStdout: (chunk) => {
      appendStreamLog(recordDir, 'stdout', chunk);
      ctx.emit({ type: 'item-log', record_id: recordId, stream: 'stdout', chunk });
      if (live) appendLive(live.push(chunk));
    },
    onStderr: (chunk) => {
      if (live) {
        appendLive(chunk);
        return;
      }
      appendStreamLog(recordDir, 'stderr', chunk);
      ctx.emit({ type: 'item-log', record_id: recordId, stream: 'stderr', chunk });
    },
  });
  item.ms = Date.now() - t0;
  if (live) appendLive(live.flush());
  writeStreamLog(recordDir, 'stdout', res.stdout);
  if (live) writeStreamLog(recordDir, 'live', liveText);
  else writeStreamLog(recordDir, 'stderr', res.stderr);
  if (res.timedOut) return fail(`Skill timed out after ${tpl.limits?.timeout_s || 60}s`);
  if (res.error) return fail(`Skill failed to start: ${res.error.message}`);
  if (res.status !== 0) {
    const detail = (res.stderr || '').trim().split('\n').filter(Boolean).pop() || live?.lastError() || '';
    return fail(`Skill exited with code ${res.status}: ${detail}`);
  }

  // 没有输出列的 Template 不回写：这类 Skill 的结果落在别处（例如输入里给的另一张表），
  // 所以也不必解析 stdout —— 它不需要吐 JSON。
  if (ctx.outputs.length) {
    try {
      // 事件流模式下答案在最后一条 agent 消息里；不是事件流就还是 stdout 原文。
      stdout = JSON.parse(live?.finalMessage() ?? res.stdout);
    } catch {
      return fail('Skill output is not valid JSON');
    }
    // 落盘"Skill 到底吐了什么"：回写失败时续跑靠它，排查也靠它（见 resumePoint）。
    if (!dryRun) writeStdoutJson(recordDir, stdout);
  }

  return (await finishRow(ctx, item, stdout, fail)) ?? { ...item, status: 'succeeded', stage: null };
}

/** 回写；失败时返回失败态（调用方直接用它，别自己再判一次）。 */
async function finishRow(ctx, item, stdout, fail) {
  try {
    await writeBack(ctx, item, stdout);
  } catch (err) {
    return fail(err.message);
  }
  return null;
}

// ─── 服务接口 ─────────────────────────────────────────────────────────────

function normalizeOptions(options = {}) {
  // 只有两种触发：增量（只跑该跑的）与全量（整表重跑）。指定 record-id 已移除。
  return { trigger: options.trigger === 'incremental' ? 'incremental' : 'all', dryRun: Boolean(options.dryRun) };
}

function selectRows(tpl, options) {
  const normalized = normalizeOptions(options);
  const { skillDir, inputs, outputs, dropped } = preflight(tpl);
  const workHash = workHashOf(tpl, inputs, outputs);
  const all = readRows(tpl, inputs.map((input) => input.field_id));
  const history = loadHistory(tpl.template_id);

  let rows = all;
  if (normalized.trigger === 'incremental') {
    rows = all.filter((row) => !upToDate(
      history,
      row.record_id,
      fingerprintOf(inputs, row.cells),
      workHash,
    ));
  }

  const cap = tpl.limits?.max_rows_per_run;
  if (cap && rows.length > cap) {
    throw new Error(`Selected ${rows.length} rows, exceeding the Template limit of ${cap}; split the table or raise limits.max_rows_per_run`);
  }

  return { ...normalized, skillDir, inputs, outputs, dropped, workHash, execHash: execHashOf(tpl, inputs), history, all, rows };
}

function previewTemplate(tpl, options = {}) {
  const selected = selectRows(tpl, options);
  return {
    template_id: tpl.template_id,
    trigger: selected.trigger,
    dry_run: selected.dryRun,
    total: selected.all.length,
    selected: selected.rows.length,
    dropped: selected.dropped.map((field) => field.field_name),
    target: tpl.target,
  };
}

function makeRun(tpl, selected, runId, runDir, startedAt, templateName = null) {
  return {
    run_id: runId,
    template_id: tpl.template_id,
    // Template 名字在发起时就定下来，之后不再查表：Run 是记录，不是视图。
    template_name: templateName,
    // 入口就是 SKILL.md 的是 prompt 型 Skill（cmd 通常交给 codex exec）：日志看"实时"那一套。
    skill_entry: tpl.skill?.entry || null,
    skill_hash: tpl.skill.hash,
    work_hash: selected.workHash,
    exec_hash: selected.execHash,
    trigger: selected.trigger,
    dry_run: selected.dryRun,
    started_at: startedAt,
    finished_at: null,
    status: 'running',
    total: selected.rows.length,
    completed: 0,
    succeeded: 0,
    failed: 0,
    dropped: selected.dropped.map((field) => field.field_name),
    items: selected.rows.map((row) => ({
      record_id: row.record_id,
      status: 'queued',
      stage: null,
      ms: null,
      error: null,
      input_hash: fingerprintOf(selected.inputs, row.cells),
    })),
  };
}

function finalStatus(run, dryRun) {
  if (dryRun) return 'dry-run';
  if (run.failed === 0) return 'completed';
  return run.succeeded === 0 ? 'failed' : 'partial';
}

async function runTemplate({
  template, options = {}, runId = generateRunId(), runDir, onEvent = noop, templateName = null,
}) {
  const selected = selectRows(template, options);
  const workdir = runDir || (selected.dryRun
    ? fs.mkdtempSync('/tmp/skillapp-dry-')
    : path.join(RUNS_DIR, runId));
  fs.mkdirSync(workdir, { recursive: true });

  const persist = (run) => {
    if (!selected.dryRun) atomicWriteJson(path.join(workdir, 'run.json'), run);
  };
  const startedAt = new Date().toISOString();
  const run = makeRun(template, selected, runId, workdir, startedAt, templateName);
  const emit = async (event) => {
    if (event.type === 'item-stage') {
      const item = run.items.find((entry) => entry.record_id === event.record_id);
      if (item) item.stage = event.stage;
      persist(run);
    }
    await onEvent(event);
  };
  persist(run);
  await emit({ type: 'run-created', run, dropped: run.dropped });

  const ctx = {
    tpl: template,
    skillDir: selected.skillDir,
    inputs: selected.inputs,
    outputs: selected.outputs,
    workdir,
    dryRun: selected.dryRun,
    trigger: selected.trigger,
    execHash: selected.execHash,
    history: selected.history,
    emit,
  };

  // 行与行之间互不影响（每行读自己的单元格、写自己的记录、产物在自己的目录里），
  // 所以可以并发：开 N 个 worker 抢同一个行号游标，跑完一行再领下一行。
  const workers = Math.max(1, Math.min(runConcurrency(), selected.rows.length));
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= selected.rows.length) return;
      const row = selected.rows[index];
      const queued = run.items[index];
      queued.status = 'running';
      queued.stage = 'validate';
      persist(run);
      await emit({ type: 'item-started', record_id: row.record_id, item: queued, run });

      const item = await runRow(ctx, row);
      run.items[index] = item;
      run.completed = run.items.filter((entry) => entry.status !== 'queued' && entry.status !== 'running').length;
      run.succeeded = run.items.filter((entry) => entry.status === 'succeeded' || entry.status === 'dry-run').length;
      run.failed = run.items.filter((entry) => entry.status === 'failed').length;
      persist(run);
      await emit({ type: 'item-finished', record_id: row.record_id, item, run });
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));

  run.status = finalStatus(run, selected.dryRun);
  run.finished_at = new Date().toISOString();
  persist(run);
  await emit({ type: 'run-finished', run });
  return { run, workdir };
}

export {
  generateRunId,
  buildArgv,
  templateProblems,
  resumePoint,
  reuseOutputs,
  normalizeOptions,
  previewTemplate,
  runTemplate,
  atomicWriteJson,
  tokenize,
  withCodexEvents,
  TERMINAL_STATUSES,
};
