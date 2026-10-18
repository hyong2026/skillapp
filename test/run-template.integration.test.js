#!/usr/bin/env node
/**
 * run-template.js 的回归测试：真跑 CLI，只把 src/core/lark 换成内存表。
 *
 * 覆盖：
 *   - record-list 必须翻完所有页，而不是只拿默认的前 100 行
 *   - 已经读到本页 cells 后，不再逐行 record-get
 *   - --incremental 必须感知 Skill / Mapping 版本变化
 *   - 飞书文本列里的 Markdown 链接会归一成裸 URL
 *   - stdout / stderr 原样落成 .log 文本
 *   - 未映射（mapped: false）的条目不进 Template：不读取、不回写；被 cmd 当位置参数用时提前报错
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { skillHash } from '../src/core/skill-hash.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const RUN_TEMPLATE = path.join(ROOT, 'src', 'cli', 'run-template.js');
const MARKER = '__RESULT__ ';

const FIELDS = [
  { id: 'fldP', name: '任务名称', type: 'text' },
  { id: 'fldIn', name: 'in: 文本', type: 'text' },
  { id: 'fldOut', name: 'out: 结果', type: 'text' },
];
/** 未映射场景要有一列「表里有、但不参与」的列，才能证明它真的没被读写 */

/** 飞书文本列里的链接长这样：`[标题](URL)` */
const LINK_CELL = '[外包负责需求单](https://stub.feishu.cn/wiki/Tok?table=t&view=v)';

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
  fs.writeFileSync(path.join(skillDir, 'entry.js'), mode === 'no-writeback'
    // 结果落在别处（例如输入里给的表格）的 Skill：不吐 JSON、也没有输出列
    ? 'process.stdout.write("done — the result is in the linked sheet\\n");\n'
    // 并发场景：把「开始 / 结束」按行记进同一份时间线，用来判断两行是否重叠
    : mode === 'concurrent'
      ? `const fs = require('fs');\n`
        + `const outdir = process.argv[process.argv.indexOf('-o') + 1];\n`
        + `const record = outdir.split('/').slice(-2)[0];\n`
        + `fs.appendFileSync(${JSON.stringify(path.join(root, 'timeline.log'))}, record + ' start ' + Date.now() + '\\n');\n`
        + `setTimeout(() => {\n`
        + `  fs.appendFileSync(${JSON.stringify(path.join(root, 'timeline.log'))}, record + ' end ' + Date.now() + '\\n');\n`
        + `  process.stdout.write(JSON.stringify({ value: 'ok' }) + '\\n');\n`
        + `}, 300);\n`
    // 报告自己看到的 cwd：用来钉住「Skill 子进程的 cwd = 内容层根」
    : mode === 'cwd'
      ? 'process.stdout.write(JSON.stringify({ value: process.cwd() }) + "\\n");\n'
    // 长跑场景：先打一行、停一会儿再打结果 —— 用来验证 stdout 是"边跑边落盘"
    : mode === 'streaming'
      ? 'process.stdout.write("first-line\\n");\n'
        + 'setTimeout(() => { process.stdout.write(JSON.stringify({ value: "ok" }) + "\\n"); }, 1200);\n'
    : 'process.stdout.write(JSON.stringify({ value: "ok" }) + "\\n");\n'
      + 'process.stderr.write("warn-line\\n");\n');

  const template = {
    template_id: 'tpl-test',
    created_at: '2026-01-01T00:00:00+08:00',
    ...(mode === 'archived' ? { archived_at: '2026-01-01T00:00:00+08:00' } : {}),
    skill: { path: 'skills/ref', hash: skillHash(skillDir), entry: 'entry.js' },
    target: { base_token: 'bas', table_id: 'tbl', view_id: 'vew', primary_field_id: 'fldP' },
    mapping: {
      cmd: mode === 'pagination'
        ? 'node {skill.entry} {text} -o {outdir}'
        : mode === 'link-cell'
          ? 'node {skill.entry} {target_url} -o {outdir}'
          : mode === 'unmapped-cmd'
            ? 'node {skill.entry} {text} -o {outdir}'
            : 'node {skill.entry} -o {outdir}',
      // 未映射（mapped: false）的条目根本不进 Template：`unmapped-*` 只是少一条映射项。
      inputs: mode === 'pagination'
        ? [{ key: 'text', field_id: 'fldIn', type: 'text', default: 'x' }]
        : mode === 'link-cell'
          ? [{ key: 'target_url', field_id: 'fldIn', type: 'text', required: true }]
          : [],
      outputs: mode === 'no-writeback'
        ? []
        : [{ key: 'result', field_id: 'fldOut', type: 'text', from: 'stdout.value' }],
    },
    limits: { timeout_s: 5 },
  };
  const templatePath = path.join(root, '.data', 'templates', 'ref.template.json');
  fs.writeFileSync(templatePath, JSON.stringify(template, null, 2));

  if (mode === 'incremental') {
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
    : mode === 'concurrent'
      ? ['rec1', 'rec2'].map((record_id) => ({ record_id, values: ['', '', ''] }))
    : [{ record_id: 'rec1', values: ['', LINK_CELL, ''] }];

  return { root, templatePath, fields: FIELDS, rows };
}

/** 假的多维表格：内存表，记下每次调用的分页参数与回读次数。 */
function fakeLarkSource(fields, rows) {
  return `'use strict';

const FIELDS = ${JSON.stringify(fields)};
const rows = ${JSON.stringify(rows)};
const state = { rows, listCalls: [], getCalls: 0, batchUpdates: 0, updates: [], asyncCalls: [] };

exports.state = state;
// 异步实现：回写故意慢一拍并记下窗口，用来证明按行调用真的走的是异步路径（不阻塞事件循环）。
exports.larkAsync = async (args) => {
  const cmd = args[1];
  const started = Date.now();
  if (cmd === '+record-batch-update') await new Promise((resolve) => setTimeout(resolve, 150));
  const out = exports.lark(args);
  state.asyncCalls.push({ cmd, started, ended: Date.now() });
  return out;
};
exports.lark = (args) => {
  const cmd = args[1];
  const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };

  if (cmd === '+field-list') return { ok: true, data: { fields: FIELDS } };
  if (cmd === '+record-list') {
    const limit = Number(flag('--limit') ?? 100);
    const offset = Number(flag('--offset') ?? 0);
    const projection = args.flatMap((arg, i) => (arg === '--field-id' ? [args[i + 1]] : []));
    state.listCalls.push({ limit, offset, projection });
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
    state.getCalls += 1;
    const row = rows.find((r) => r.record_id === flag('--record-id'));
    return { ok: true, data: { field_id_list: FIELDS.map((f) => f.id), data: [row.values] } };
  }
  if (cmd === '+record-batch-update') {
    state.batchUpdates += 1;
    state.updates.push(JSON.parse(flag('--json')));
    return { ok: true, data: {} };
  }
  throw new Error('未打桩的 lark 调用: ' + args.join(' '));
};
`;
}

async function runWorker(mode) {
  const { root, templatePath, fields, rows } = makeFixture(mode);
  process.env.SKILLAPP_ROOT = root;
  process.env.SKILLAPP_DATA_DIR = path.join(root, '.data');
  const fakePath = path.join(root, 'fake-lark.cjs');
  fs.writeFileSync(fakePath, fakeLarkSource(FIELDS, rows));
  process.env.SKILLAPP_LARK_MODULE = fakePath;

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
  if (!['logs', 'no-writeback', 'cwd', 'unmapped-output', 'concurrent', 'streaming'].includes(mode)) process.argv.push('--dry-run');
  if (mode === 'incremental') process.argv.push('--incremental');

  // streaming：跑的过程中盯着 stdout.log，验证"第一行已经落盘时结果行还没出现"
  const midRun = { sawFirstBeforeResult: false };
  const poll = mode === 'streaming'
    ? setInterval(() => {
      const runsDir = path.join(root, '.data', 'runs');
      if (!fs.existsSync(runsDir)) return;
      for (const name of fs.readdirSync(runsDir)) {
        const file = path.join(runsDir, name, 'rec1', 'logs', 'stdout.log');
        if (!fs.existsSync(file)) continue;
        const text = fs.readFileSync(file, 'utf8');
        if (text.includes('first-line') && !text.includes('"value"')) midRun.sawFirstBeforeResult = true;
      }
    }, 50)
    : null;

  let exitCode = null;
  let harnessError = null;
  try {
    const cli = await import(pathToFileURL(RUN_TEMPLATE).href);
    await cli.mainPromise;
  } catch (err) {
    if (err instanceof ExitCalled) exitCode = err.code;
    else harnessError = err.stack || String(err);
  }
  if (poll) clearInterval(poll);

  process.exit = realExit;
  console.log = realLog;
  console.error = realError;

  const table = createRequire(import.meta.url)(fakePath).state;

  let runItems = null;
  let runStatus = null;
  let inputHashes = null;
  const runsDir = path.join(root, '.data', 'runs');
  if (fs.existsSync(runsDir)) {
    const runId = fs.readdirSync(runsDir).find((name) => name !== 'old-run');
    if (runId) {
      const run = JSON.parse(fs.readFileSync(path.join(runsDir, runId, 'run.json'), 'utf8'));
      runStatus = run.status;
      runItems = (run.items || []).map((item) => ({ status: item.status, stage: item.stage, error: item.error }));
      inputHashes = (run.items || []).map((item) => item.input_hash);
    }
  }

  let logs = null;
  let logReadError = null;
  if (mode === 'logs' || mode === 'streaming') {
    try {
      const runDir = path.join(root, '.data', 'runs', fs.readdirSync(path.join(root, '.data', 'runs'))[0]);
      const recordDir = path.join(runDir, 'rec1');
      logs = {
        recordFiles: fs.readdirSync(recordDir).sort(),
        logFiles: fs.readdirSync(path.join(recordDir, 'logs')).sort(),
        stdout: fs.readFileSync(path.join(recordDir, 'logs', 'stdout.log'), 'utf8'),
        stderr: fs.readFileSync(path.join(recordDir, 'logs', 'stderr.log'), 'utf8'),
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
    batchUpdates: table.batchUpdates,
    updates: table.updates,
    asyncCalls: table.asyncCalls,
    dataDir: process.env.SKILLAPP_DATA_DIR,
    runStatus,
    runItems,
    inputHashes,
    dryRows: stdout.filter((line) => line.includes('→ rec')).length,
    dryArgv: (stdout.find((line) => line.includes('argv: ')) || '').split('argv: ')[1] || null,
    noRows: stdout.some((line) => line.includes('没有符合条件的行')),
    finished: stdout.some((line) => line.includes('完成: 1 成功 / 0 失败')),
    timeline: mode === 'concurrent'
      ? fs.readFileSync(path.join(root, 'timeline.log'), 'utf8').trim().split('\n')
        .map((line) => {
          const [recordId, phase, at] = line.split(' ');
          return { recordId, phase, at: Number(at) };
        })
      : null,
    logs,
    logReadError,
    midRun,
  }) + '\n');
}

if (process.argv.includes('--worker')) {
  runWorker(flag(process.argv, '--mode')).catch((err) => {
    console.error(err.stack || String(err));
    process.exit(1);
  });
} else {
  const { test } = await import('node:test');

  const scenario = (mode, env = {}) => {
    const r = spawnSync(process.execPath, [import.meta.filename, '--worker', '--mode', mode], {
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, ...env },
    });
    const line = (r.stdout || '').split('\n').find((candidate) => candidate.startsWith(MARKER));
    assert.ok(line, `worker 没有给出结果（exit=${r.status}）:\n${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(line.slice(MARKER.length));
    assert.equal(out.harnessError, null, `worker 自己抛了异常:\n${out.harnessError}`);
    return out;
  };

  test('record-list 会翻完所有页，且不再逐行 record-get', () => {
    const out = scenario('pagination');
    assert.equal(out.exitCode, null, out.errors.join('\n'));
    assert.equal(out.dryRows, 201);
    assert.equal(out.getCalls, 0, '已经拿到列表 cells，不应再逐行 record-get');
    assert.deepEqual(out.listCalls.map((call) => [call.limit, call.offset]), [[200, 0], [200, 200]]);
    assert.deepEqual(out.listCalls[0].projection, ['fldIn']);
  });

  test('--incremental 会因 Skill / Mapping 版本变化而重跑', () => {
    const out = scenario('incremental');
    assert.equal(out.exitCode, null, out.errors.join("\n"));
    assert.equal(out.noRows, false);
    assert.equal(out.dryRows, 1);
    assert.equal(out.getCalls, 0);
  });

  test('零输出列：照样读输入、执行 Skill，不回写也不算失败', () => {
    const out = scenario('no-writeback');
    assert.equal(out.exitCode, null, out.errors.join("\n"));
    assert.equal(out.finished, true, 'CLI 应报「完成: 1 成功 / 0 失败」');
    assert.equal(out.batchUpdates, 0, '没有输出列时一次回写都不该发生');
    assert.equal(out.runStatus, 'completed');
    assert.deepEqual(out.runItems, [{ status: 'succeeded', stage: null, error: null }]);
  });

  test('飞书文本列里的 Markdown 链接会归一成裸 URL', () => {
    const out = scenario('link-cell');
    assert.equal(out.exitCode, null, out.errors.join("\n"));
    const argv = JSON.parse(out.dryArgv);
    assert.ok(argv.includes('https://stub.feishu.cn/wiki/Tok?table=t&view=v'),
      `argv 里应是裸 URL：${out.dryArgv}`);
    assert.ok(!out.dryArgv.includes('外包负责需求单'), '标题不该传给 Skill');
  });

  test('Skill 子进程的 cwd 是内容层根（lark-cli 的写盘白名单要它做祖先）', () => {
    const out = scenario('cwd');
    assert.equal(out.exitCode, null, out.errors.join("\n"));
    assert.equal(out.updates.length, 1, '应回写一次');
    assert.match(out.inputHashes[0], /^sha256:[0-9a-f]{16}$/, 'input_hash 与其他 hash 一样带算法前缀');
    // 进程里拿到的是解析过符号链接的真实路径（macOS 上 /var → /private/var）
    assert.equal(out.updates[0].update_records.rec1.fldOut, fs.realpathSync(out.dataDir));
  });

  test('stdout / stderr 原样落成 .log 文本', () => {
    const out = scenario('logs');
    assert.equal(out.exitCode, null, out.errors.join("\n"));
    assert.equal(out.logReadError, null);
    assert.deepEqual(out.logs.recordFiles, ['artifacts', 'logs']);
    assert.deepEqual(out.logs.logFiles, ['stderr.log', 'stdout.log']);
    assert.equal(out.logs.stdout, '{"value":"ok"}\n', 'stdout 原样落盘');
    assert.equal(out.logs.stderr, 'warn-line\n', 'stderr 原样落盘');
  });

  test('未映射的输入（模板里没有它）：不读、不传参，运行照常', () => {
    const out = scenario('unmapped-input');
    assert.equal(out.exitCode, null, out.errors.join("\n"));
    assert.deepEqual(out.listCalls[0].projection, [], '未映射的输入不该出现在读取列里');
    const argv = JSON.parse(out.dryArgv);
    assert.deepEqual(argv.slice(0, 2).map((part, i) => (i === 0 ? part : part.endsWith('entry.js'))), ['node', true],
      `argv 应是 node + 入口：${out.dryArgv}`);
    assert.equal(argv.length, 4, '未映射的输入不该变成命令行参数');
    assert.ok(!argv.includes('x'), '默认值也不该传出去');
  });

  test('未映射的输出（模板里没有它）：只回写映射的那一列', () => {
    const out = scenario('unmapped-output');
    assert.equal(out.exitCode, null, out.errors.join("\n"));
    assert.equal(out.batchUpdates, 1, '只该回写映射的那一列');
    assert.deepEqual(out.updates[0].update_records.rec1, { fldOut: 'ok' });
    assert.equal(out.runStatus, 'completed');
  });

  test('模板里没有的输入被 cmd 当位置参数用：运行前就说清楚，别等逐行报 undefined', () => {
    const out = scenario('unmapped-cmd');
    assert.equal(out.exitCode, 1, '应以退出码 1 结束');
    const text = out.errors.join('\n');
    assert.match(text, /Input is not mapped but cmd needs it/);
    assert.match(text, /- text/, '要点名是哪个输入');
    assert.equal(out.listCalls.length, 0, '还没读表就该拦住');
  });

  test('归档（冻结）的 Template 不能跑', () => {
    const out = scenario('archived');
    assert.equal(out.exitCode, 1, '应以退出码 1 结束');
    assert.match(out.errors.join('\n'), /Template is archived/);
    assert.equal(out.listCalls.length, 0, '不该读表');
  });

  test('并发：同一 Run 内按 SKILLAPP_RUN_CONCURRENCY 同时跑多行', () => {
    // 技能脚本把每行的开始 / 结束时刻写进同一份时间线，两行区间重叠即为真并发。
    const overlaps = (timeline) => {
      const spans = new Map();
      for (const { recordId, phase, at } of timeline) {
        spans.set(recordId, { ...spans.get(recordId), [phase]: at });
      }
      const all = [...spans.values()];
      return all.some((a, i) => all.some((b, j) => i !== j && a.start < b.end && b.start < a.end));
    };

    const serial = scenario('concurrent', { SKILLAPP_RUN_CONCURRENCY: '1' });
    assert.equal(serial.exitCode, null, serial.errors.join('\n'));
    assert.equal(serial.runStatus, 'completed');
    assert.equal(serial.batchUpdates, 2, '两行各回写自己的记录');
    assert.ok(!overlaps(serial.timeline), `并发数 1 时两行不该重叠：${JSON.stringify(serial.timeline)}`);

    const parallel = scenario('concurrent', { SKILLAPP_RUN_CONCURRENCY: '2' });
    assert.equal(parallel.exitCode, null, parallel.errors.join('\n'));
    assert.equal(parallel.runStatus, 'completed');
    assert.ok(overlaps(parallel.timeline), `并发数 2 时两行应重叠：${JSON.stringify(parallel.timeline)}`);

    // 按行的飞书调用必须走异步实现，否则两条回写会前后排队（旧行为）。
    const writes = parallel.asyncCalls.filter((call) => call.cmd === '+record-batch-update');
    assert.equal(writes.length, 2, '两行的回写都该走 larkAsync');
    assert.ok(writes[0].started < writes[1].ended && writes[1].started < writes[0].ended,
      `两行的回写窗口应重叠：${JSON.stringify(writes)}`);
  });

  test('长跑的 Skill：stdout 边跑边落盘，进程还在跑时日志已经可读', () => {
    const out = scenario('streaming');
    assert.equal(out.exitCode, null, out.errors.join('\n'));
    assert.equal(
      out.midRun.sawFirstBeforeResult,
      true,
      '第一行输出应该在脚本结束前就写进了 logs/stdout.log（这样刷新页面/进程被打断都还有日志）',
    );
    assert.match(out.logs.stdout, /first-line/);
    assert.match(out.logs.stdout, /"value":"ok"/);
  });
}
