'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { createServer } = require('../src/server/app');
const { skillHash } = require('../src/core/skill-hash');

const TOKEN = 'test-token';
const AUTH = `Basic ${Buffer.from(`skillapp:${TOKEN}`).toString('base64')}`;
const ROOT = path.resolve(__dirname, '..');

let root;
let server;
let baseUrl;

function write(relativePath, content) {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function templateFor(id, skill, cmd, outputs) {
  return {
    template_id: id,
    created_at: '2026-01-01T00:00:00+08:00',
    skill: { path: `skills/${skill}`, hash: skillHash(path.join(root, 'skills', skill)), entry: 'entry.js' },
    target: { base_token: 'base', table_id: 'table', view_id: 'view', primary_field_id: 'fldP' },
    mapping: {
      cmd,
      inputs: [],
      outputs,
    },
    limits: { timeout_s: 5, max_rows_per_run: 100 },
  };
}

function buildFixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillapp-web-m2-'));

  write('skills/ok/SKILL.md', '# ok\n');
  write('skills/ok/entry.js', 'process.stdout.write(JSON.stringify({ value: "ok" }) + "\\n");\n');
  write('skills/slow/SKILL.md', '# slow\n');
  write('skills/slow/entry.js', [
    "const fs = require('fs');",
    "const path = require('path');",
    "setTimeout(() => { fs.writeFileSync(path.join(process.cwd(), 'cancel-marker.txt'), 'done'); process.stdout.write(JSON.stringify({ value: 'slow' })); }, 1200);",
  ].join('\n'));
  write('skills/bad/SKILL.md', '# bad\n');
  write('skills/bad/entry.js', 'process.stdout.write("not json\\n");\n');

  write('templates/ok.json', JSON.stringify(templateFor(
    'tpl-ok', 'ok', 'node {skill.entry} -o {outdir}',
    [{ key: 'result', type: 'text', from: 'stdout.value', field_id: 'fldOut' }],
  ), null, 2));
  write('templates/slow.json', JSON.stringify(templateFor(
    'tpl-slow', 'slow', 'node {skill.entry} -o {outdir}',
    [{ key: 'result', type: 'text', from: 'stdout.value', field_id: 'fldOut' }],
  ), null, 2));
  write('templates/bad.json', JSON.stringify(templateFor(
    'tpl-bad', 'bad', 'node {skill.entry} -o {outdir}',
    [{ key: 'result', type: 'text', from: 'stdout.value', field_id: 'fldOut' }],
  ), null, 2));

  write('fake-lark.js', [
    "'use strict';",
    "const fields = [",
    "  { id: 'fldP', name: 'Task', type: 'text' },",
    "  { id: 'fldOut', name: 'out: Result', type: 'text' },",
    "];",
    "exports.lark = (args) => {",
    "  if (process.env.SKILLAPP_FAKE_LARK_AUTH_ERROR === '1') {",
    "    throw new Error('lark-cli base +field-list failed: ' + JSON.stringify({ ok: false, error: { type: 'authentication', subtype: 'token_missing', message: '需要用户授权', hint: 'run lark-cli auth login --scope base:field:read' } }));",
    "  }",
    "  const cmd = args[1];",
    "  if (cmd === '+field-list') return { ok: true, data: { fields } };",
    "  if (cmd === '+record-list') return { ok: true, data: { field_id_list: ['fldP'], record_id_list: ['rec-m2'], data: [['Task']] } };",
    "  if (cmd === '+record-batch-update') return { ok: true, data: {} };",
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

function readEvents(pathname, stop) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: pathname,
      method: 'GET',
      headers: { authorization: AUTH, accept: 'text/event-stream' },
    }, (response) => {
      let buffer = '';
      const frames = [];
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          frames.push(frame);
          if (stop(frame, frames)) {
            request.destroy();
            resolve(frames);
            return;
          }
        }
      });
      response.on('end', () => resolve(frames));
    });
    request.on('error', reject);
    request.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await check();
    if (predicate(value)) return value;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for condition; last value: ${JSON.stringify(value)}`);
}

before(async () => {
  buildFixture();
  process.env.SKILLAPP_LARK_MODULE = path.join(root, 'fake-lark.js');
  server = createServer({ root, token: TOKEN });
  await listen();
});

after(async () => {
  server.taskRunner.shutdown();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  delete process.env.SKILLAPP_LARK_MODULE;
  fs.rmSync(root, { recursive: true, force: true });
});

test('M2 预览并异步执行 Run，最终写入日志与状态', async () => {
  const preview = await requestJson('/api/runs/preview', {
    method: 'POST',
    body: { template_id: 'tpl-ok', trigger: 'pending' },
  });
  assert.equal(preview.response.status, 200);
  assert.equal(preview.body.data.total, 1);
  assert.equal(preview.body.data.selected, 1);

  const started = await requestJson('/api/runs', {
    method: 'POST',
    body: { template_id: 'tpl-ok', trigger: 'pending' },
  });
  assert.equal(started.response.status, 202);
  const runId = started.body.data.run_id;

  const finished = await waitFor(
    () => requestJson(`/api/runs/${runId}`),
    ({ body }) => ['completed', 'failed', 'partial'].includes(body.data.status),
  );
  assert.equal(finished.body.data.status, 'completed');
  assert.equal(finished.body.data.succeeded, 1);

  const events = await readEvents(`/api/runs/${runId}/events`, (frame) => frame.includes('event: done'));
  assert.ok(events.some((frame) => frame.includes('event: snapshot')));
});

test('M2 同一 Template 加锁，取消会终止执行且不会继续写表', async () => {
  const started = await requestJson('/api/runs', {
    method: 'POST',
    body: { template_id: 'tpl-slow', trigger: 'all' },
  });
  assert.equal(started.response.status, 202);
  const runId = started.body.data.run_id;

  const locked = await requestJson('/api/runs', {
    method: 'POST',
    body: { template_id: 'tpl-slow', trigger: 'all' },
  });
  assert.equal(locked.response.status, 409);
  assert.equal(locked.body.error.code, 'TEMPLATE_LOCKED');

  const streamPromise = readEvents(`/api/runs/${runId}/events`, (frame) => frame.includes('event: done'));
  await sleep(180);
  const cancelled = await requestJson(`/api/runs/${runId}/cancel`, { method: 'POST' });
  assert.equal(cancelled.response.status, 200);
  assert.equal(['canceling', 'canceled'].includes(cancelled.body.data.status), true);

  const finished = await waitFor(
    () => requestJson(`/api/runs/${runId}`),
    ({ body }) => body.data.status === 'canceled',
  );
  assert.equal(finished.body.data.status, 'canceled');
  await streamPromise;
  await sleep(900);
  assert.equal(fs.existsSync(path.join(root, 'skills', 'slow', 'cancel-marker.txt')), false);
});

test('M2 失败行可以重试为新的 Run', async () => {
  const started = await requestJson('/api/runs', {
    method: 'POST',
    body: { template_id: 'tpl-bad', trigger: 'all' },
  });
  const runId = started.body.data.run_id;
  await waitFor(
    () => requestJson(`/api/runs/${runId}`),
    ({ body }) => body.data.status === 'failed',
  );

  const retry = await requestJson(`/api/runs/${runId}/retry`, { method: 'POST' });
  assert.equal(retry.response.status, 202);
  assert.notEqual(retry.body.data.run_id, runId);
  assert.equal(retry.body.data.trigger, 'record-id');
});

test('M2 Preview 会返回可操作的 Lark 授权提示', async () => {
  process.env.SKILLAPP_FAKE_LARK_AUTH_ERROR = '1';
  try {
    const preview = await requestJson('/api/runs/preview', {
      method: 'POST',
      body: { template_id: 'tpl-ok', trigger: 'pending' },
    });
    assert.equal(preview.response.status, 424);
    assert.equal(preview.body.error.code, 'LARK_AUTH_REQUIRED');
    assert.match(preview.body.error.action, /lark-cli auth login/);
  } finally {
    delete process.env.SKILLAPP_FAKE_LARK_AUTH_ERROR;
  }
});
