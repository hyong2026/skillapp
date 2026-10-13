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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillapp-web-m1-'));

  write('skills/foo/SKILL.md', '# foo\n');
  write('skills/foo/source.json', JSON.stringify({
    source: '/tmp/foo',
    hash: 'sha256:foo',
    loaded_at: '2026-01-01T00:00:00.000Z',
  }, null, 2));
  write('mappings/foo.mapping.json', JSON.stringify({
    skill: { entry: 'main.js' },
    cmd: 'node {skill.entry}',
    inputs: [{ key: 'text', label: '文本', type: 'text', required: true }],
    outputs: [{ key: 'result', label: '结果', type: 'text', from: 'stdout.value' }],
  }, null, 2));

  write('templates/foo.template.json', JSON.stringify({
    template_id: 'template-1',
    created_at: '2026-01-01T00:00:00+08:00',
    skill: { path: 'skills/foo', hash: 'sha256:foo', entry: 'main.js' },
    target: { base_token: 'base', table_id: 'table', view_id: 'view', primary_field_id: 'primary' },
    mapping: { cmd: 'node {skill.entry}', inputs: [{ key: 'text', field_id: 'in', type: 'text' }], outputs: [{ key: 'result', field_id: 'out', type: 'text', from: 'stdout.value' }] },
  }, null, 2));

  write('runs/run-1/run.json', JSON.stringify({
    run_id: 'run-1',
    template_id: 'template-1',
    status: 'completed',
    trigger: 'incremental',
    started_at: '2026-01-02T00:00:00.000Z',
    finished_at: '2026-01-02T00:00:01.000Z',
    succeeded: 1,
    failed: 0,
    work_hash: 'sha256:work',
    items: [{ record_id: 'rec-1', status: 'succeeded', stage: null, ms: 12, error: null, input_hash: 'input-1' }],
  }, null, 2));
  write('runs/run-1/rec-1/logs/stdout.json', JSON.stringify({ record_id: 'rec-1', stream: 'stdout', data: { value: 'ok' } }, null, 2));
  write('runs/run-1/rec-1/logs/stderr.json', JSON.stringify({ record_id: 'rec-1', stream: 'stderr', data: { raw: 'warn' } }, null, 2));
  write('runs/run-1/rec-1/artifacts/result.txt', 'artifact-ok\n');
  write('runs/run-1/rec-1/artifacts/nested/image.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');
  write('secret.txt', 'do-not-serve\n');
}

async function listen() {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

function rawGet(pathname) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: pathname,
      method: 'GET',
      headers: { authorization: AUTH },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body, headers: response.headers }));
    });
    request.on('error', reject);
    request.end();
  });
}

async function getJson(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { authorization: AUTH, ...(options.headers || {}) },
    method: options.method || 'GET',
  });
  const body = await response.json();
  return { response, body };
}

before(async () => {
  buildFixture();
  server = createServer({ root, token: TOKEN });
  await listen();
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

test('未登录请求被拒绝，并返回 Basic Auth 挑战', async () => {
  const response = await fetch(`${baseUrl}/api/status`);
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate'), /^Basic /);
});

test('状态接口返回运行模式和文件计数', async () => {
  const { response, body } = await getJson('/api/status');
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.readonly, false);
  assert.deepEqual(body.data.counts, {
    skills: 1,
    valid_skills: 1,
    templates: 1,
    runs: 1,
    failed_runs: 0,
  });
});

test('Skill 列表与详情返回指纹和分析产物', async () => {
  const list = await getJson('/api/skills');
  assert.equal(list.body.data[0].ref, 'foo');
  assert.equal(list.body.data[0].hash, 'sha256:foo');

  const detail = await getJson('/api/skills/foo');
  assert.equal(detail.body.data.analysis.mapping.inputs[0].key, 'text');
});

test('Template 列表与详情可按 template_id 查询', async () => {
  const list = await getJson('/api/templates');
  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.data[0].template_id, 'template-1');
  assert.equal(list.body.data[0].inputs, 1);

  const detail = await getJson('/api/templates/template-1');
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.data.template.target.table_id, 'table');
});

test('Run 列表、RunItem、日志和产物可读取', async () => {
  const list = await getJson('/api/runs');
  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.data[0].run_id, 'run-1');

  const run = await getJson('/api/runs/run-1');
  assert.equal(run.body.data.items[0].record_id, 'rec-1');

  const item = await getJson('/api/runs/run-1/items/rec-1');
  assert.equal(item.body.data.logs.stdout.data.value, 'ok');
  assert.equal(item.body.data.logs.stderr.data.raw, 'warn');
  assert.equal(item.body.data.artifacts.length, 2);
  assert.ok(item.body.data.artifacts.some((artifact) => artifact.path === 'nested/image.svg'));
});

test('产物可以读取，但路径穿越会被拒绝', async () => {
  const artifact = await fetch(`${baseUrl}/api/runs/run-1/artifacts/rec-1/result.txt`, {
    headers: { authorization: AUTH },
  });
  assert.equal(artifact.status, 200);
  assert.equal(await artifact.text(), 'artifact-ok\n');

  const traversal = await rawGet('/api/runs/run-1/artifacts/rec-1/%2e%2e%2fsecret.txt');
  assert.ok(traversal.status === 400 || traversal.status === 404, `unexpected traversal status: ${traversal.status}`);
});

test('静态控制台可访问', async () => {
  const page = await fetch(`${baseUrl}/`, { headers: { authorization: AUTH } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /SkillApp/);

  // 控制台是一组 ES 模块：入口与它 import 的模块都要能取到
  const script = await fetch(`${baseUrl}/app.js`, { headers: { authorization: AUTH } });
  assert.equal(script.status, 200);
  assert.match(await script.text(), /from '\.\/lib\/router\.js'/);

  for (const asset of [
    '/lib/router.js', '/lib/components.js', '/lib/dialogs.js', '/lib/dom.js', '/lib/format.js',
    '/lib/links.js', '/lib/api.js', '/lib/shell.js', '/lib/highlight.js',
    '/views/skills.js', '/views/templates.js', '/views/runs.js',
    '/views/run-item.js', '/views/operations.js', '/views/settings.js',
  ]) {
    const response = await fetch(`${baseUrl}${asset}`, { headers: { authorization: AUTH } });
    assert.equal(response.status, 200, `${asset} 应可访问`);
  }
});

test('未开放的写接口仍会被拒绝', async () => {
  const { response, body } = await getJson('/api/skills', { method: 'POST' });
  assert.equal(response.status, 405);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'METHOD_NOT_ALLOWED');
});
