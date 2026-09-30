#!/usr/bin/env node
/**
 * run-template.js — 执行 Template：逐行读 Base → 跑 skill → 回写结果
 *
 * 边界：Base 只承担 IO（读输入 / 写输出），不写任何状态。
 *       Run = runs/<run_id>/run.json，RunItem = runs/<run_id>/items.ndjson。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { skillHash } = require('./skill-hash');

const ROOT = path.join(__dirname, '..');
const RUNS_DIR = path.join(ROOT, 'runs');

const USAGE = `用法: node bin/run-template.js <template.json> [选项]

选项:
  --all               处理表内所有行（默认）
  --pending           只处理在 runs/ 历史中没有成功记录、或输入已变的行
  --record-id <id>    只处理指定行，可重复传
  --dry-run           只核对，不执行、不回写、不产生 Run 记录
  -h, --help          显示本帮助`;

// ─── 参数 ─────────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const out = { template: null, recordIds: [], dryRun: false, all: false, pending: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--all') out.all = true;
    else if (a === '--pending') out.pending = true;
    else if (a === '--record-id') out.recordIds.push(argv[++i]);
    else if (a === '-h' || a === '--help') out.help = true;
    else if (!out.template) out.template = a;
  }
  return out;
}

// ─── lark-cli ─────────────────────────────────────────────────────────────

function lark(args) {
  const r = spawnSync('lark-cli', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`lark-cli ${args.slice(0, 3).join(' ')} 失败: ${(r.stderr || r.stdout).trim()}`);
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    throw new Error(`lark-cli 返回非 JSON: ${r.stdout.slice(0, 300)}`);
  }
  if (out.ok === false) throw new Error(`lark-cli 报错: ${JSON.stringify(out).slice(0, 300)}`);
  return out;
}

/** base + 身份 + 表的公共参数 */
const baseFlags = (tpl, ...rest) => ['--base-token', tpl.target.base_token, '--as', 'user', ...rest];

function updateRow(tpl, recordId, patch) {
  lark(['base', '+record-batch-update', ...baseFlags(tpl,
    '--table-id', tpl.target.table_id,
    '--json', JSON.stringify({ update_records: { [recordId]: patch } }))]);
}

/** 单行的 field_id → 单元格值 */
function cellsOf(tpl, recordId) {
  const d = lark(['base', '+record-get', ...baseFlags(tpl,
    '--table-id', tpl.target.table_id, '--record-id', recordId, '--format', 'json')]).data;
  return Object.fromEntries(d.field_id_list.map((fid, i) => [fid, d.data[0][i]]));
}

function listRows(tpl) {
  const d = lark(['base', '+record-list', ...baseFlags(tpl,
    '--table-id', tpl.target.table_id, '--format', 'json')]).data;
  return d.record_id_list.map((rid, i) => ({
    record_id: rid,
    row: Object.fromEntries(d.field_id_list.map((fid, j) => [fid, d.data[i][j]])),
  }));
}

// ─── 表达式与指纹 ─────────────────────────────────────────────────────────

function resolvePath(root, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), root);
}

/** 支持 "stdout.a.b" 与 "stdout.fileSize / 1024" */
function evalFrom(expr, stdout) {
  const m = /^([A-Za-z_][\w.]*)(?:\s*\/\s*([\d.]+))?$/.exec(expr.trim());
  if (!m) throw new Error(`不支持的表达式: ${expr}`);
  const v = resolvePath({ stdout }, m[1]);
  if (v === undefined || v === null) throw new Error(`表达式 ${expr} 解析为空`);
  return m[2] ? v / parseFloat(m[2]) : v;
}

/** 把 invocation.cmd 求值成 argv。`{key...}` 展开为数组（位置参数传多个文件）。 */
function buildArgv(cmd, vars) {
  const argv = [];
  for (const tok of cmd.split(/\s+/)) {
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

/** 输入指纹：覆盖全部输入单元格。附件计入 file_token，故换图即失效。 */
function fingerprint(values) {
  const stable = Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 16);
}

const fingerprintOfRow = (tpl, row) => fingerprint(
  Object.fromEntries(tpl.mapping.inputs.map((i) => [i.field_id, row[i.field_id]]))
);

// ─── 运行历史（runs/ 即状态层）────────────────────────────────────────────

function loadHistory() {
  const history = new Map();
  if (!fs.existsSync(RUNS_DIR)) return history;
  for (const runId of fs.readdirSync(RUNS_DIR).sort()) {
    const file = path.join(RUNS_DIR, runId, 'items.ndjson');
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const { record_id, status, input_hash } = JSON.parse(line);
      if (!history.has(record_id)) history.set(record_id, []);
      history.get(record_id).push({ status, input_hash });
    }
  }
  return history;
}

const alreadySucceeded = (history, recordId, inputHash) =>
  (history.get(recordId) || []).some((e) => e.input_hash === inputHash && e.status === 'succeeded');

// ─── 运行前核对：不通过就拒绝运行 ─────────────────────────────────────────

function preflight(tpl) {
  const reimport = `node bin/skill-import.js <源目录> --ref ${tpl.skill.ref}`;

  const dir = path.join(ROOT, 'skills', tpl.skill.ref);
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) {
    throw new Error(`skill 未导入: ${tpl.skill.ref}\n  先执行: ${reimport}`);
  }
  const live = skillHash(dir);
  if (live !== tpl.skill.hash) {
    throw new Error(`skill 内容指纹不符，拒绝运行:\n  template = ${tpl.skill.hash}\n  on-disk  = ${live}\n  重新导入: ${reimport}`);
  }

  if (tpl.mapping.invocation.parse && tpl.mapping.invocation.parse !== 'json_stdout') {
    throw new Error(`暂不支持的 invocation.parse: ${tpl.mapping.invocation.parse}`);
  }

  const fields = lark(['base', '+field-list', ...baseFlags(tpl, '--table-id', tpl.target.table_id)]).data.fields;
  const byId = new Map(fields.map((f) => [f.id, f]));
  const problems = [];
  for (const f of [...tpl.mapping.inputs, ...tpl.mapping.outputs]) {
    const actual = byId.get(f.field_id);
    if (!actual) problems.push(`字段不存在: ${f.field_name} (${f.field_id})`);
    else if (actual.type !== f.type) problems.push(`类型不符: ${f.field_name} 模板=${f.type} Base=${actual.type}`);
  }
  if (!byId.has(tpl.target.primary_field_id)) problems.push(`主字段不存在: ${tpl.target.primary_field_id}`);
  if (problems.length) throw new Error(`Template 与 Base 不一致，拒绝运行:\n  - ${problems.join('\n  - ')}`);

  return dir;
}

// ─── 单行执行 ─────────────────────────────────────────────────────────────

function runRow(ctx, recordId) {
  const { tpl, skillDir, workdir, dryRun } = ctx;
  const item = { record_id: recordId, status: 'pending', stage: 'validate', ms: null, error: null, input_hash: null, outputs: {} };
  const fail = (error) => { item.status = 'failed'; item.error = error; return item; };

  // 1) 一次性读全输入并算指纹（失败行也要有，便于诊断）
  const rawInputs = Object.fromEntries(
    tpl.mapping.inputs.map((i) => [i.field_id, cellsOf(tpl, recordId)[i.field_id]])
  );
  item.input_hash = fingerprint(rawInputs);

  // 2) 逐项校验，并把输入转成 cmd 变量
  const vars = { skill: tpl.skill, workdir };
  for (const inp of tpl.mapping.inputs) {
    const value = rawInputs[inp.field_id];

    if (inp.type === 'attachment') {
      const files = Array.isArray(value) ? value : [];
      const min = inp.validate?.min_count ?? 0;
      if (files.length < min) return fail(`${inp.field_name} 至少需要 ${min} 个文件，实际 ${files.length} 个`);
      const dir = path.join(workdir, 'downloads', recordId); // 每行独立目录，避免同名附件互相覆盖
      fs.mkdirSync(dir, { recursive: true });
      vars[inp.key] = files.map((att, i) => {
        const dest = path.join(dir, `${i}-${att.name}`);
        lark(['base', '+record-download-attachment', ...baseFlags(tpl,
          '--table-id', tpl.target.table_id, '--record-id', recordId,
          '--file-token', att.file_token, '--output', dest, '--overwrite')]);
        return dest;
      });
      continue;
    }

    let v = Array.isArray(value) ? value[0] : value;
    if (v === null || v === undefined || v === '') v = inp.default;
    const allowed = inp.validate?.enum;
    if (allowed && !allowed.includes(v)) {
      return fail(`${inp.field_name} 取值 ${JSON.stringify(v)} 不在 ${JSON.stringify(allowed)} 内`);
    }
    if (inp.transform && inp.transform[v] !== undefined) v = inp.transform[v];
    vars[inp.key] = v;
  }

  // 3) 组装命令
  item.stage = 'exec';
  vars.outdir = path.join(workdir, 'artifacts', recordId); // 每行一个产物目录
  fs.mkdirSync(vars.outdir, { recursive: true });
  const argv = buildArgv(tpl.mapping.invocation.cmd, vars);

  if (dryRun) return { ...item, status: 'dry-run', argv };

  // 4) 执行
  const [bin, ...binArgs] = argv; // cmd 是完整命令行，首个 token 即可执行文件
  const t0 = Date.now();
  const res = spawnSync(bin, binArgs, {
    cwd: skillDir,
    timeout: (tpl.executor.timeout_s || 60) * 1000,
    encoding: 'utf8',
  });
  item.ms = Date.now() - t0;
  fs.writeFileSync(path.join(workdir, `${recordId}.stdout.log`), res.stdout || '');
  fs.writeFileSync(path.join(workdir, `${recordId}.stderr.log`), res.stderr || '');
  if (res.status !== 0) {
    return fail(`skill 退出码 ${res.status}: ${(res.stderr || '').trim().split('\n').pop()}`);
  }

  let stdout;
  try {
    stdout = JSON.parse(res.stdout);
  } catch {
    return fail('skill 输出不是合法 JSON');
  }

  // 5) 按 mapping 解析输出
  const artifact = tpl.mapping.outputs.find((o) => o.write === 'upload_attachment_then_link_token');
  const numbers = {};
  for (const o of tpl.mapping.outputs) {
    if (o === artifact) continue;
    let v = evalFrom(o.from, stdout);
    if (o.round !== undefined) v = Number(v.toFixed(o.round));
    numbers[o.field_id] = v;
  }
  const artifactPath = artifact ? evalFrom(artifact.from, stdout) : null;
  item.outputs = { ...numbers, ...(artifact ? { [artifact.field_id]: artifactPath } : {}) };

  // 6) 回写：先清空附件格（上传是追加语义），再上传，最后写标量
  if (artifact) {
    item.stage = 'writeback';
    updateRow(tpl, recordId, { [artifact.field_id]: null });
    item.stage = 'upload';
    lark(['base', '+record-upload-attachment', ...baseFlags(tpl,
      '--table-id', tpl.target.table_id, '--record-id', recordId,
      '--field-id', artifact.field_id, '--file', artifactPath)]);
    item.stage = 'writeback';
  }
  if (Object.keys(numbers).length) updateRow(tpl, recordId, numbers);

  item.status = 'succeeded';
  item.stage = null;
  return item;
}

// ─── main ─────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args.help || !args.template) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 1);
  }

  const tpl = JSON.parse(fs.readFileSync(args.template, 'utf8'));
  const skillDir = preflight(tpl);

  const all = listRows(tpl);
  const history = loadHistory();

  let rows = all;
  let trigger = 'all';
  if (args.recordIds.length) {
    rows = all.filter((r) => args.recordIds.includes(r.record_id));
    trigger = 'record-id';
  } else if (args.pending) {
    rows = all.filter((r) => !alreadySucceeded(history, r.record_id, fingerprintOfRow(tpl, r.row)));
    trigger = 'pending';
  }

  if (!rows.length) {
    console.log('没有符合条件的行');
    return;
  }

  // 批量闸门：误点一次不该炸掉一整张表
  const cap = tpl.limits?.max_rows_per_run;
  if (cap && rows.length > cap) {
    throw new Error(`选中 ${rows.length} 行，超过 Template 上限 ${cap}；请分批或用 --record-id 指定`);
  }

  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const runId = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
    + `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
    + `-${Math.random().toString(16).slice(2, 6)}`;

  // dry-run 不产生 Run 记录，因此不进 runs/，免得污染历史
  const workdir = args.dryRun
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'skillapp-dry-'))
    : path.join(RUNS_DIR, runId);
  fs.mkdirSync(workdir, { recursive: true });

  const ctx = { tpl, skillDir, workdir, dryRun: args.dryRun };
  console.log(`Run ${runId}  ${tpl.template_id} v${tpl.version}  trigger=${trigger}  rows=${rows.length}`);
  if (args.dryRun) console.log('  [dry-run] 只核对，不执行、不回写');

  const startedAt = Date.now();
  const items = rows.map(({ record_id }) => {
    const item = runRow(ctx, record_id);
    if (item.status === 'dry-run') {
      console.log(`  → ${record_id}  argv: ${JSON.stringify(item.argv)}`);
    } else {
      const flag = item.status === 'succeeded' ? '✅' : '❌';
      console.log(`  ${flag} ${record_id}  ${item.stage || 'done'}  ${item.ms ?? '-'}ms  ${item.error || ''}`);
    }
    return item;
  });

  if (args.dryRun) return;

  const succeeded = items.filter((i) => i.status === 'succeeded').length;
  const failed = items.length - succeeded;

  // Run = run.json；RunItem = items.ndjson。状态层就在这儿，不在 Base。
  fs.writeFileSync(path.join(workdir, 'run.json'), JSON.stringify({
    run_id: runId,
    template_id: tpl.template_id,
    template_version: tpl.version,
    skill_version: tpl.skill.hash,
    trigger,
    status: failed === 0 ? 'completed' : succeeded === 0 ? 'failed' : 'partial',
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date().toISOString(),
    total: items.length,
    succeeded,
    failed,
    items,
  }, null, 2));
  fs.writeFileSync(path.join(workdir, 'items.ndjson'), items.map((i) => JSON.stringify(i)).join('\n') + '\n');

  console.log(`\n完成: ${succeeded} 成功 / ${failed} 失败`);
  console.log(`记录: runs/${runId}/run.json`);
}

try {
  main();
} catch (err) {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
}