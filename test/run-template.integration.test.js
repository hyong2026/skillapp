#!/usr/bin/env node
/**
 * run-template.js 的回归测试：真跑 CLI，只把 src/core/lark 换成内存表。
 *
 * 覆盖：
 *   - record-list 必须翻完所有页，而不是只拿默认的前 100 行
 *   - 已经读到本页 cells 后，不再逐行 record-get
 *   - --pending 必须感知 Skill / Mapping 版本变化
 *   - stdout / stderr 日志必须是 JSON 文件
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RUN_TEMPLATE = path.join(ROOT, 'src', 'cli', 'run-template.js');
const MARKER = '__RESULT__ ';

const FIELDS = [
  { id: 'fldP', name: '任务名称', type: 'text' },
  { id: 'fldIn', name: 'in: 文本', type: 'text' },
  { id: 'fldOut', name: 'out: 结果', type: 'text' },
];

function flag(args, name) {
  const i = args.indexOf(name);
  return i < 0 ? null : args[i + 1];
}

function makeFixture(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillapp-run-template-'));
  const skillDir = path.join(root, '.data', 'skills', 'ref');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(path.join(root, '.data', 'templates'), { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# stub\n');
  fs.writeFileSync(path.join(skillDir, 'entry.js'),
    'process.stdout.write(JSON.stringify({ value: "ok" }) + "\\n");\n'
    + 'process.stderr.write("warn-line\\n");\n');

  const { skillHash } = require(path.join(ROOT, 'src', 'core', 'skill-hash'));
  const template = {
    template_id: 'tpl-test',
    created_at: '2026-01-01T00:00:00+08:00',
    skill: { path: 'skills/ref', hash: skillHash(skillDir), entry: 'entry.js' },
    target: { base_token: 'bas', table_id: 'tbl', view_id: 'vew', primary_field_id: 'fldP' },
    mapping: {
      cmd: mode === 'pagination'
        ? 'node {skill.entry} {text} -o {outdir}'
        : 'node {skill.entry} -o {outdir}',
      inputs: mode === 'pagination'
        ? [{ key: 'text', field_id: 'fldIn', type: 'text', default: 'x' }]
        : [],
      outputs: [{ key: 'result', field_id: 'fldOut', type: 'text', from: 'stdout.value' }],
    },
    limits: { timeout_s: 5 },
  };
  const templatePath = path.join(root, '.data', 'templates', 'ref.json');
  fs.writeFileSync(templatePath, JSON.stringify(template, null, 2));

  if (mode === 'pending') {
    fs.mkdirSync(path.join(root, '.data', 'runs', 'old-run'), { recursive: true });
    fs.writeFileSync(path.join(root, '.data', 'runs', 'old-run', 'run.json'), JSON.stringify({
      run_id: 'old-run',
      template_id: template.template_id,
      skill_hash: 'sha256:old',
      work_hash: 'old-work',
      items: [{ record_id: 'rec1', status: 'succeeded', input_hash: '44136fa355b3678a' }],
    }, null, 2));
  }

  const rows = mode === 'pagination'
    ? Array.from({ length: 201 }, (_, i) => ({ record_id: `rec${i + 1}`, values: ['', '', ''] }))
    : [{ record_id: 'rec1', values: ['', '', ''] }];

  return { root, templatePath, rows };
}

function runWorker(mode) {
  const { root, templatePath, rows } = makeFixture(mode);
  process.env.SKILLAPP_ROOT = root;
  process.env.SKILLAPP_DATA_DIR = path.join(root, '.data');
  const table = { rows, listCalls: [], getCalls: 0 };

  const fakeLark = (args) => {
    const cmd = args[1];
    if (cmd === '+field-list') return { ok: true, data: { fields: FIELDS } };
    if (cmd === '+record-list') {
      const limit = Number(flag(args, '--limit') ?? 100);
      const offset = Number(flag(args, '--offset') ?? 0);
      const projection = args.flatMap((arg, i) => (arg === '--field-id' ? [args[i + 1]] : []));
      table.listCalls.push({ limit, offset, projection });
      return {
        ok: true,
        data: {
          field_id_list: FIELDS.map((f) => f.id),
          record_id_list: rows.slice(offset, offset + limit).map((r) => r.record_id),
          data: rows.slice(offset, offset + limit).map((r) => r.values),
        },
      };
    }
    if (cmd === '+record-get') {
      table.getCalls += 1;
      const row = rows.find((r) => r.record_id === flag(args, '--record-id'));
      return { ok: true, data: { field_id_list: FIELDS.map((f) => f.id), data: [row.values] } };
    }
    if (cmd === '+record-batch-update') return { ok: true, data: {} };
    throw new Error(`未打桩的 lark 调用: ${args.join(' ')}`);
  };

  const larkPath = require.resolve(path.join(ROOT, 'src', 'core', 'lark.js'));
  require.cache[larkPath] = {
    id: larkPath,
    filename: larkPath,
    loaded: true,
    exports: { ROOT: root, lark: fakeLark },
  };

  const stdout = [];
  const errors = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args) => stdout.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));

  class ExitCalled extends Error {}
  const realExit = process.exit;
  process.exit = (code) => { const e = new ExitCalled(`process.exit(${code})`); e.code = code; throw e; };
  process.argv = ['node', RUN_TEMPLATE, templatePath];
  if (mode !== 'logs') process.argv.push('--dry-run');
  if (mode === 'pending') process.argv.push('--pending');

  let exitCode = null;
  let harnessError = null;
  try {
    require(RUN_TEMPLATE);
  } catch (err) {
    if (err instanceof ExitCalled) exitCode = err.code;
    else harnessError = err.stack || String(err);
  }

  process.exit = realExit;
  console.log = realLog;
  console.error = realError;

  let logs = null;
  let logReadError = null;
  if (mode === 'logs') {
    try {
      const runDir = path.join(root, '.data', 'runs', fs.readdirSync(path.join(root, '.data', 'runs'))[0]);
      const recordDir = path.join(runDir, 'rec1');
      logs = {
        recordFiles: fs.readdirSync(recordDir).sort(),
        logFiles: fs.readdirSync(path.join(recordDir, 'logs')).sort(),
        stdout: JSON.parse(fs.readFileSync(path.join(recordDir, 'logs', 'stdout.json'), 'utf8')),
        stderr: JSON.parse(fs.readFileSync(path.join(recordDir, 'logs', 'stderr.json'), 'utf8')),
      };
    } catch (err) {
      logReadError = err.message;
    }
  }

  process.stdout.write(MARKER + JSON.stringify({
    mode,
    exitCode,
    harnessError,
    errors,
    listCalls: table.listCalls,
    getCalls: table.getCalls,
    dryRows: stdout.filter((l) => l.includes('→ rec')).length,
    noRows: stdout.some((l) => l.includes('没有符合条件的行')),
    logs,
    logReadError,
  }) + '\n');
}

if (process.argv.includes('--worker')) {
  runWorker(flag(process.argv, '--mode'));
} else {
  const { test } = require('node:test');
  const assert = require('node:assert');

  function scenario(mode) {
    const r = spawnSync(process.execPath, [__filename, '--worker', '--mode', mode], {
      encoding: 'utf8',
      timeout: 120000,
    });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith(MARKER));
    assert.ok(line, `worker 没有给出结果（exit=${r.status}）:\n${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(line.slice(MARKER.length));
    assert.equal(out.harnessError, null, `worker 自己抛了异常:\n${out.harnessError}`);
    return out;
  }

  test('record-list 会翻完所有页，且不再逐行 record-get', () => {
    const out = scenario('pagination');
    assert.equal(out.exitCode, null);
    assert.equal(out.dryRows, 201);
    assert.equal(out.getCalls, 0, '已经拿到列表 cells，不应再逐行 record-get');
    assert.deepEqual(out.listCalls.map((c) => [c.limit, c.offset]), [[200, 0], [200, 200]]);
    assert.deepEqual(out.listCalls[0].projection, ['fldIn']);
  });

  test('--pending 会因 Skill / Mapping 版本变化而重跑', () => {
    const out = scenario('pending');
    assert.equal(out.exitCode, null);
    assert.equal(out.noRows, false);
    assert.equal(out.dryRows, 1);
    assert.equal(out.getCalls, 0);
  });

  test('stdout / stderr 日志写成 JSON 文件', () => {
    const out = scenario('logs');
    assert.equal(out.exitCode, null);
    assert.equal(out.logReadError, null);
    assert.deepEqual(out.logs.recordFiles, ['artifacts', 'logs']);
    assert.deepEqual(out.logs.logFiles, ['stderr.json', 'stdout.json']);
    assert.deepEqual(out.logs.stdout, {
      record_id: 'rec1',
      stream: 'stdout',
      data: { value: 'ok' },
    });
    assert.deepEqual(out.logs.stderr, {
      record_id: 'rec1',
      stream: 'stderr',
      data: { raw: 'warn-line\n' },
    });
  });
}
