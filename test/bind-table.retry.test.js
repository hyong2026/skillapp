#!/usr/bin/env node
/**
 * bind-table.js 的「建列后回读」回归测试。
 *
 * 被测的是真代码：真跑 src/cli/bind-table.js，只替换两处外部依赖——
 *   - src/core/lark → 假的多维表格（经 SKILLAPP_LARK_MODULE 注入；能让新建的列延迟 N 次 field-list 才可见）
 *   - PATH 上的 sleep / node → 空转替身（退避不耗时、自检直接成功，只记调用次数）
 * 契约夹具内嵌在下面，写操作全落在 os.tmpdir() 下的临时 ROOT 里，不碰真表、不碰 .data/templates/。
 *
 *   node --test                                                   # 在仓库根跑全部（Node 默认的测试文件匹配规则）
 *   node test/bind-table.retry.test.js --worker --hidden-reads 2    # 单跑一个场景（调试用）
 *
 * 这个 bug 的由来：第一次把 image-split 映射到真实表格时，8 列建完后立刻回读却没读到，
 * 于是报「新建后仍找不到列『out: 每格高 (px)』」中断。旧代码的回读只试一次，
 * 而同一个文件里的 setColumnOrder 对同样的延迟已经重试了 3 次。
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const BIND_TABLE = path.join(ROOT, 'src', 'cli', 'bind-table.js');
const REF = 'testref';
const MARKER = '__RESULT__ ';

/** 最小契约夹具：2 输入 + 2 输出，够触发「一次性建多列 + 建完回读」这条路径 */
const FIXTURE = {
  skill: { entry: 'scripts/main.js' },
  cmd: 'node {skill.entry} {image...} -n {grid} -o {outdir} --json',
  inputs: [
    { key: 'image', label: '待切图片', type: 'attachment', required: true, validate: { count: 1 }, hint: '一张图片。' },
    { key: 'grid', label: '网格数', type: 'number', required: true, validate: { min: 2, max: 10 } },
  ],
  outputs: [
    { key: 'tiles', label: '切片', type: 'attachment', from: 'stdout.files[].path' },
    { key: 'tile_count', label: '切片数', type: 'number', from: 'stdout.grid.total' },
  ],
  limits: { max_rows_per_run: 200, timeout_s: 300 },
};

/** 契约期望的列序（主字段 → 输入 → 输出） */
const EXPECTED_ORDER = ['任务名称', 'IN: 待切图片 (必填)', 'IN: 网格数 (必填)', 'OUT: 切片', 'OUT: 切片数'];
const EXPECTED_CREATED = FIXTURE.inputs.length + FIXTURE.outputs.length;

/** 同一份契约，但「out: 切片」标为未映射：不建列、不进列序 */
const UNMAPPED_FIXTURE = {
  ...FIXTURE,
  outputs: [{ ...FIXTURE.outputs[0], mapped: false }, FIXTURE.outputs[1]],
};
const UNMAPPED_ORDER = ['任务名称', 'IN: 待切图片 (必填)', 'IN: 网格数 (必填)', 'OUT: 切片数'];

// ─── worker：在临时 ROOT 里真跑一次 bind-table ─────────────────────────────

/**
 * 假的多维表格：内存表 + 可配置的字段可见延迟。
 * 写成文件是因为 src/core/lark 只接受「模块路径」这一种注入方式。
 */
function fakeLarkSource(hiddenReads) {
  return `'use strict';

const table = {
  fields: [{ id: 'fldP', name: '文本', type: 'text' }],
  visible: ['文本'],
  fresh: [],
  delay: ${hiddenReads}, // 建列之后还要过几次 field-list 才可见（传播延迟按时间算，故从建列那刻才开始）
  pendingReads: 0,
  createdPayload: null,
  finalOrder: null,
  primaryRenamedTo: null,
};
let newId = 0;

exports.state = table;
exports.lark = (args) => {
  const cmd = args[1];
  const flag = (f) => { const i = args.indexOf(f); return i < 0 ? null : args[i + 1]; };
  const jsonArg = () => JSON.parse(flag('--json'));

  switch (cmd) {
    case '+url-resolve':
      return { ok: true, data: { base_token: 'basStub', table_id: 'tblStub', view_id: 'vewStub' } };
    case '+field-list': {
      const hiding = table.pendingReads > 0;
      if (hiding) table.pendingReads -= 1;
      const fields = hiding ? table.fields.filter((f) => !table.fresh.includes(f)) : table.fields;
      return { ok: true, data: { fields } };
    }
    case '+view-get-visible-fields':
      return { ok: true, data: { visible_fields: table.visible } };
    case '+field-create': {
      table.createdPayload = jsonArg();
      table.pendingReads = table.delay;
      for (const spec of table.createdPayload) {
        const field = { id: 'fldNew' + (newId += 1), name: spec.name, type: spec.type };
        table.fields.push(field);
        table.fresh.push(field);
      }
      return { ok: true, data: {} };
    }
    case '+field-update': {
      const spec = jsonArg();
      const field = table.fields.find((item) => item.id === flag('--field-id'));
      if (field) { field.name = spec.name; table.primaryRenamedTo = spec.name; }
      return { ok: true, data: {} };
    }
    case '+view-set-visible-fields':
      table.finalOrder = jsonArg().visible_fields;
      return { ok: true, data: {} };
    default:
      throw new Error('打桩未覆盖的调用: ' + args.join(' '));
  }
};
`;
}

/** PATH 上的 sleep / node 替身：每次调用往日志里记一笔，便于断言退避次数与自检次数。 */
function makeStubBin(root) {
  const bin = path.join(root, 'bin');
  const calls = path.join(root, 'calls.log');
  fs.mkdirSync(bin, { recursive: true });
  const write = (name, body) => {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho ${name} >> "${calls}"\n${body}\n`);
    fs.chmodSync(path.join(bin, name), 0o755);
  };
  write('sleep', 'exit 0');
  write('node', "echo '  [stub] 自检已跳过'");
  return { bin, calls };
}

async function runWorker(hiddenReads, unmapped) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillapp-retry-'));
  process.env.SKILLAPP_ROOT = root;
  process.env.SKILLAPP_DATA_DIR = path.join(root, '.data');

  // 1) 注入假 lark，替代 lark-cli
  const fakePath = path.join(root, 'fake-lark.cjs');
  fs.writeFileSync(fakePath, fakeLarkSource(hiddenReads));
  process.env.SKILLAPP_LARK_MODULE = fakePath;

  // 2) 把 PATH 上的 sleep / node 换成空转替身
  const { bin, calls } = makeStubBin(root);
  const realPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${realPath}`;

  // 必须在 env 定好之后再加载 src 模块：paths.js 的目录常量是导入时求值的
  const { templateFileName } = await import('../src/core/template.js');

  // 3) 临时 ROOT：已装 Skill + 契约副本
  fs.mkdirSync(path.join(root, '.data', 'skills', REF), { recursive: true });
  fs.mkdirSync(path.join(root, '.data', 'mappings'), { recursive: true });
  fs.writeFileSync(path.join(root, '.data', 'skills', REF, 'SKILL.md'), '# stub\n');
  fs.writeFileSync(path.join(root, '.data', 'skills', REF, 'source.json'),
    JSON.stringify({ source: '/tmp/stub', hash: 'sha256:stub', loaded_at: '' }));
  fs.writeFileSync(path.join(root, '.data', 'mappings', `${REF}.mapping.json`),
    JSON.stringify(unmapped ? UNMAPPED_FIXTURE : FIXTURE, null, 2));

  // 4) 真跑 bind-table.js：它的 catch 会 process.exit(1)，这里换成可捕获的异常
  const errors = [];
  const realError = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); realError(...args); };
  class ExitCalled extends Error {}
  const realExit = process.exit;
  process.exit = (code) => { const e = new ExitCalled(`process.exit(${code})`); e.code = code; throw e; };

  process.argv = ['node', 'bind-table.js', '--ref', REF, '--url', 'https://stub.feishu.cn/base/x?table=t&view=v'];

  let exitCode = null;
  let harnessError = null;
  try {
    await import(pathToFileURL(BIND_TABLE).href);
  } catch (err) {
    if (err instanceof ExitCalled) exitCode = err.code;
    else harnessError = err.stack || String(err);
  }
  process.exit = realExit;
  console.error = realError;
  process.env.PATH = realPath;

  // 假 lark 与实际执行共用同一个模块实例，直接读它的表状态即可
  const state = createRequire(import.meta.url)(fakePath).state;
  // Template 文件名带目标表指纹：<ref>-<8 位 hash>.template.json
  const templateName = templateFileName(REF, { base_token: 'basStub', table_id: 'tblStub', view_id: 'vewStub' });
  const templatePath = path.join(root, '.data', 'templates', templateName);
  const template = fs.existsSync(templatePath) ? JSON.parse(fs.readFileSync(templatePath, 'utf8')) : null;
  const callLog = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean) : [];

  process.stdout.write(MARKER + JSON.stringify({
    hiddenReads,
    unmapped,
    exitCode,
    harnessError,
    sleeps: callLog.filter((line) => line === 'sleep').length,
    selfChecks: callLog.filter((line) => line === 'node').length,
    created: state.createdPayload ? state.createdPayload.length : 0,
    described: state.createdPayload ? state.createdPayload.filter((field) => field.description).length : 0,
    order: state.finalOrder,
    primaryRenamedTo: state.primaryRenamedTo,
    templateWritten: Boolean(template),
    template,
    errorText: errors.join('\n'),
  }) + '\n');
}

// ─── driver：node:test ────────────────────────────────────────────────────

if (process.argv.includes('--worker')) {
  const index = process.argv.indexOf('--hidden-reads');
  runWorker(Number(process.argv[index + 1] ?? 0), process.argv.includes('--unmapped')).catch((err) => {
    console.error(err.stack || String(err));
    process.exit(1);
  });
} else {
  const scenario = (hiddenReads, unmapped = false) => {
    const args = [import.meta.filename, '--worker', '--hidden-reads', String(hiddenReads)];
    if (unmapped) args.push('--unmapped');
    const r = spawnSync(process.execPath, args,
      { encoding: 'utf8', timeout: 120000 });
    const line = (r.stdout || '').split('\n').find((candidate) => candidate.startsWith(MARKER));
    assert.ok(line, `worker 没有给出结果（exit=${r.status}）:\n${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(line.slice(MARKER.length));
    assert.equal(out.harnessError, null, `worker 自己抛了异常:\n${out.harnessError}`);
    return out;
  };

  test('顺利时零等待：一次回读就命中，退避不产生额外开销', () => {
    const out = scenario(0);
    assert.equal(out.exitCode, null, '不该退出');
    assert.equal(out.sleeps, 0, '不该有任何等待');
    assert.equal(out.created, EXPECTED_CREATED, '一次性建齐契约里的列');
    assert.equal(out.described, 1, '带 hint 的列应写入 description');
    assert.deepEqual(out.order, EXPECTED_ORDER, '列序应与契约一致');
    assert.equal(out.primaryRenamedTo, '任务名称', '默认主字段应改名');
    assert.equal(out.templateWritten, true, 'Template 应写出');
    assert.equal(out.selfChecks, 1, '应调用一次自检');

    const tpl = out.template;
    const entries = [...tpl.mapping.inputs, ...tpl.mapping.outputs];
    assert.equal(entries.length, EXPECTED_CREATED);
    assert.ok(entries.every((entry) => typeof entry.field_id === 'string' && entry.field_id.startsWith('fldNew')),
      '每个映射条目都要拿到 field_id');
    assert.equal(tpl.skill.hash, 'sha256:stub', 'Skill 指纹应原样带上');
    assert.equal(tpl.target.table_id, 'tblStub', '目标表格应原样带上');
    assert.equal(tpl.limits.timeout_s, 300, 'limits 应原样带上');
    assert.ok(tpl.mapping.cmd.includes('--json'), 'cmd 应原样带上');
  });

  for (const hidden of [1, 2, 9]) {
    test(`新建字段延迟 ${hidden} 次可见时：退避重试后照样跑完`, () => {
      const out = scenario(hidden);
      assert.equal(out.exitCode, null, '不该退出');
      assert.equal(out.sleeps, hidden, '每次读不到都应退避一次');
      assert.deepEqual(out.order, EXPECTED_ORDER, '列序应与契约一致');
      assert.equal(out.templateWritten, true, 'Template 应写出');
      assert.ok([...out.template.mapping.inputs, ...out.template.mapping.outputs]
        .every((entry) => typeof entry.field_id === 'string' && entry.field_id), '每个映射条目都要拿到 field_id');
    });
  }

  test('延迟超出重试预算时：报错点名缺哪几列，并给出「重跑」这条出路', () => {
    const out = scenario(99);
    assert.equal(out.exitCode, 1, '应以退出码 1 结束');
    assert.equal(out.sleeps, 9, '预算内应等待 CREATE_ATTEMPTS - 1 次');
    assert.match(out.errorText, /新建后仍找不到列/, '要点名问题');
    assert.match(out.errorText, /IN: 待切图片 \(必填\)/, '要列出缺失的列名');
    assert.match(out.errorText, /重跑本命令即可/, '要给出可操作的下一步');
    assert.equal(out.templateWritten, false, '失败时不应写 Template');
  });

  test('未映射的输出：不建列、不进列序，也不写进 Template', () => {
    const out = scenario(0, true);
    assert.equal(out.exitCode, null, '不该退出');
    assert.equal(out.created, EXPECTED_CREATED - 1, '未映射的列不该被创建');
    assert.deepEqual(out.order, UNMAPPED_ORDER, '未映射的列不该出现在列序里');
    assert.deepEqual(out.template.mapping.outputs.map((item) => item.key), ['tile_count'],
      'Template 里只留已映射的输出');
    assert.ok(out.template.mapping.outputs[0].field_id, '映射的输出照常拿到 field_id');
  });
}
