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
    "  if (cmd === '+url-resolve') return { ok: true, data: { base_token: 'baseM3', table_id: 'tblM3', view_id: 'vewM3' } };",
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

test('M3 分析结果能标记 Skill 指纹过期，卸载会删除关联 Run', async () => {
  fs.appendFileSync(path.join(root, 'skills', 'demo', 'SKILL.md'), '\nchanged\n');
  const sourceFile = path.join(root, 'skills', 'demo', 'source.json');
  const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  source.hash = 'sha256:changed-after-reload';
  fs.writeFileSync(sourceFile, JSON.stringify(source, null, 2));
  const detail = await requestJson('/api/skills/demo');
  assert.equal(detail.body.data.analysis.state, 'stale');
  assert.equal(detail.body.data.analysis.stale, true);

  const templateFile = path.join(root, 'templates', 'demo.template.json');
  const template = JSON.parse(fs.readFileSync(templateFile, 'utf8'));
  write('runs/run-demo/run.json', JSON.stringify({ run_id: 'run-demo', template_id: template.template_id, items: [] }));

  const remove = await requestJson('/api/skills/demo', { method: 'DELETE', body: {} });
  const removed = await waitForOperation('demo', 'unload');
  assert.equal(removed.status, 'completed', JSON.stringify(removed.error));
  assert.equal(fs.existsSync(path.join(root, 'skills', 'demo')), false);
  assert.equal(fs.existsSync(path.join(root, 'runs', 'run-demo')), false);
});
