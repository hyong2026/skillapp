#!/usr/bin/env node
/**
 * map-table.js 的「建列后回读」回归测试。
 *
 * 被测的是真代码：真跑 src/cli/map-table.js，只替换两处外部依赖——
 *   - src/core/lark → 假的多维表格（可让新建的列延迟 N 次 field-list 才可见 = 飞书字段传播延迟）
 *   - spawnSync → sleep 空转、node 自检直接成功
 * 契约夹具内嵌在下面，写操作全落在 os.tmpdir() 下的临时 ROOT 里，不碰真表、不碰 .data/templates/。
 *
 *   node --test                     # 在仓库根跑全部（Node 默认的测试文件匹配规则）
 *   node test/map-table.retry.test.js --worker --hidden-reads 2   # 单跑一个场景（调试用）
 *
 * 这个 bug 的由来：第一次把 image-split 映射到真实表格时，8 列建完后立刻回读却没读到，
 * 于是报「新建后仍找不到列『out: 每格高 (px)』」中断。旧代码的回读只试一次，
 * 而同一个文件里的 setColumnOrder 对同样的延迟已经重试了 3 次。
 *
 * 修复前后都验证过：摘掉补丁（`git stash push src/cli/map-table.js`）后跑 `node --test`，
 * 5 个用例里 4 个失败（零延迟那个仍会过——它一次回读就命中）；恢复补丁后 5/5 通过。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MAP_TABLE = path.join(ROOT, 'src', 'cli', 'map-table.js');
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
const EXPECTED_ORDER = ['任务名称', '＊in: 待切图片', '＊in: 网格数', 'out: 切片', 'out: 切片数'];
const EXPECTED_CREATED = FIXTURE.inputs.length + FIXTURE.outputs.length;

// ─── worker：打桩跑一次 map-table ─────────────────────────────────────────

function runWorker(hiddenReads) {
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'skillapp-retry-'));
  process.env.SKILLAPP_ROOT = fake;
  process.env.SKILLAPP_DATA_DIR = path.join(fake, '.data');

  // 1) 打桩 child_process.spawnSync —— 必须早于 require（两端都在 require 时解构）
  const cp = require('child_process');
  const realSpawnSync = cp.spawnSync;
  const calls = { sleep: 0, selfCheck: 0 };
  cp.spawnSync = (cmd, args = []) => {
    if (cmd === 'sleep') { calls.sleep += 1; return { status: 0, stdout: '', stderr: '' }; }
    if (cmd === 'node') { calls.selfCheck += 1; return { status: 0, stdout: '  [stub] 自检已跳过\n', stderr: '' }; }
    return realSpawnSync(cmd, args);
  };

  // 2) 临时 ROOT：已装 Skill + 契约副本
  fs.mkdirSync(path.join(fake, '.data', 'skills', REF), { recursive: true });
  fs.mkdirSync(path.join(fake, '.data', 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(fake, '.data', 'skills', REF, 'SKILL.md'), '# stub\n');
  fs.writeFileSync(path.join(fake, '.data', 'skills', REF, 'source.json'),
    JSON.stringify({ source: '/tmp/stub', hash: 'sha256:stub', loaded_at: '' }));
  fs.writeFileSync(path.join(fake, '.data', 'tmp', `${REF}.io-schema.json`), JSON.stringify(FIXTURE, null, 2));

  // 3) 打桩 src/core/lark
  const table = {
    fields: [{ id: 'fldP', name: '文本', type: 'text' }],
    visible: ['文本'],
    hiddenReads: 0, // 建列之后还要过几次 field-list 才可见（传播延迟按时间算，故从建列那刻才开始）
    fresh: [],
    createdPayload: null,
    finalOrder: null,
    primaryRenamedTo: null,
  };
  let newId = 0;

  const fakeLark = (args) => {
    const [, cmd] = args;
    const flag = (f) => { const i = args.indexOf(f); return i < 0 ? null : args[i + 1]; };
    const jsonArg = () => JSON.parse(flag('--json'));

    switch (cmd) {
      case '+url-resolve':
        return { ok: true, data: { base_token: 'basStub', table_id: 'tblStub', view_id: 'vewStub' } };

      case '+field-list': {
        const hiding = table.hiddenReads > 0;
        if (hiding) table.hiddenReads -= 1;
        const fields = hiding ? table.fields.filter((f) => !table.fresh.includes(f)) : table.fields;
        return { ok: true, data: { fields } };
      }

      case '+view-get-visible-fields':
        return { ok: true, data: { visible_fields: table.visible } };

      case '+field-create': {
        table.createdPayload = jsonArg();
        table.hiddenReads = hiddenReads;
        for (const spec of table.createdPayload) {
          const f = { id: `fldNew${newId += 1}`, name: spec.name, type: spec.type };
          table.fields.push(f);
          table.fresh.push(f);
        }
        return { ok: true, data: {} };
      }

      case '+field-update': {
        const spec = jsonArg();
        const f = table.fields.find((x) => x.id === flag('--field-id'));
        if (f) { f.name = spec.name; table.primaryRenamedTo = spec.name; }
        return { ok: true, data: {} };
      }

      case '+view-set-visible-fields':
        table.finalOrder = jsonArg().visible_fields;
        return { ok: true, data: {} };

      default:
        throw new Error(`打桩未覆盖的调用: ${args.join(' ')}`);
    }
  };

  const larkPath = require.resolve(path.join(ROOT, 'src', 'core', 'lark.js'));
  require.cache[larkPath] = {
    id: larkPath, filename: larkPath, loaded: true,
    exports: { ROOT: fake, lark: fakeLark },
  };

  // 4) 真跑 map-table.js：它的 catch 会 process.exit(1)，这里换成可捕获的异常
  const errors = [];
  const realError = console.error;
  console.error = (...a) => { errors.push(a.join(' ')); realError(...a); };
  class ExitCalled extends Error {}
  const realExit = process.exit;
  process.exit = (code) => { const e = new ExitCalled(`process.exit(${code})`); e.code = code; throw e; };

  process.argv = ['node', 'map-table.js', '--ref', REF, '--url', 'https://stub.feishu.cn/base/x?table=t&view=v'];

  let exitCode = null;
  let harnessError = null;
  try {
    require(MAP_TABLE);
  } catch (err) {
    if (err instanceof ExitCalled) exitCode = err.code;
    else harnessError = err.stack || String(err);
  }
  process.exit = realExit;
  console.error = realError;

  const templatePath = path.join(fake, '.data', 'templates', `${REF}.json`);
  const template = fs.existsSync(templatePath) ? JSON.parse(fs.readFileSync(templatePath, 'utf8')) : null;

  process.stdout.write(MARKER + JSON.stringify({
    hiddenReads,
    exitCode,
    harnessError,
    sleeps: calls.sleep,
    selfChecks: calls.selfCheck,
    created: table.createdPayload?.length ?? 0,
    described: table.createdPayload?.filter((f) => f.description).length ?? 0,
    order: table.finalOrder,
    primaryRenamedTo: table.primaryRenamedTo,
    templateWritten: Boolean(template),
    template,
    errorText: errors.join('\n'),
  }) + '\n');
}

// ─── driver：node:test ────────────────────────────────────────────────────

if (process.argv.includes('--worker')) {
  const i = process.argv.indexOf('--hidden-reads');
  runWorker(Number(process.argv[i + 1] ?? 0));
} else {
  const { test } = require('node:test');
  const assert = require('node:assert');

  const scenario = (hiddenReads) => {
    const r = spawnSync(process.execPath, [__filename, '--worker', '--hidden-reads', String(hiddenReads)],
      { encoding: 'utf8', timeout: 120000 });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith(MARKER));
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
    assert.ok(entries.every((e) => typeof e.field_id === 'string' && e.field_id.startsWith('fldNew')),
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
        .every((e) => typeof e.field_id === 'string' && e.field_id), '每个映射条目都要拿到 field_id');
    });
  }

  test('延迟超出重试预算时：报错点名缺哪几列，并给出「重跑」这条出路', () => {
    const out = scenario(99);
    assert.equal(out.exitCode, 1, '应以退出码 1 结束');
    assert.equal(out.sleeps, 9, '预算内应等待 CREATE_ATTEMPTS - 1 次');
    assert.match(out.errorText, /新建后仍找不到列/, '要点名问题');
    assert.match(out.errorText, /＊in: 待切图片/, '要列出缺失的列名');
    assert.match(out.errorText, /重跑本命令即可/, '要给出可操作的下一步');
    assert.equal(out.templateWritten, false, '失败时不应写 Template');
  });
}
