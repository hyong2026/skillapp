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
import { lark } from './lark.js';
import { skillHash } from './skill-hash.js';
import { DATA_DIR, RUNS_DIR } from './paths.js';
const UPLOAD_CHUNK = 50; // 单次上传文件的个数上限
const RECORD_PAGE_SIZE = 200; // JSON 模式 record-list 的上限

const TERMINAL_STATUSES = new Set(['completed', 'partial', 'failed', 'canceled', 'interrupted']);

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

function updateRow(tpl, recordId, patch) {
  lark(['base', '+record-batch-update', ...tableFlags(tpl,
    '--json', JSON.stringify({ update_records: { [recordId]: patch } }))]);
}

/** stdout / stderr 按原样落成 .log：它是给人（和 WebUI）看的文本，不做 JSON 包装。 */
function writeStreamLog(recordDir, stream, text) {
  const logsDir = path.join(recordDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, `${stream}.log`), text || '');
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

const download = (tpl, recordId, att, dest) => lark(['base', '+record-download-attachment', ...tableFlags(tpl,
  '--record-id', recordId, '--file-token', att.file_token, '--output', dest, '--overwrite')]);

const upload = (tpl, recordId, fieldId, files) => lark(['base', '+record-upload-attachment', ...tableFlags(tpl,
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

/** 按空白切分命令，但 {} 内部的空白不算——成对参数要写成单个 token。 */
function tokenize(cmd) {
  const tokens = [];
  let depth = 0;
  let cur = '';
  for (const ch of cmd) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) tokens.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  return cur ? [...tokens, cur] : tokens;
}

/**
 * mapping.cmd 的模板语法：
 *   {key}         该值；未定义则报错 —— 必填参数
 *   {key...}      展开为数组，位置参数传多个文件
 *   {--flag key}  成对参数：值为空或该列已被删除时整对省略 —— 可选参数
 */
function buildArgv(cmd, vars) {
  const argv = [];
  for (const tok of tokenize(cmd)) {
    const paired = /^\{(\S+)\s+(\w+)\}$/.exec(tok);
    if (paired) {
      const v = resolvePath(vars, paired[2]);
      if (v !== undefined && v !== null && v !== '') argv.push(paired[1], String(v));
      continue;
    }

    const splat = /^\{(\w+)\.\.\.\}$/.exec(tok);
    if (splat) {
      const arr = resolvePath(vars, splat[1]);
      if (!Array.isArray(arr)) throw new Error(`{${splat[1]}...} in cmd is not an array`);
      argv.push(...arr);
      continue;
    }

    argv.push(tok.replace(/\{([\w.]+)\}/g, (whole, key) => {
      const v = resolvePath(vars, key);
      if (v === undefined) throw new Error(`{${key}} in cmd is undefined`);
      return String(v);
    }));
  }
  return argv;
}

/** cmd 里的内置变量，不是输入列（与 bind-table 的 checkCmd 保持一致）。 */
const BUILTIN_VARS = new Set(['outdir', 'skill']);

/** cmd 里以单独变量出现（`{key}` / `{key...}`）的输入必须有值——未映射就没法满足。 */
function requiredKeysInCmd(cmd) {
  const keys = [];
  for (const token of tokenize(cmd)) {
    const match = /^\{(\w+)(?:\.\.\.)?\}$/.exec(token);
    if (match) keys.push(match[1]);
  }
  return keys;
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

/** Skill、命令、目标与生效映射共同组成一次“工作版本”。任一变化都应让 --incremental 重跑。 */
function workHashOf(tpl, inputs, outputs) {
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify({
    skill_hash: tpl.skill.hash,
    target: tpl.target,
    cmd: tpl.mapping.cmd,
    inputs: inputs.map(withoutLiveName),
    outputs: outputs.map(withoutLiveName),
  })).digest('hex').slice(0, 16);
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
      history.set(record_id, { status, input_hash, work_hash: run.work_hash });
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
function preflight(tpl) {
  const ref = path.basename(tpl.skill.path);
  const reload = `node src/cli/load-skill.js <source-dir>`;
  const skillDir = path.join(DATA_DIR, tpl.skill.path);

  if (tpl.archived_at) {
    throw new Error(`Template is archived (frozen at ${tpl.archived_at}); unarchive it before running`);
  }
  if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
    throw new Error(`Skill is not loaded: ${tpl.skill.path}\n  Run first: ${reload}`);
  }
  const live = skillHash(skillDir);
  if (live !== tpl.skill.hash) {
    throw new Error(`Skill hash mismatch; run refused:\n  template = ${tpl.skill.hash}\n  on-disk  = ${live}\n  Reload: ${reload}`);
  }

  // 模板里只有已映射的输入；cmd 却把它当位置参数用时只能逐行报 undefined——提前说清楚。
  const mappedKeys = new Set(tpl.mapping.inputs.map((f) => f.key));
  const orphans = [...new Set(requiredKeysInCmd(tpl.mapping.cmd)
    .filter((key) => !BUILTIN_VARS.has(key) && !mappedKeys.has(key)))];
  if (orphans.length) {
    throw new Error(`Input is not mapped but cmd needs it:\n  - ${orphans.join('\n  - ')}\n  Fix: map the input, or drop its variable from cmd`);
  }

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
function prepareInputs(ctx, recordId, recordDir, cells) {
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
      vars[inp.key] = atts.map((att) => {
        const n = (seen.get(att.name) || 0) + 1;
        seen.set(att.name, n);
        const ext = path.extname(att.name);
        const name = n === 1 ? att.name : `${path.basename(att.name, ext)}-${n}${ext}`;
        const dest = path.join(dir, name);
        if (!ctx.dryRun) download(tpl, recordId, att, dest);
        return dest;
      });
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

/**
 * 按 mapping 回写该行：先解析全部输出，再提交。
 *
 * 附件类型的输出即产物——它只能靠上传文件写入，所以按类型判定，不需要额外标记。
 * 同一个解析式返回数组（一组文件）或字符串（单个文件）都可以。
 */
function writeBack(ctx, item, stdout) {
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
    const files = [].concat(evalFrom(o.from, stdout));
    item.stage = 'writeback';
    ctx.emit({ type: 'item-stage', record_id: item.record_id, stage: 'writeback' });
    updateRow(tpl, item.record_id, { [o.field_id]: null }); // 上传是追加语义，先清空
    item.stage = 'upload';
    ctx.emit({ type: 'item-stage', record_id: item.record_id, stage: 'upload' });
    for (let i = 0; i < files.length; i += UPLOAD_CHUNK) {
      upload(tpl, item.record_id, o.field_id, files.slice(i, i + UPLOAD_CHUNK));
    }
  }

  if (Object.keys(scalars).length) {
    item.stage = 'writeback';
    ctx.emit({ type: 'item-stage', record_id: item.record_id, stage: 'writeback' });
    updateRow(tpl, item.record_id, scalars);
  }
}

function spawnSkill(bin, args, options) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
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

async function runRow(ctx, row) {
  const { tpl, skillDir, workdir, dryRun } = ctx;
  const { record_id: recordId, cells } = row;
  const recordDir = path.join(workdir, recordId);
  const item = { record_id: recordId, status: 'pending', stage: 'validate', ms: null, error: null, input_hash: null };
  const fail = (error) => ({ ...item, status: 'failed', error, stage: item.stage || null });

  // 1) 先算指纹（失败行也要有，便于诊断）
  item.input_hash = fingerprintOf(ctx.inputs, cells);

  // 2) 校验输入并组装命令
  const { vars, error } = prepareInputs(ctx, recordId, recordDir, cells);
  if (error) return fail(error);

  item.stage = 'exec';
  ctx.emit({ type: 'item-stage', record_id: recordId, stage: 'exec' });
  vars.outdir = path.join(recordDir, 'artifacts');
  fs.mkdirSync(vars.outdir, { recursive: true });
  const argv = buildArgv(tpl.mapping.cmd, vars);
  if (dryRun) return { ...item, status: 'dry-run', argv };

  // 3) 执行
  const [bin, ...binArgs] = argv; // cmd 是完整命令行，首个 token 即可执行文件
  const t0 = Date.now();
  const res = await spawnSkill(bin, binArgs, {
    // cwd 不能用 Skill 目录：lark-cli 只允许把文件写到 cwd / /tmp / ~/files，
    // 而 Skill 的产物目录在 .data/runs/ 之下——cwd 必须是它的祖先，Skill 自己的
    // lark-cli 调用（例如 --output 写 ndjson）才不会被白名单拒绝。
    cwd: DATA_DIR,
    timeoutMs: (tpl.limits?.timeout_s || 60) * 1000,
    onStdout: (chunk) => ctx.emit({ type: 'item-log', record_id: recordId, stream: 'stdout', chunk }),
    onStderr: (chunk) => ctx.emit({ type: 'item-log', record_id: recordId, stream: 'stderr', chunk }),
  });
  item.ms = Date.now() - t0;
  writeStreamLog(recordDir, 'stdout', res.stdout);
  writeStreamLog(recordDir, 'stderr', res.stderr);
  if (res.timedOut) return fail(`Skill timed out after ${tpl.limits?.timeout_s || 60}s`);
  if (res.error) return fail(`Skill failed to start: ${res.error.message}`);
  if (res.status !== 0) return fail(`Skill exited with code ${res.status}: ${(res.stderr || '').trim().split('\n').pop()}`);

  // 没有输出列的 Template 不回写：这类 Skill 的结果落在别处（例如输入里给的另一张表），
  // 所以也不必解析 stdout —— 它不需要吐 JSON。
  let stdout = null;
  if (ctx.outputs.length) {
    try {
      stdout = JSON.parse(res.stdout);
    } catch {
      return fail('Skill output is not valid JSON');
    }
  }

  // 4) 回写
  try {
    writeBack(ctx, item, stdout);
  } catch (err) {
    return { ...item, status: 'failed', error: err.message };
  }
  return { ...item, status: 'succeeded', stage: null };
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

  return { ...normalized, skillDir, inputs, outputs, dropped, workHash, all, rows };
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
    skill_hash: tpl.skill.hash,
    work_hash: selected.workHash,
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
    emit,
  };

  for (let index = 0; index < selected.rows.length; index++) {
    const row = selected.rows[index];
    const queued = run.items[index];
    queued.status = 'running';
    queued.stage = 'validate';
    run.completed = index;
    persist(run);
    await emit({ type: 'item-started', record_id: row.record_id, item: queued, run });

    const item = await runRow(ctx, row);
    run.items[index] = item;
    run.completed = index + 1;
    run.succeeded = run.items.filter((entry) => entry.status === 'succeeded' || entry.status === 'dry-run').length;
    run.failed = run.items.filter((entry) => entry.status === 'failed').length;
    persist(run);
    await emit({ type: 'item-finished', record_id: row.record_id, item, run });
  }

  run.status = finalStatus(run, selected.dryRun);
  run.finished_at = new Date().toISOString();
  persist(run);
  await emit({ type: 'run-finished', run });
  return { run, workdir };
}

export {
  generateRunId,
  normalizeOptions,
  previewTemplate,
  runTemplate,
  atomicWriteJson,
  TERMINAL_STATUSES,
};
