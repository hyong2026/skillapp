#!/usr/bin/env node
/**
 * run-template.js — 按 Template 执行：逐行读多维表格 → 跑 Skill → 回写结果
 *
 *   node bin/run-template.js <template.json> [--all | --pending | --record-id <id> ...] [--dry-run]
 *
 * 边界：多维表格只承担 IO（读输入 / 写输出），不写任何状态。
 *       Run 与其中的 RunItem 都记在 runs/<run_id>/run.json。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { ROOT, lark } = require('../lib/lark');
const { skillHash } = require('../lib/skill-hash');

const RUNS_DIR = path.join(ROOT, 'runs');
const UPLOAD_CHUNK = 50; // 单次上传文件的个数上限
const RECORD_PAGE_SIZE = 200; // JSON 模式 record-list 的上限

const USAGE = `用法: node bin/run-template.js <template.json> [选项]

选项:
  --all               处理表内所有行（默认）
  --pending           只处理工作版本或输入变化的行
  --record-id <id>    只处理指定行，可重复传
  --dry-run           只核对，不执行、不回写、不产生 Run 记录
  -h, --help          显示本帮助`;

// ─── 参数 ─────────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const out = { template: null, recordIds: [], dryRun: false, pending: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--pending') out.pending = true;
    else if (a === '--record-id') out.recordIds.push(argv[++i]);
    else if (a === '-h' || a === '--help') out.help = true;
    else if (!out.template) out.template = a;
  }
  return out;
}

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

function jsonData(text) {
  const raw = text || '';
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : { value: parsed };
  } catch {
    return { raw };
  }
}

function writeStreamLog(recordDir, recordId, stream, text) {
  const logsDir = path.join(recordDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, `${stream}.json`), JSON.stringify({
    record_id: recordId,
    stream,
    data: jsonData(text),
  }, null, 2) + '\n');
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
  if (!m) throw new Error(`不支持的表达式（须以 stdout. 开头）: ${expr}`);

  const plucked = m[1].includes('[]');
  let out = walk(stdout, m[1].split('.'));
  if (!plucked) out = out[0];
  if (out == null || out.length === 0) throw new Error(`表达式 ${expr} 解析为空`);

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
      if (!Array.isArray(arr)) throw new Error(`cmd 中的 {${splat[1]}...} 不是数组`);
      argv.push(...arr);
      continue;
    }

    argv.push(tok.replace(/\{([\w.]+)\}/g, (whole, key) => {
      const v = resolvePath(vars, key);
      if (v === undefined) throw new Error(`cmd 中的 {${key}} 未定义`);
      return String(v);
    }));
  }
  return argv;
}

// ─── 输入指纹与运行历史 ───────────────────────────────────────────────────

/** 覆盖全部输入单元格。附件计入 file_token，故换图即失效。 */
function fingerprint(cells) {
  const stable = Object.fromEntries(Object.entries(cells).sort(([a], [b]) => a.localeCompare(b)));
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 16);
}

const fingerprintOf = (inputs, cells) =>
  fingerprint(Object.fromEntries(inputs.map((i) => [i.field_id, cells[i.field_id]])));

const withoutLiveName = ({ field_name, ...field }) => field;

/** Skill、命令、目标与生效映射共同组成一次“工作版本”。任一变化都应让 --pending 重跑。 */
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
  const reload = `node bin/load-skill.js <源目录> --ref ${ref}`;
  const skillDir = path.join(ROOT, tpl.skill.path);

  if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
    throw new Error(`Skill 未装载: ${tpl.skill.path}\n  先执行: ${reload}`);
  }
  const live = skillHash(skillDir);
  if (live !== tpl.skill.hash) {
    throw new Error(`Skill 内容指纹不符，拒绝运行:\n  template = ${tpl.skill.hash}\n  on-disk  = ${live}\n  重新装载: ${reload}`);
  }

  const fields = lark(['base', '+field-list', ...tableFlags(tpl)]).data.fields;
  const byId = new Map(fields.map((f) => [f.id, f]));
  const problems = [];

  // 列名以活表为准——模板里不重复存。已删除的列取不到名字，退回 field_id。
  const named = (f) => ({ ...f, field_name: byId.get(f.field_id)?.name ?? f.field_id });

  const stillThere = (f) => {
    const actual = byId.get(f.field_id);
    if (!actual) return false;
    if (actual.type !== f.type) problems.push(`类型不符: ${actual.name} 模板=${f.type} 表格=${actual.type}`);
    return true;
  };

  const inputs = tpl.mapping.inputs.filter(stillThere).map(named);
  const outputs = tpl.mapping.outputs.filter(stillThere).map(named);

  for (const f of tpl.mapping.inputs) {
    if (f.required && !byId.has(f.field_id)) problems.push(`必填输入已被删除: ${named(f).field_name} (${f.field_id})`);
  }
  if (!byId.has(tpl.target.primary_field_id)) problems.push(`主字段不存在: ${tpl.target.primary_field_id}`);
  if (!outputs.length) problems.push('没有任何输出列可用于回写');
  if (problems.length) throw new Error(`Template 与当前表格不一致，拒绝运行:\n  - ${problems.join('\n  - ')}`);

  const dropped = [...tpl.mapping.inputs, ...tpl.mapping.outputs]
    .filter((f) => !byId.has(f.field_id))
    .map(named);
  return { skillDir, inputs, outputs, dropped };
}

// ─── 单行执行 ─────────────────────────────────────────────────────────────

/** 校验输入、下载附件、组装命令。返回 cmd 变量；校验不过则返回错误信息。 */
function prepareInputs(ctx, recordId, recordDir, cells) {
  const { tpl } = ctx;
  const vars = { skill: tpl.skill };

  for (const inp of ctx.inputs) {
    const value = cells[inp.field_id];
    const rule = inp.validate || {};

    if (inp.type === 'attachment') {
      const atts = Array.isArray(value) ? value : [];
      if (rule.count !== undefined && atts.length !== rule.count) {
        return { error: `${inp.field_name} 需要恰好 ${rule.count} 个文件，实际 ${atts.length} 个` };
      }
      const min = rule.min_count ?? (inp.required ? 1 : 0);
      if (atts.length < min) return { error: `${inp.field_name} 至少需要 ${min} 个文件，实际 ${atts.length} 个` };
      if (rule.max_count !== undefined && atts.length > rule.max_count) {
        return { error: `${inp.field_name} 最多 ${rule.max_count} 个文件，实际 ${atts.length} 个` };
      }
      // 每行独立目录，避免同名附件互相覆盖；同名时才加后缀，保留原文件名
      const dir = path.join(recordDir, 'downloads');
      fs.mkdirSync(dir, { recursive: true });
      const seen = new Map();
      vars[inp.key] = atts.map((att) => {
        const n = (seen.get(att.name) || 0) + 1;
        seen.set(att.name, n);
        const ext = path.extname(att.name);
        const name = n === 1 ? att.name : `${path.basename(att.name, ext)}-${n}${ext}`;
        const dest = path.join(dir, name);
        download(tpl, recordId, att, dest);
        return dest;
      });
      continue;
    }

    let v = Array.isArray(value) ? value[0] : value;
    if (v === null || v === undefined || v === '') {
      if (inp.required && inp.default === undefined) return { error: `${inp.field_name} 必填` };
      v = inp.default;
    }
    if (rule.enum && !rule.enum.includes(v)) {
      return { error: `${inp.field_name} 取值 ${JSON.stringify(v)} 不在 ${JSON.stringify(rule.enum)} 内` };
    }
    if (rule.min !== undefined && v < rule.min) return { error: `${inp.field_name} 不能小于 ${rule.min}，实际 ${v}` };
    if (rule.max !== undefined && v > rule.max) return { error: `${inp.field_name} 不能大于 ${rule.max}，实际 ${v}` };
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
    updateRow(tpl, item.record_id, { [o.field_id]: null }); // 上传是追加语义，先清空
    item.stage = 'upload';
    for (let i = 0; i < files.length; i += UPLOAD_CHUNK) {
      upload(tpl, item.record_id, o.field_id, files.slice(i, i + UPLOAD_CHUNK));
    }
  }

  if (Object.keys(scalars).length) {
    item.stage = 'writeback';
    updateRow(tpl, item.record_id, scalars);
  }
}

function runRow(ctx, row) {
  const { tpl, skillDir, workdir, dryRun } = ctx;
  const { record_id: recordId, cells } = row;
  const recordDir = path.join(workdir, recordId);
  const item = { record_id: recordId, status: 'pending', stage: 'validate', ms: null, error: null, input_hash: null };
  const fail = (error) => ({ ...item, status: 'failed', error });

  // 1) 先算指纹（失败行也要有，便于诊断）
  item.input_hash = fingerprintOf(ctx.inputs, cells);

  // 2) 校验输入并组装命令
  const { vars, error } = prepareInputs(ctx, recordId, recordDir, cells);
  if (error) return fail(error);

  item.stage = 'exec';
  vars.outdir = path.join(recordDir, 'artifacts');
  fs.mkdirSync(vars.outdir, { recursive: true });
  const argv = buildArgv(tpl.mapping.cmd, vars);
  if (dryRun) return { ...item, status: 'dry-run', argv };

  // 3) 执行
  const [bin, ...binArgs] = argv; // cmd 是完整命令行，首个 token 即可执行文件
  const t0 = Date.now();
  const res = spawnSync(bin, binArgs, { cwd: skillDir, timeout: (tpl.limits?.timeout_s || 60) * 1000, encoding: 'utf8' });
  item.ms = Date.now() - t0;
  writeStreamLog(recordDir, recordId, 'stdout', res.stdout);
  writeStreamLog(recordDir, recordId, 'stderr', res.stderr);
  if (res.status !== 0) return fail(`Skill 退出码 ${res.status}: ${(res.stderr || '').trim().split('\n').pop()}`);

  let stdout;
  try {
    stdout = JSON.parse(res.stdout);
  } catch {
    return fail('Skill 输出不是合法 JSON');
  }

  // 4) 回写
  try {
    writeBack(ctx, item, stdout);
  } catch (err) {
    return { ...item, status: 'failed', error: err.message };
  }
  return { ...item, status: 'succeeded', stage: null };
}

// ─── main ─────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args.help || !args.template) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 1);
  }

  const tpl = JSON.parse(fs.readFileSync(args.template, 'utf8'));
  const { skillDir, inputs, outputs, dropped } = preflight(tpl);
  const workHash = workHashOf(tpl, inputs, outputs);

  const all = readRows(tpl, inputs.map((i) => i.field_id));
  const history = loadHistory(tpl.template_id);

  let rows = all;
  let trigger = 'all';
  if (args.recordIds.length) {
    rows = all.filter((r) => args.recordIds.includes(r.record_id));
    trigger = 'record-id';
  } else if (args.pending) {
    // 指纹只覆盖实际生效的输入——删掉某个输入列即意味着输入变了，相关行会重跑一次
    rows = all.filter((r) => !upToDate(history, r.record_id, fingerprintOf(inputs, r.cells), workHash));
    trigger = 'pending';
  }
  if (!rows.length) {
    console.log('没有符合条件的行');
    return;
  }

  const cap = tpl.limits?.max_rows_per_run;
  if (cap && rows.length > cap) {
    throw new Error(`选中 ${rows.length} 行，超过 Template 上限 ${cap}；请分批或用 --record-id 指定`);
  }

  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const runId = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
    + `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
    + `-${Math.random().toString(16).slice(2, 6)}`;

  // dry-run 不产生 Run 记录，因此不进 runs/，免得污染历史。
  // 用 /tmp 而非 os.tmpdir()：后者在 macOS 指向 /var/folders，不在 lark-cli 的白名单内。
  const workdir = args.dryRun ? fs.mkdtempSync('/tmp/skillapp-dry-') : path.join(RUNS_DIR, runId);
  fs.mkdirSync(workdir, { recursive: true });

  console.log(`Run ${runId}  ${tpl.template_id.slice(0, 8)}  trigger=${trigger}  rows=${rows.length}`);
  if (dropped.length) console.log(`  [跳过 ${dropped.length} 个不在表格里的列] ${dropped.map((f) => f.field_name).join('、')}`);
  if (args.dryRun) console.log('  [dry-run] 只核对，不执行、不回写');

  const ctx = { tpl, skillDir, inputs, outputs, workdir, dryRun: args.dryRun };
  const startedAt = Date.now();
  const items = rows.map((row) => {
    const item = runRow(ctx, row);
    const recordId = row.record_id;
    if (item.status === 'dry-run') console.log(`  → ${recordId}  argv: ${JSON.stringify(item.argv)}`);
    else {
      const flag = item.status === 'succeeded' ? '✅' : '❌';
      console.log(`  ${flag} ${recordId}  ${item.stage || 'done'}  ${item.ms ?? '-'}ms  ${item.error || ''}`);
    }
    return item;
  });

  if (args.dryRun) return;

  const succeeded = items.filter((i) => i.status === 'succeeded').length;
  const failed = items.length - succeeded;

  // 一个 Run 一个文件：状态层就在这儿，不在表格里
  fs.writeFileSync(path.join(workdir, 'run.json'), JSON.stringify({
    run_id: runId,
    template_id: tpl.template_id,
    skill_hash: tpl.skill.hash,
    work_hash: workHash,
    trigger,
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date().toISOString(),
    status: failed === 0 ? 'completed' : succeeded === 0 ? 'failed' : 'partial',
    succeeded,
    failed,
    items,
  }, null, 2) + '\n');

  console.log(`\n完成: ${succeeded} 成功 / ${failed} 失败`);
  console.log(`记录: runs/${runId}/run.json`);
}

try {
  main();
} catch (err) {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
}
