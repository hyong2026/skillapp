import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createServer } from '../src/server/app.js';

const TOKEN = 'test-token';
const AUTH = `Basic ${Buffer.from(`skillapp:${TOKEN}`).toString('base64')}`;
let root;
let server;
let baseUrl;

function write(relativePath, content) {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function buildFixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillapp-web-m3-'));
  write('demo/SKILL.md', '# Demo Skill\n');
  write('demo/entry.js', 'console.log(JSON.stringify({ value: "ok" }));\n');
  write('fake-analyzer.js', [
    "'use strict';",
    "const fs = require('fs');",
    "const waitUntil = Date.now() + 200; while (Date.now() < waitUntil) {}",
    "const schema = {",
    "  skill: { entry: 'entry.js' },",
    "  cmd: 'node {skill.entry} -o {outdir}',",
    "  inputs: [{ key: 'title', label: 'Title', type: 'text', required: true }],",
    "  outputs: [{ key: 'result', label: 'Result', type: 'text', from: 'stdout.value' }],",
    "};",
    "fs.writeFileSync(process.env.SKILLAPP_ANALYZE_MAPPING_PATH, JSON.stringify(schema));",
  ].join('\n'));
  write('fake-lark.js', [
    "'use strict';",
    "const fs = require('fs');",
    "const path = require('path');",
    "const mutation = path.join(__dirname, 'mutate-fields');",
    "let fields = [{ id: 'fldP', name: '文本', type: 'text' }];",
    "let visible = ['文本'];",
    "let next = 0;",
    "exports.lark = (args) => {",
    "  const cmd = args[1];",
    "  const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };",
    "  const json = () => JSON.parse(flag('--json'));",
    // `alt-base` 标记存在时解析成另一张表，用来验证「换表 = 另建 Template」
    "  const alt = fs.existsSync(path.join(__dirname, 'alt-base'));",
    "  if (cmd === '+url-resolve') return { ok: true, data: alt ? { base_token: 'baseAlt', table_id: 'tblAlt', view_id: 'vewAlt' } : { base_token: 'baseM3', table_id: 'tblM3', view_id: 'vewM3' } };",
    "  if (cmd === '+field-list') { const live = fs.existsSync(mutation) ? fields.concat([{ id: 'fldMutation', name: 'Mutation', type: 'text' }]) : fields; return { ok: true, data: { fields: live } }; }",
    "  if (cmd === '+view-get-visible-fields') return { ok: true, data: { visible_fields: visible } };",
    "  if (cmd === '+field-create') {",
    "    const payload = json();",
    "    for (const spec of payload) fields.push({ id: `fldNew${next += 1}`, name: spec.name, type: spec.type });",
    "    return { ok: true, data: {} };",
    "  }",
    "  if (cmd === '+field-update') {",
    "    const spec = json();",
    "    const id = flag('--field-id');",
    "    const field = fields.find((item) => item.id === id);",
    "    if (field) field.name = spec.name;",
    "    return { ok: true, data: {} };",
    "  }",
    "  if (cmd === '+view-set-visible-fields') { visible = json().visible_fields; return { ok: true, data: {} }; }",
    "  throw new Error(`unexpected fake lark command: ${args.join(' ')}`);",
    "};",
  ].join('\n'));
}

async function listen() {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function requestJson(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers: {
      authorization: AUTH,
      ...(options.method && options.method !== 'GET' ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = await response.json();
  return { response, body };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 按 operation_id 等一个操作结束（归档这类不再挂在 Skill 别名下）。 */
/** 读 SSE 直到出现满足条件的帧（验证全局操作流用）。 */
async function readStreamFrames(pathname, predicate, { timeoutMs = 8000, onOpen = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      headers: { authorization: AUTH, accept: 'text/event-stream' },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    if (onOpen) await onOpen();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
        if (!data) continue;
        const event = JSON.parse(data);
        if (predicate(event)) return event;
      }
    }
    throw new Error(`stream ended before the expected frame: ${pathname}`);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function waitForOperationId(operationId) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const result = await requestJson(`/api/operations/${operationId}`);
    if (!result.response.ok) throw new Error(JSON.stringify(result.body));
    if (['completed', 'failed', 'canceled', 'interrupted'].includes(result.body.data.status)) return result.body.data;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for operation ${operationId}`);
}

async function waitForRun(runId) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await requestJson(`/api/runs/${runId}`);
    if (!result.response.ok) throw new Error(JSON.stringify(result.body));
    if (['completed', 'failed', 'partial', 'canceled', 'interrupted'].includes(result.body.data.status)) return result.body.data;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for run ${runId}`);
}

async function waitForOperation(ref, alias) {
  const deadline = Date.now() + 8000;
  let result;
  while (Date.now() < deadline) {
    result = await requestJson(`/api/skills/${ref}/operations/${alias}`);
    if (!result.response.ok) throw new Error(JSON.stringify(result.body));
    if (['completed', 'failed', 'canceled', 'interrupted'].includes(result.body.data.status)) return result.body.data;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${alias} on ${ref}`);
}

before(async () => {
  buildFixture();
  process.env.SKILLAPP_LARK_MODULE = path.join(root, 'fake-lark.js');
  process.env.SKILLAPP_ANALYZE_COMMAND = process.execPath;
  process.env.SKILLAPP_ANALYZE_ARGS = JSON.stringify([path.join(root, 'fake-analyzer.js')]);
  server = createServer({ root, token: TOKEN });
  await listen();
});

after(async () => {
  server.taskRunner.shutdown();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  delete process.env.SKILLAPP_LARK_MODULE;
  delete process.env.SKILLAPP_ANALYZE_COMMAND;
  delete process.env.SKILLAPP_ANALYZE_ARGS;
  fs.rmSync(root, { recursive: true, force: true });
});

test('M3 可以通过 Web API 装载 Skill、保存 Mapping 并生成 Template', async () => {
  const load = await requestJson('/api/skills/load', {
    method: 'POST',
    body: { source_path: path.join(root, 'demo') },
  });
  assert.equal(load.response.status, 202);
  const loaded = await waitForOperation('demo', 'load');
  assert.equal(loaded.status, 'completed', JSON.stringify(loaded.error));
  assert.equal(fs.existsSync(path.join(root, 'skills', 'demo', 'SKILL.md')), true);
  const loadedSkill = await requestJson('/api/skills/demo');
  assert.equal(loadedSkill.body.data.status, 'unanalyzed');

  const analyzed = await requestJson('/api/skills/demo/analyze', { method: 'POST', body: {} });
  const active = await requestJson('/api/skills/demo');
  assert.equal(active.body.data.status, 'analyzing');
  assert.equal(active.body.data.operations.analyze.operation_id, analyzed.body.data.operation_id);
  const analysisOperation = await waitForOperation('demo', 'analyze');
  assert.equal(analysisOperation.status, 'completed', JSON.stringify(analysisOperation.error));
  const analyzedSkill = await requestJson('/api/skills/demo');
  assert.equal(analyzedSkill.body.data.analysis.state, 'current');
  assert.equal(analyzedSkill.body.data.status, 'ready');

  const schema = {
    skill: { entry: 'entry.js' },
    cmd: 'node {skill.entry} -o {outdir}',
    inputs: [{ key: 'title', label: 'Title', type: 'text', required: true }],
    outputs: [{ key: 'result', label: 'Result', type: 'text', from: 'stdout.value' }],
  };
  const saved = await requestJson('/api/skills/demo/mapping', {
    method: 'PUT',
    body: { mapping: schema },
  });
  assert.equal(saved.response.status, 200);
  assert.match(saved.body.data.mapping.skill_hash, /^sha256:/);

  const apply = await requestJson('/api/mappings', {
    method: 'POST',
    body: { ref: 'demo', url: 'https://stub.feishu.cn/base/x?table=t&view=v' },
  });
  const applied = await waitForOperation('demo', 'map-table');

  assert.equal(applied.status, 'completed', JSON.stringify(applied.error));
  const templateId = applied.result.template.template_id;
  const template = await requestJson(`/api/templates/${templateId}`);
  assert.equal(template.response.status, 200);
  assert.equal(template.body.data.template.mapping.inputs[0].type, 'text');
  assert.equal(template.body.data.template.mapping.outputs[0].from, 'stdout.value');

  const remap = await requestJson('/api/mappings', {
    method: 'POST',
    body: { ref: 'demo', url: 'https://stub.feishu.cn/base/x?table=t&view=v' },
  });
  const remapped = await waitForOperation('demo', 'map-table');
  assert.equal(remapped.status, 'completed', JSON.stringify(remapped.error));
});

test('M3 重新分析会保留「未映射」的勾选，重新 Mapping 后才写进 Template', async () => {
  const before = await requestJson('/api/skills/demo');
  const mapping = before.body.data.analysis.mapping;
  const saved = await requestJson('/api/skills/demo/mapping', {
    method: 'PUT',
    body: { mapping: { ...mapping, outputs: mapping.outputs.map((spec) => ({ ...spec, mapped: false })) } },
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.body));

  await requestJson('/api/skills/demo/analyze', { method: 'POST', body: {} });
  const reanalyzed = await waitForOperation('demo', 'analyze');
  assert.equal(reanalyzed.status, 'completed', JSON.stringify(reanalyzed.error));

  const after = await requestJson('/api/skills/demo');
  const outputs = after.body.data.analysis.mapping.outputs;
  assert.equal(outputs.length, 1, '新分析的结果应当保留');
  assert.equal(outputs[0].mapped, false, '重分析不该丢掉未映射的勾选');

  await requestJson('/api/mappings', {
    method: 'POST',
    body: { ref: 'demo', url: 'https://stub.feishu.cn/base/x?table=t&view=v' },
  });
  const applied = await waitForOperation('demo', 'map-table');
  assert.equal(applied.status, 'completed', JSON.stringify(applied.error));
  assert.equal(applied.result.template.mapping.outputs[0].mapped, false, '未映射的标记要写进 Template');
  assert.ok(applied.result.order.includes('＊in: Title'), '必填输入照常建列');
  assert.ok(!applied.result.order.includes('out: Result'), '未映射的输出不建列');
});

test('M3 换一张表会另建 Template，回到原表只更新原来那一份', async () => {
  const templateFiles = () => fs.readdirSync(path.join(root, 'templates')).filter((name) => name.endsWith('.template.json'));
  const list = await requestJson('/api/templates');
  const first = list.body.data[0];
  assert.match(templateFiles()[0], /^demo-[0-9a-f]{8}\.template\.json$/, '文件名 = Skill 名 + 8 位 Hash');
  assert.equal(first.name, templateFiles()[0].replace('.template.json', ''), 'Template Name 就是文件名');
  assert.equal(first.ref, 'demo', 'ref 仍是 Skill 名');

  fs.writeFileSync(path.join(root, 'alt-base'), 'alt');
  await requestJson('/api/mappings', {
    method: 'POST',
    body: { ref: 'demo', url: 'https://stub.feishu.cn/base/y?table=t2&view=v2' },
  });
  const other = await waitForOperation('demo', 'map-table');
  assert.equal(other.status, 'completed', JSON.stringify(other.error));
  assert.equal(templateFiles().length, 2, '换表要另建一份 Template');
  assert.notEqual(other.result.template.template_id, first.template_id, '另一张表 = 另一个 Template ID');

  fs.rmSync(path.join(root, 'alt-base'), { force: true });
  await requestJson('/api/mappings', {
    method: 'POST',
    body: { ref: 'demo', url: 'https://stub.feishu.cn/base/x?table=t&view=v' },
  });
  const back = await waitForOperation('demo', 'map-table');
  assert.equal(back.status, 'completed', JSON.stringify(back.error));
  assert.equal(back.result.template.template_id, first.template_id, '同一张表应更新原来那一份');
  assert.equal(templateFiles().length, 2, '不该再多出第三份');
});

test('M3 Template 可以归档：列表消失、不可跑、可解冻，并记进 Operations', async () => {
  const list = await requestJson('/api/templates');
  const templateId = list.body.data[0].template_id;

  const archive = await requestJson(`/api/templates/${templateId}/archive`, { method: 'POST', body: {} });
  assert.equal(archive.response.status, 202, JSON.stringify(archive.body));
  const archived = await waitForOperationId(archive.body.data.operation_id);
  assert.equal(archived.status, 'completed', JSON.stringify(archived.error));

  const afterArchive = await requestJson('/api/templates');
  assert.ok(!afterArchive.body.data.some((item) => item.template_id === templateId), '归档后列表里不该还有它');
  const withArchived = await requestJson('/api/templates?scope=all');
  assert.ok(withArchived.body.data.some((item) => item.template_id === templateId && item.archived_at),
    '显式要全部时，归档的 Template 要能看到（列表页的 Show archived）');
  const detail = await requestJson(`/api/templates/${templateId}`);
  assert.equal(detail.response.status, 200, '按 Template ID 仍要能打开');
  assert.ok(detail.body.data.template.archived_at, '要带上归档时间');

  const started = await requestJson('/api/runs', {
    method: 'POST',
    body: { template_id: templateId, trigger: 'incremental' },
  });
  assert.equal(started.response.status, 202);
  const refused = await waitForRun(started.body.data.run_id);
  assert.equal(refused.status, 'failed', '归档的 Template 不能跑');
  assert.match(String(refused.error || ''), /archived/, '错误里要说清是被冻结了');

  const unarchive = await requestJson(`/api/templates/${templateId}/unarchive`, { method: 'POST', body: {} });
  const restored = await waitForOperationId(unarchive.body.data.operation_id);
  assert.equal(restored.status, 'completed', JSON.stringify(restored.error));
  const afterRestore = await requestJson('/api/templates');
  assert.ok(afterRestore.body.data.some((item) => item.template_id === templateId), '解冻后要回到列表');

  const operations = await requestJson('/api/operations');
  const types = operations.body.data.filter((item) => item.subject?.id === templateId).map((item) => item.type);
  assert.ok(types.includes('archive-template'), '归档要记进 Operations');
  assert.ok(types.includes('unarchive-template'), '解冻也要记进 Operations');
});

test('M3 全局操作流：连上先发快照，之后实时推单条操作', async () => {
  let started = null;
  const pushed = await readStreamFrames(
    '/api/operations/events',
    (event) => event.type === 'operation' && event.operation?.type === 'analyze-skill',
    {
      onOpen: async () => {
        started = await requestJson('/api/skills/demo/analyze', { method: 'POST', body: {} });
      },
    },
  );
  assert.equal(started.response.status, 202);
  assert.equal(pushed.operation.operation_id, started.body.data.operation_id, '推的应当是刚发起的那条');
  assert.ok(['queued', 'running', 'completed'].includes(pushed.operation.status), pushed.operation.status);
  assert.deepEqual(pushed.operation.subject, { type: 'skill', id: 'demo', label: 'demo' }, '摘要要带 subject 供列表跳转');
  await waitForOperationId(started.body.data.operation_id);

  const snapshot = await readStreamFrames('/api/operations/events', (event) => event.type === 'snapshot');
  assert.ok(Array.isArray(snapshot.operations), '快照要带一份操作列表');
  assert.ok(snapshot.operations.every((item) => 'operation_id' in item && 'status' in item), '快照里每条都是摘要');
});

test('M3 操作可以取消：已结束的原样返回，不存在的返回 404', async () => {
  const list = await requestJson('/api/operations');
  const finished = list.body.data.find((item) => item.status === 'completed');
  assert.ok(finished, '前面已经跑过操作，应当有已完成的记录');

  const again = await requestJson(`/api/operations/${finished.operation_id}/cancel`, { method: 'POST', body: {} });
  assert.equal(again.response.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.data.status, 'completed', '已结束的操作不会被改成 canceled');

  const missing = await requestJson('/api/operations/no-such-operation/cancel', { method: 'POST', body: {} });
  assert.equal(missing.response.status, 404);
});

test('M3 分析结果能标记 Skill 指纹过期，卸载会删除关联 Run', async () => {
  fs.appendFileSync(path.join(root, 'skills', 'demo', 'SKILL.md'), '\nchanged\n');
  const sourceFile = path.join(root, 'skills', 'demo', 'source.json');
  const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  source.hash = 'sha256:changed-after-reload';
  fs.writeFileSync(sourceFile, JSON.stringify(source, null, 2));
  const detail = await requestJson('/api/skills/demo');
  assert.equal(detail.body.data.analysis.state, 'stale');
  assert.equal(detail.body.data.analysis.stale, true);

  const templateFile = path.join(root, 'templates', fs.readdirSync(path.join(root, 'templates'))
    .find((name) => name.startsWith('demo-') && name.endsWith('.template.json')));
  const template = JSON.parse(fs.readFileSync(templateFile, 'utf8'));
  write('runs/run-demo/run.json', JSON.stringify({ run_id: 'run-demo', template_id: template.template_id, items: [] }));

  const remove = await requestJson('/api/skills/demo', { method: 'DELETE', body: {} });
  const removed = await waitForOperation('demo', 'unload');
  assert.equal(removed.status, 'completed', JSON.stringify(removed.error));
  assert.equal(fs.existsSync(path.join(root, 'skills', 'demo')), false);
  assert.equal(fs.existsSync(path.join(root, 'runs', 'run-demo')), false);
});
