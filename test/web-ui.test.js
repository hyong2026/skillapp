/**
 * web-ui.test.js — Web 控制台端到端测试
 *
 * 三组场景，各自起独立服务与 fixture，共用同一套请求工具：
 *   1. 只读面  鉴权、状态、列表与详情、产物读取（含路径穿越）、静态资源
 *   2. 执行面  Preview、Run、加锁与取消、重试、授权提示、Settings
 *   3. 生命周期 装载 → 分析 → 保存 Schema → 绑定 → 归档 → 操作流 / 取消 / 卸载
 *
 * 跑的是真实 HTTP + 真实 core：只有 lark-cli 与分析器换成 fixture。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { skillHash } from '../src/core/skill-hash.js';
import { createServer } from '../src/server/app.js';
import { TaskRunner } from '../src/server/task-runner.js';

const TOKEN = 'test-token';
const AUTH = `Basic ${Buffer.from(`skillapp:${TOKEN}`).toString('base64')}`;
// 操作别名 → operation type（waitForOperation 用）
const OPERATION_TYPES = { load: 'load-skill', analyze: 'analyze-skill', 'bind-table': 'bind-table', unload: 'unload-skill' };

/** 每组 describe 一个 ctx：root 是临时数据根，server / baseUrl 由 listen() 填。 */
function write(ctx, relativePath, content) {
  const file = path.join(ctx.root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

async function listen(ctx) {
  await new Promise((resolve, reject) => {
    ctx.server.once('error', reject);
    ctx.server.listen(0, '127.0.0.1', resolve);
  });
  ctx.baseUrl = `http://127.0.0.1:${ctx.server.address().port}`;
}

async function requestJson(ctx, pathname, options = {}) {
  const hasBody = options.body !== undefined;
  const response = await fetch(`${ctx.baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers: {
      authorization: AUTH,
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json();
  return { response, body };
}

/** 列表现在是服务端分页：要跨页找一条记录时，把每一页拼起来（页数由 total / page_size 定）。 */
async function listAll(ctx, pathname) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const { body } = await requestJson(ctx, `${pathname}${pathname.includes('?') ? '&' : '?'}page=${page}`);
    items.push(...body.data.items);
    if (page >= Math.ceil(body.data.total / body.data.page_size)) return items;
  }
}

/** 用 http.request 直发，保留编码过的路径（验证路径穿越要靠它）。 */
function rawGet(ctx, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: ctx.server.address().port,
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

/** 读 SSE 原始帧，直到 stop(frame) 为真。 */
function readEvents(ctx, pathname, stop) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: ctx.server.address().port,
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

/** 读 SSE 直到出现满足 predicate 的帧，返回那个已解析的 event。 */
async function readStreamFrames(ctx, pathname, predicate, { timeoutMs = 8000, onOpen = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${ctx.baseUrl}${pathname}`, {
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function waitForRun(ctx, runId, timeoutMs = 15000) {
  return waitFor(
    () => requestJson(ctx, `/api/runs/${runId}`),
    ({ body }) => ['completed', 'failed', 'partial', 'canceled', 'interrupted'].includes(body.data.status),
    timeoutMs,
  ).then(({ body }) => body.data);
}

async function waitForOperationId(ctx, operationId) {
  return waitFor(
    () => requestJson(ctx, `/api/operations/${operationId}`),
    ({ body }) => ['completed', 'failed', 'canceled', 'interrupted'].includes(body.data.status),
  ).then(({ body }) => body.data);
}

/** 列表里认出「最新一条该类型、且属于这个 Skill」的操作，再轮询它的详情直到终结。 */
async function waitForOperation(ctx, ref, alias) {
  const type = OPERATION_TYPES[alias] || alias;
  const deadline = Date.now() + 8000;
  let target = null;
  while (Date.now() < deadline) {
    if (target) {
      const detail = await requestJson(ctx, `/api/operations/${target.operation_id}`);
      if (!detail.response.ok) throw new Error(JSON.stringify(detail.body));
      target = detail.body.data.operation;
    } else {
      const list = await requestJson(ctx, `/api/operations?type=${type}`);
      if (!list.response.ok) throw new Error(JSON.stringify(list.body));
      for (const candidate of list.body.data.items) {
        const detail = await requestJson(ctx, `/api/operations/${candidate.operation_id}`);
        if (!detail.response.ok) continue;
        const operation = detail.body.data.operation;
        if (operation.input?.ref === ref) { target = operation; break; }
      }
    }
    if (target && ['completed', 'failed', 'canceled', 'interrupted'].includes(target.status)) return target;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${alias} on ${ref}`);
}

describe('只读面：鉴权、状态、列表与详情、产物、静态资源', () => {
  const ctx = { root: null, server: null, baseUrl: null };

  function buildFixture() {
    ctx.root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillapp-web-m1-'));

    write(ctx, 'skills/foo/SKILL.md', '# foo\n');
    write(ctx, 'skills/foo/source.json', JSON.stringify({
      source: '/tmp/foo',
      hash: 'sha256:foo',
      loaded_at: '2026-01-01T00:00:00.000Z',
    }, null, 2));
    write(ctx, 'mappings/foo.mapping.json', JSON.stringify({
      skill: { entry: 'main.js' },
      cmd: 'node {skill.entry}',
      inputs: [{ key: 'text', label: '文本', type: 'text', required: true }],
      outputs: [{ key: 'result', label: '结果', type: 'text', from: 'stdout.value' }],
    }, null, 2));

    write(ctx, 'templates/foo.template.json', JSON.stringify({
      template_id: 'template-1',
      created_at: '2026-01-01T00:00:00+08:00',
      skill: { path: 'skills/foo', hash: 'sha256:foo', entry: 'main.js' },
      target: { base_token: 'base', table_id: 'table', view_id: 'view', primary_field_id: 'primary' },
      mapping: { cmd: 'node {skill.entry}', inputs: [{ key: 'text', field_id: 'in', type: 'text' }], outputs: [{ key: 'result', field_id: 'out', type: 'text', from: 'stdout.value' }] },
    }, null, 2));

    write(ctx, 'runs/run-1/run.json', JSON.stringify({
      run_id: 'run-1',
      template_id: 'template-1',
      template_name: 'foo',
      status: 'completed',
      trigger: 'incremental',
      started_at: '2026-01-02T00:00:00.000Z',
      finished_at: '2026-01-02T00:00:01.000Z',
      succeeded: 1,
      failed: 0,
      work_hash: 'sha256:work',
      items: [{ record_id: 'rec-1', status: 'succeeded', stage: null, ms: 12, error: null, input_hash: 'input-1' }],
    }, null, 2));
    write(ctx, 'runs/run-1/rec-1/logs/stdout.log', 'ok\n');
    // 早期 Run 的日志是 JSON 包装，读旧格式时应取出其中的文本
    write(ctx, 'runs/run-1/rec-1/logs/stderr.json', JSON.stringify({ record_id: 'rec-1', stream: 'stderr', data: { raw: 'warn' } }, null, 2));
    write(ctx, 'runs/run-1/rec-1/artifacts/result.txt', 'artifact-ok\n');
    write(ctx, 'runs/run-1/rec-1/artifacts/nested/image.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');
    write(ctx, 'secret.txt', 'do-not-serve\n');
  }

  before(async () => {
    buildFixture();
    ctx.server = createServer({ root: ctx.root, token: TOKEN });
    await listen(ctx);
  });

  after(async () => {
    await new Promise((resolve) => ctx.server.close(resolve));
    fs.rmSync(ctx.root, { recursive: true, force: true });
  });

  test('会被拒绝的请求：未登录 401（带 Basic 挑战）、未开放的写方法 405', async () => {
    const unauthorized = await fetch(`${ctx.baseUrl}/api/status`);
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get('www-authenticate'), /^Basic /);

    const { response, body } = await requestJson(ctx, '/api/skills', { method: 'PUT' });
    assert.equal(response.status, 405);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'METHOD_NOT_ALLOWED');
  });

  test('状态接口返回运行模式和文件计数', async () => {
    const { response, body } = await requestJson(ctx, '/api/status');
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
    const list = await requestJson(ctx, '/api/skills');
    assert.equal(list.body.data.items[0].ref, 'foo');
    assert.equal(list.body.data.items[0].hash, 'sha256:foo');

    const detail = await requestJson(ctx, '/api/skills/foo');
    assert.equal(detail.body.data.analysis.mapping.inputs[0].key, 'text');
  });

  test('Template 列表与详情可按 template_id 查询', async () => {
    const list = await requestJson(ctx, '/api/templates');
    assert.equal(list.body.data.items.length, 1);
    assert.equal(list.body.data.items[0].template_id, 'template-1');
    assert.equal(list.body.data.items[0].inputs, 1);

    const detail = await requestJson(ctx, '/api/templates/template-1');
    assert.equal(detail.response.status, 200);
    assert.equal(detail.body.data.template.target.table_id, 'table');
  });

  test('Run 列表、RunItem、日志和产物可读取', async () => {
    const list = await requestJson(ctx, '/api/runs');
    assert.equal(list.body.data.items.length, 1);
    assert.equal(list.body.data.items[0].run_id, 'run-1');
    assert.equal(list.body.data.items[0].template_name, 'foo', 'Run 列表要能反查到 Template Name');

    const run = await requestJson(ctx, '/api/runs/run-1');
    assert.equal(run.body.data.items[0].record_id, 'rec-1');

    const item = await requestJson(ctx, '/api/runs/run-1/items/rec-1');
    assert.equal(item.body.data.logs.stdout, 'ok\n');
    assert.equal(item.body.data.logs.stderr, 'warn');
    assert.equal(item.body.data.artifacts.length, 2);
    assert.ok(item.body.data.artifacts.some((artifact) => artifact.path === 'nested/image.svg'));
  });

  test('产物可以读取，但路径穿越会被拒绝', async () => {
    const artifact = await fetch(`${ctx.baseUrl}/api/runs/run-1/artifacts/rec-1/result.txt`, {
      headers: { authorization: AUTH },
    });
    assert.equal(artifact.status, 200);
    assert.equal(await artifact.text(), 'artifact-ok\n');

    const traversal = await rawGet(ctx, '/api/runs/run-1/artifacts/rec-1/%2e%2e%2fsecret.txt');
    assert.ok(traversal.status === 400 || traversal.status === 404, `unexpected traversal status: ${traversal.status}`);
  });

  test('静态控制台可访问', async () => {
    const page = await fetch(`${ctx.baseUrl}/`, { headers: { authorization: AUTH } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /SkillApp/);

    // 控制台是一组 ES 模块：入口与它 import 的模块都要能取到
    const script = await fetch(`${ctx.baseUrl}/app.js`, { headers: { authorization: AUTH } });
    assert.equal(script.status, 200);
    assert.match(await script.text(), /from '\.\/lib\/router\.js'/);

    for (const asset of [
      '/lib/router.js', '/lib/components.js', '/lib/dialogs.js', '/lib/dom.js', '/lib/format.js',
      '/lib/links.js', '/lib/api.js', '/lib/shell.js', '/lib/highlight.js',
      '/views/skills.js', '/views/templates.js', '/views/runs.js',
      '/views/run-item.js', '/views/operations.js', '/views/settings.js',
    ]) {
      const response = await fetch(`${ctx.baseUrl}${asset}`, { headers: { authorization: AUTH } });
      assert.equal(response.status, 200, `${asset} 应可访问`);
    }
  });

});

describe('执行面：Preview、Run、加锁取消、重试、授权提示、Settings', () => {
  const ctx = { root: null, server: null, baseUrl: null };

  const ROOT = path.resolve(import.meta.dirname, '..');

  function templateFor(id, skill, cmd, outputs) {
    return {
      template_id: id,
      created_at: '2026-01-01T00:00:00+08:00',
      skill: { path: `skills/${skill}`, hash: skillHash(path.join(ctx.root, 'skills', skill)), entry: 'entry.js' },
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
    ctx.root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillapp-web-m2-'));

    write(ctx, 'skills/ok/SKILL.md', '# ok\n');
    write(ctx, 'skills/ok/entry.js', 'process.stdout.write(JSON.stringify({ value: "ok" }) + "\\n");\n');
    write(ctx, 'skills/slow/SKILL.md', '# slow\n');
    write(ctx, 'skills/slow/entry.js', [
      "const fs = require('fs');",
      "const path = require('path');",
      "setTimeout(() => { fs.writeFileSync(path.join(__dirname, 'cancel-marker.txt'), 'done'); process.stdout.write(JSON.stringify({ value: 'slow' })); }, 1200);",
    ].join('\n'));
    write(ctx, 'skills/bad/SKILL.md', '# bad\n');
    write(ctx, 'skills/bad/entry.js', 'process.stdout.write("not json\\n");\n');

    write(ctx, 'templates/ok.template.json', JSON.stringify(templateFor(
      'tpl-ok', 'ok', 'node {skill.entry} -o {outdir}',
      [{ key: 'result', type: 'text', from: 'stdout.value', field_id: 'fldOut' }],
    ), null, 2));
    write(ctx, 'templates/slow.template.json', JSON.stringify(templateFor(
      'tpl-slow', 'slow', 'node {skill.entry} -o {outdir}',
      [{ key: 'result', type: 'text', from: 'stdout.value', field_id: 'fldOut' }],
    ), null, 2));
    write(ctx, 'templates/bad.template.json', JSON.stringify(templateFor(
      'tpl-bad', 'bad', 'node {skill.entry} -o {outdir}',
      [{ key: 'result', type: 'text', from: 'stdout.value', field_id: 'fldOut' }],
    ), null, 2));
    // cmd 模板写错的：整块花括号但不成形，运行前就该被拒
    write(ctx, 'templates/broken.template.json', JSON.stringify(templateFor(
      'tpl-broken', 'ok', 'node {skill.entry} "{--format}"',
      [{ key: 'result', type: 'text', from: 'stdout.value', field_id: 'fldOut' }],
    ), null, 2));

    write(ctx, 'fake-lark.js', [
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

  before(async () => {
    buildFixture();
    process.env.SKILLAPP_LARK_MODULE = path.join(ctx.root, 'fake-lark.js');
    ctx.server = createServer({ root: ctx.root, token: TOKEN });
    await listen(ctx);
  });

  after(async () => {
    ctx.server.taskRunner.shutdown();
    ctx.server.closeAllConnections?.();
    await new Promise((resolve) => ctx.server.close(resolve));
    delete process.env.SKILLAPP_LARK_MODULE;
    fs.rmSync(ctx.root, { recursive: true, force: true });
  });

  test('M2 预览并异步执行 Run，最终写入日志与状态', async () => {
    const preview = await requestJson(ctx, '/api/templates/tpl-ok/preview', {
      method: 'POST',
      body: { trigger: 'incremental' },
    });
    assert.equal(preview.response.status, 200);
    assert.equal(preview.body.data.total, 1);
    assert.equal(preview.body.data.selected, 1);

    const started = await requestJson(ctx, '/api/runs', {
      method: 'POST',
      body: { template_id: 'tpl-ok', trigger: 'incremental' },
    });
    assert.equal(started.response.status, 202);
    const runId = started.body.data.run_id;

    const finished = await waitFor(
      () => requestJson(ctx, `/api/runs/${runId}`),
      ({ body }) => ['completed', 'failed', 'partial'].includes(body.data.status),
    );
    assert.equal(finished.body.data.status, 'completed', JSON.stringify(finished.body.data.error));
    assert.equal(finished.body.data.succeeded, 1);
    assert.equal(finished.body.data.template_name, 'ok', 'Template Name 在发起时就写进 run.json');

    const events = await readEvents(ctx, `/api/runs/${runId}/events`, (frame) => frame.includes('event: done'));
    assert.ok(events.some((frame) => frame.includes('event: snapshot')));

    // Run 同时落一份 operation 镜像，Operations 页才能统一列出所有长期任务
    const operations = await requestJson(ctx, '/api/operations?type=execute-template');
    assert.equal(operations.response.status, 200);
    assert.ok(operations.body.data.items.every((item) => item.type === 'execute-template'), 'type 过滤在服务端做');
    const runOperation = operations.body.data.items.find((item) => item.subject?.id === runId);
    assert.ok(runOperation, 'Run 应该有对应的 operation 记录');
    assert.equal(runOperation.status, 'completed');
    assert.equal(runOperation.trigger, 'incremental');

    const operation = await requestJson(ctx, `/api/operations/${runOperation.operation_id}`);
    assert.equal(operation.response.status, 200);
    assert.equal(operation.body.data.operation.type, 'execute-template');
    assert.equal(operation.body.data.operation.input.run_id, runId);
    assert.equal(operation.body.data.operation.result.total, 1);

    // Runs 列表也支持服务端 Trigger 过滤（列表页的 Trigger 下拉）。
    const incremental = await requestJson(ctx, '/api/runs?trigger=incremental');
    assert.ok(incremental.body.data.items.length > 0);
    assert.ok(incremental.body.data.items.every((run) => run.trigger === 'incremental'));
    const allOnly = await requestJson(ctx, '/api/runs?trigger=all');
    assert.ok(allOnly.body.data.items.every((run) => run.trigger === 'all'));
  });

  test('M2 Run 可以逻辑删除：默认列表不出现、文件保留，Operations 里留下 delete-run', async () => {
    const started = await requestJson(ctx, '/api/runs', {
      method: 'POST',
      body: { template_id: 'tpl-ok', trigger: 'incremental' },
    });
    const runId = started.body.data.run_id;
    await waitForRun(ctx, runId);

    const removed = await requestJson(ctx, `/api/runs/${runId}`, { method: 'DELETE' });
    assert.equal(removed.response.status, 202, JSON.stringify(removed.body));
    const operation = await waitForOperationId(ctx, removed.body.data.operation_id);
    assert.equal(operation.status, 'completed', JSON.stringify(operation.error));

    // 逻辑删除：列表里默认消失，但详情照样打得开（Message / Operations 里的链接不会断）。
    const detail = await requestJson(ctx, `/api/runs/${runId}`);
    assert.equal(detail.response.status, 200, '逻辑删除后 Run 详情仍可访问');
    assert.ok(detail.body.data.deleted_at, '要打上 deleted_at');
    assert.equal(fs.existsSync(path.join(ctx.root, 'runs', runId, 'run.json')), true, '文件保留，不释放磁盘');

    const list = await requestJson(ctx, '/api/runs');
    assert.ok(!list.body.data.items.some((run) => run.run_id === runId), '默认列表里不该再有它');
    const withDeleted = await requestJson(ctx, '/api/runs?include_deleted=1');
    assert.ok(
      withDeleted.body.data.items.some((run) => run.run_id === runId && run.deleted_at),
      'Show Deleted 时才连它一起给',
    );

    const ops = await requestJson(ctx, '/api/operations?type=delete-run');
    const row = ops.body.data.items.find((item) => item.subject?.id === runId);
    assert.ok(row, 'delete-run 要记进 Operations');
    assert.equal(row.subject.type, 'run');
    assert.equal(row.subject.label, runId, 'Message / Subject 显示 Run ID');

    const missing = await requestJson(ctx, '/api/runs/no-such-run', { method: 'DELETE' });
    assert.equal(missing.response.status, 404);
  });

  test('M2 服务重启：Run 中断时，还挂在 running / queued 的行也一起落终态', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillapp-recover-'));
    const runDir = path.join(root, 'runs', 'run-1');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
      run_id: 'run-1',
      template_id: 'tpl',
      status: 'running',
      total: 2,
      completed: 1,
      succeeded: 1,
      failed: 0,
      items: [{ record_id: 'rec1', status: 'succeeded' }, { record_id: 'rec2', status: 'running' }],
    }, null, 2));

    new TaskRunner({ root, repoRoot: ROOT }); // 构造函数里就会核对一遍 .data/runs
    const after = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    assert.equal(after.status, 'interrupted');
    assert.deepEqual(after.items.map((item) => item.status), ['succeeded', 'interrupted'], '明细跟着 Run 落终态');
    assert.equal(after.completed, 2, '计数按收敛后的明细重算');
    assert.equal(after.failed, 0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('M2 cmd 模板写错：Preview / Run 都在开跑前拒绝，不产生半截的 Failed Run', async () => {
    const preview = await requestJson(ctx, '/api/templates/tpl-broken/preview', {
      method: 'POST',
      body: { trigger: 'incremental' },
    });
    assert.equal(preview.response.status, 422);
    assert.match(preview.body.error.message, /malformed placeholder: \{--format\}/);

    const started = await requestJson(ctx, '/api/runs', {
      method: 'POST',
      body: { template_id: 'tpl-broken', trigger: 'incremental' },
    });
    assert.equal(started.response.status, 422, JSON.stringify(started.body));
    assert.equal(started.body.error.code, 'TEMPLATE_NOT_RUNNABLE');
    assert.match(started.body.error.action, /Fix the Template/);

    // 拒绝发生在起 worker 之前：磁盘上不该留下这条 Template 的任何 Run
    const runs = await requestJson(ctx, '/api/runs');
    assert.ok(!runs.body.data.items.some((run) => run.template_id === 'tpl-broken'), '不该留下 Failed 的 Run');
    const leftOver = fs.readdirSync(path.join(ctx.root, 'runs')).filter((name) => {
      const file = path.join(ctx.root, 'runs', name, 'run.json');
      return fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).template_id === 'tpl-broken';
    });
    assert.deepEqual(leftOver, [], '连 Run 目录都不该建出来');
  });

  test('M2 同一 Template 加锁，取消会终止执行且不会继续写表', async () => {
    const started = await requestJson(ctx, '/api/runs', {
      method: 'POST',
      body: { template_id: 'tpl-slow', trigger: 'all' },
    });
    assert.equal(started.response.status, 202);
    const runId = started.body.data.run_id;

    const locked = await requestJson(ctx, '/api/runs', {
      method: 'POST',
      body: { template_id: 'tpl-slow', trigger: 'all' },
    });
    assert.equal(locked.response.status, 409);
    assert.equal(locked.body.error.code, 'TEMPLATE_LOCKED');

    const streamPromise = readEvents(ctx, `/api/runs/${runId}/events`, (frame) => frame.includes('event: done'));
    await sleep(180);
    const cancelled = await requestJson(ctx, `/api/runs/${runId}/cancel`, { method: 'POST' });
    assert.equal(cancelled.response.status, 200);
    assert.equal(['canceling', 'canceled'].includes(cancelled.body.data.status), true);

    const finished = await waitFor(
      () => requestJson(ctx, `/api/runs/${runId}`),
      ({ body }) => body.data.status === 'canceled',
    );
    assert.equal(finished.body.data.status, 'canceled');
    // Run 落了终态，明细也得跟着落：不能留下一个永远 Running 的行
    assert.deepEqual(
      finished.body.data.items.map((item) => item.status),
      ['canceled'],
      '取消时行与 Run 一起落终态',
    );
    await streamPromise;
    await sleep(900);
    assert.equal(fs.existsSync(path.join(ctx.root, 'skills', 'slow', 'cancel-marker.txt')), false);
  });

  test('M2 失败行可以重试为新的 Run', async () => {
    const started = await requestJson(ctx, '/api/runs', {
      method: 'POST',
      body: { template_id: 'tpl-bad', trigger: 'all' },
    });
    const runId = started.body.data.run_id;
    await waitFor(
      () => requestJson(ctx, `/api/runs/${runId}`),
      ({ body }) => body.data.status === 'failed',
    );

    const retry = await requestJson(ctx, `/api/runs/${runId}/retry`, { method: 'POST' });
    assert.equal(retry.response.status, 202);
    assert.notEqual(retry.body.data.run_id, runId);
    assert.equal(retry.body.data.trigger, 'incremental', '重试 = 再跑一次增量');

    const retried = await waitFor(
      () => requestJson(ctx, `/api/runs/${retry.body.data.run_id}`),
      ({ body }) => ['completed', 'failed', 'partial'].includes(body.data.status),
    );
    assert.equal(retried.body.data.total, 1, '失败行会被增量重新捞出，不需要 record-id');
  });

  test('M2 Preview 会返回可操作的 Lark 授权提示', async () => {
    process.env.SKILLAPP_FAKE_LARK_AUTH_ERROR = '1';
    try {
      const preview = await requestJson(ctx, '/api/templates/tpl-ok/preview', {
        method: 'POST',
        body: { trigger: 'incremental' },
      });
      assert.equal(preview.response.status, 424);
      assert.equal(preview.body.error.code, 'LARK_AUTH_REQUIRED');
      assert.match(preview.body.error.action, /lark-cli auth login/);
    } finally {
      delete process.env.SKILLAPP_FAKE_LARK_AUTH_ERROR;
    }
  });

  test('M2 Settings 只开放白名单环境变量，写入 .env 并即时生效', async () => {
    const previousRoot = process.env.SKILLAPP_ROOT;
    const previousModel = process.env.SKILLAPP_ANALYZE_MODEL;
    const previousPageSize = process.env.SKILLAPP_PAGE_SIZE;
    process.env.SKILLAPP_ROOT = ctx.root;
    delete process.env.SKILLAPP_ANALYZE_MODEL;
    try {
      const initial = await requestJson(ctx, '/api/settings');
      assert.equal(initial.response.status, 200);
      assert.ok(initial.body.data.editable.some((field) => field.key === 'SKILLAPP_ANALYZE_MODEL'));
      assert.ok(initial.body.data.readonly.some((field) => field.key === 'SKILLAPP_WEB_TOKEN'));
      assert.equal(initial.body.data.runtime.token_required, true);

      const saved = await requestJson(ctx, '/api/settings', {
        method: 'PUT',
        body: { values: { SKILLAPP_ANALYZE_MODEL: 'test/model', SKILLAPP_ANALYZE_REASONING_EFFORT: 'high' } },
      });
      assert.equal(saved.response.status, 200);
      assert.equal(saved.body.data.editable.find((field) => field.key === 'SKILLAPP_ANALYZE_MODEL').value, 'test/model');
      assert.equal(process.env.SKILLAPP_ANALYZE_MODEL, 'test/model', '白名单变量应即时生效');

      const envFile = fs.readFileSync(path.join(ctx.root, '.env'), 'utf8');
      assert.match(envFile, /SKILLAPP_ANALYZE_MODEL=test\/model/);
      assert.match(envFile, /SKILLAPP_ANALYZE_REASONING_EFFORT=high/);

      // 每页条数也在这个白名单里：服务端每次请求读一次，改完下一次取页就按新页长切。
      assert.ok(initial.body.data.editable.some((field) => field.key === 'SKILLAPP_PAGE_SIZE'));
      await requestJson(ctx, '/api/settings', { method: 'PUT', body: { values: { SKILLAPP_PAGE_SIZE: '1' } } });
      const paged = await requestJson(ctx, '/api/runs');
      assert.equal(paged.body.data.page_size, 1, 'SKILLAPP_PAGE_SIZE 即时生效');

      const rejected = await requestJson(ctx, '/api/settings', {
        method: 'PUT',
        body: { values: { SKILLAPP_WEB_TOKEN: 'nope' } },
      });
      assert.equal(rejected.response.status, 400);
      assert.equal(rejected.body.error.code, 'INVALID_SETTINGS');
    } finally {
      if (previousRoot === undefined) delete process.env.SKILLAPP_ROOT;
      else process.env.SKILLAPP_ROOT = previousRoot;
      if (previousModel === undefined) delete process.env.SKILLAPP_ANALYZE_MODEL;
      else process.env.SKILLAPP_ANALYZE_MODEL = previousModel;
      if (previousPageSize === undefined) delete process.env.SKILLAPP_PAGE_SIZE;
      else process.env.SKILLAPP_PAGE_SIZE = previousPageSize;
    }
  });
});

describe('生命周期：装载 → 分析 → 保存 Schema → 绑定 → 归档 → 操作流', () => {
  const ctx = { root: null, server: null, baseUrl: null };

  function buildFixture() {
    ctx.root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillapp-web-m3-'));
    write(ctx, 'demo/SKILL.md', '# Demo Skill\n');
    write(ctx, 'demo/entry.js', 'console.log(JSON.stringify({ value: "ok" }));\n');
    write(ctx, 'fake-analyzer.js', [
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
    write(ctx, 'fake-lark.js', [
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

  /** 按 operation_id 等一个操作结束（归档这类不再挂在 Skill 别名下）。 */
  /** 读 SSE 直到出现满足条件的帧（验证全局操作流用）。 */

  // 操作详情走通用端点：列表里认出「最新一条该类型、且属于这个 Skill」的操作，
  // 再轮询它的详情直到终结（详情的 operation 里带 result）。
  const OPERATION_TYPES = { load: 'load-skill', analyze: 'analyze-skill', 'bind-table': 'bind-table', unload: 'unload-skill' };

  before(async () => {
    buildFixture();
    process.env.SKILLAPP_LARK_MODULE = path.join(ctx.root, 'fake-lark.js');
    process.env.SKILLAPP_ANALYZE_COMMAND = process.execPath;
    process.env.SKILLAPP_ANALYZE_ARGS = JSON.stringify([path.join(ctx.root, 'fake-analyzer.js')]);
    ctx.server = createServer({ root: ctx.root, token: TOKEN });
    await listen(ctx);
  });

  after(async () => {
    ctx.server.taskRunner.shutdown();
    ctx.server.closeAllConnections?.();
    await new Promise((resolve) => ctx.server.close(resolve));
    delete process.env.SKILLAPP_LARK_MODULE;
    delete process.env.SKILLAPP_ANALYZE_COMMAND;
    delete process.env.SKILLAPP_ANALYZE_ARGS;
    fs.rmSync(ctx.root, { recursive: true, force: true });
  });

  test('M3 可以通过 Web API 装载 Skill、保存 Mapping 并生成 Template', async () => {
    const load = await requestJson(ctx, '/api/skills', {
      method: 'POST',
      body: { source_path: path.join(ctx.root, 'demo') },
    });
    assert.equal(load.response.status, 202);
    const loaded = await waitForOperation(ctx, 'demo', 'load');
    assert.equal(loaded.status, 'completed', JSON.stringify(loaded.error));
    assert.equal(fs.existsSync(path.join(ctx.root, 'skills', 'demo', 'SKILL.md')), true);
    const loadedSkill = await requestJson(ctx, '/api/skills/demo');
    assert.equal(loadedSkill.body.data.status, 'unanalyzed');

    const analyzed = await requestJson(ctx, '/api/skills/demo/analyze', { method: 'POST', body: {} });
    const active = await requestJson(ctx, '/api/skills/demo');
    assert.equal(active.body.data.status, 'analyzing');
    assert.equal(active.body.data.operations.analyze.operation_id, analyzed.body.data.operation_id);
    const analysisOperation = await waitForOperation(ctx, 'demo', 'analyze');
    assert.equal(analysisOperation.status, 'completed', JSON.stringify(analysisOperation.error));
    const analyzedSkill = await requestJson(ctx, '/api/skills/demo');
    assert.equal(analyzedSkill.body.data.analysis.state, 'current');
    assert.equal(analyzedSkill.body.data.status, 'ready');

    const schema = {
      skill: { entry: 'entry.js' },
      cmd: 'node {skill.entry} -o {outdir}',
      inputs: [{ key: 'title', label: 'Title', type: 'text', required: true }],
      outputs: [{ key: 'result', label: 'Result', type: 'text', from: 'stdout.value' }],
    };
    const saved = await requestJson(ctx, '/api/skills/demo/schema', {
      method: 'PUT',
      body: { mapping: schema },
    });
    assert.equal(saved.response.status, 200);
    assert.match(saved.body.data.mapping.skill_hash, /^sha256:/);

    const apply = await requestJson(ctx, '/api/skills/demo/bind', {
      method: 'POST',
      body: { url: 'https://stub.feishu.cn/base/x?table=t&view=v' },
    });
    const applied = await waitForOperation(ctx, 'demo', 'bind-table');

    assert.equal(applied.status, 'completed', JSON.stringify(applied.error));
    const templateId = applied.result.template.template_id;
    const template = await requestJson(ctx, `/api/templates/${templateId}`);
    assert.equal(template.response.status, 200);
    assert.equal(template.body.data.template.mapping.inputs[0].type, 'text');
    assert.equal(template.body.data.template.mapping.outputs[0].from, 'stdout.value');

    const remap = await requestJson(ctx, '/api/skills/demo/bind', {
      method: 'POST',
      body: { url: 'https://stub.feishu.cn/base/x?table=t&view=v' },
    });
    const remapped = await waitForOperation(ctx, 'demo', 'bind-table');
    assert.equal(remapped.status, 'completed', JSON.stringify(remapped.error));
  });

  test('M3 重新分析会保留「未映射」的勾选，但未映射的条目不进 Template', async () => {
    const before = await requestJson(ctx, '/api/skills/demo');
    const mapping = before.body.data.analysis.mapping;
    const saved = await requestJson(ctx, '/api/skills/demo/schema', {
      method: 'PUT',
      body: { mapping: { ...mapping, outputs: mapping.outputs.map((spec) => ({ ...spec, mapped: false })) } },
    });
    assert.equal(saved.response.status, 200, JSON.stringify(saved.body));

    await requestJson(ctx, '/api/skills/demo/analyze', { method: 'POST', body: {} });
    const reanalyzed = await waitForOperation(ctx, 'demo', 'analyze');
    assert.equal(reanalyzed.status, 'completed', JSON.stringify(reanalyzed.error));

    const after = await requestJson(ctx, '/api/skills/demo');
    const outputs = after.body.data.analysis.mapping.outputs;
    assert.equal(outputs.length, 1, '新分析的结果应当保留');
    assert.equal(outputs[0].mapped, false, '重分析不该丢掉未映射的勾选');

    await requestJson(ctx, '/api/skills/demo/bind', {
      method: 'POST',
      body: { url: 'https://stub.feishu.cn/base/x?table=t&view=v' },
    });
    const applied = await waitForOperation(ctx, 'demo', 'bind-table');
    assert.equal(applied.status, 'completed', JSON.stringify(applied.error));
    assert.deepEqual(applied.result.template.mapping.outputs, [], '未映射的输出不写进 Template');
    assert.ok(applied.result.order.includes('IN: Title (必填)'), '必填输入照常建列');
    assert.ok(!applied.result.order.includes('OUT: Result'), '未映射的输出不建列');
  });

  test('M3 换一张表会另建 Template，回到原表只更新原来那一份', async () => {
    const templateFiles = () => fs.readdirSync(path.join(ctx.root, 'templates')).filter((name) => name.endsWith('.template.json'));
    const list = await requestJson(ctx, '/api/templates');
    const first = list.body.data.items[0];
    assert.match(templateFiles()[0], /^demo-[0-9a-f]{8}\.template\.json$/, '文件名 = Skill 名 + 8 位 Hash');
    assert.equal(first.name, templateFiles()[0].replace('.template.json', ''), 'Template Name 就是文件名');
    assert.equal(first.ref, 'demo', 'ref 仍是 Skill 名');

    fs.writeFileSync(path.join(ctx.root, 'alt-base'), 'alt');
    await requestJson(ctx, '/api/skills/demo/bind', {
      method: 'POST',
      body: { url: 'https://stub.feishu.cn/base/y?table=t2&view=v2' },
    });
    const other = await waitForOperation(ctx, 'demo', 'bind-table');
    assert.equal(other.status, 'completed', JSON.stringify(other.error));
    assert.equal(templateFiles().length, 2, '换表要另建一份 Template');
    assert.notEqual(other.result.template.template_id, first.template_id, '另一张表 = 另一个 Template ID');

    fs.rmSync(path.join(ctx.root, 'alt-base'), { force: true });
    await requestJson(ctx, '/api/skills/demo/bind', {
      method: 'POST',
      body: { url: 'https://stub.feishu.cn/base/x?table=t&view=v' },
    });
    const back = await waitForOperation(ctx, 'demo', 'bind-table');
    assert.equal(back.status, 'completed', JSON.stringify(back.error));
    assert.equal(back.result.template.template_id, first.template_id, '同一张表应更新原来那一份');
    assert.equal(templateFiles().length, 2, '不该再多出第三份');
  });

  test('M3 Template 可以归档：列表消失、不可跑、可解冻，并记进 Operations', async () => {
    const list = await requestJson(ctx, '/api/templates');
    const templateId = list.body.data.items[0].template_id;

    const archive = await requestJson(ctx, `/api/templates/${templateId}/archive`, { method: 'POST', body: {} });
    assert.equal(archive.response.status, 202, JSON.stringify(archive.body));
    const archived = await waitForOperationId(ctx, archive.body.data.operation_id);
    assert.equal(archived.status, 'completed', JSON.stringify(archived.error));

    const afterArchive = await requestJson(ctx, '/api/templates');
    assert.ok(!afterArchive.body.data.items.some((item) => item.template_id === templateId), '归档后列表里不该还有它');
    const withArchived = await requestJson(ctx, '/api/templates?include_archived=1');
    assert.ok(withArchived.body.data.items.some((item) => item.template_id === templateId && item.archived_at),
      '显式要全部时，归档的 Template 要能看到（列表页的 Show Archived）');
    const detail = await requestJson(ctx, `/api/templates/${templateId}`);
    assert.equal(detail.response.status, 200, '按 Template ID 仍要能打开');
    assert.ok(detail.body.data.template.archived_at, '要带上归档时间');

    // 归档的 Template 不能跑：拒绝发生在本地核对里，所以连 Run 记录都不会产生。
    const started = await requestJson(ctx, '/api/runs', {
      method: 'POST',
      body: { template_id: templateId, trigger: 'incremental' },
    });
    assert.equal(started.response.status, 422, JSON.stringify(started.body));
    assert.equal(started.body.error.code, 'TEMPLATE_NOT_RUNNABLE');
    assert.match(started.body.error.message, /archived/, '错误里要说清是被冻结了');

    const unarchive = await requestJson(ctx, `/api/templates/${templateId}/unarchive`, { method: 'POST', body: {} });
    const restored = await waitForOperationId(ctx, unarchive.body.data.operation_id);
    assert.equal(restored.status, 'completed', JSON.stringify(restored.error));
    const afterRestore = await requestJson(ctx, '/api/templates');
    assert.ok(afterRestore.body.data.items.some((item) => item.template_id === templateId), '解冻后要回到列表');

    const operations = await listAll(ctx, '/api/operations');
    const types = operations.filter((item) => item.subject?.id === templateId).map((item) => item.type);
    assert.ok(types.includes('archive-template'), '归档要记进 Operations');
    assert.ok(types.includes('unarchive-template'), '解冻也要记进 Operations');

    // Type 过滤也在服务端：`?type=` 只回这一类。
    const filtered = await requestJson(ctx, '/api/operations?type=archive-template');
    assert.ok(filtered.body.data.items.length > 0);
    assert.ok(filtered.body.data.items.every((item) => item.type === 'archive-template'));
  });

  test('M3 全局操作流：连上先发快照，之后实时推单条操作', async () => {
    let started = null;
    const pushed = await readStreamFrames(ctx, 
      '/api/operations/events',
      (event) => event.type === 'operation' && event.operation?.type === 'analyze-skill',
      {
        onOpen: async () => {
          started = await requestJson(ctx, '/api/skills/demo/analyze', { method: 'POST', body: {} });
        },
      },
    );
    assert.equal(started.response.status, 202);
    assert.equal(pushed.operation.operation_id, started.body.data.operation_id, '推的应当是刚发起的那条');
    assert.ok(['queued', 'running', 'completed'].includes(pushed.operation.status), pushed.operation.status);
    assert.deepEqual(pushed.operation.subject, { type: 'skill', id: 'demo', label: 'demo' }, '摘要要带 subject 供列表跳转');
    await waitForOperationId(ctx, started.body.data.operation_id);

    const snapshot = await readStreamFrames(ctx, '/api/operations/events', (event) => event.type === 'snapshot');
    assert.ok(Array.isArray(snapshot.operations), '快照要带一份操作列表');
    assert.ok(snapshot.operations.every((item) => 'operation_id' in item && 'status' in item), '快照里每条都是摘要');
  });

  test('M3 操作可以取消：已结束的原样返回，不存在的返回 404', async () => {
    const list = await listAll(ctx, '/api/operations');
    const finished = list.find((item) => item.status === 'completed');
    assert.ok(finished, '前面已经跑过操作，应当有已完成的记录');

    const again = await requestJson(ctx, `/api/operations/${finished.operation_id}/cancel`, { method: 'POST', body: {} });
    assert.equal(again.response.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.data.status, 'completed', '已结束的操作不会被改成 canceled');

    const missing = await requestJson(ctx, '/api/operations/no-such-operation/cancel', { method: 'POST', body: {} });
    assert.equal(missing.response.status, 404);
  });

  test('M3 分析结果能标记 Skill 指纹过期，卸载会删除关联 Run', async () => {
    fs.appendFileSync(path.join(ctx.root, 'skills', 'demo', 'SKILL.md'), '\nchanged\n');
    const sourceFile = path.join(ctx.root, 'skills', 'demo', 'source.json');
    const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    source.hash = 'sha256:changed-after-reload';
    fs.writeFileSync(sourceFile, JSON.stringify(source, null, 2));
    const detail = await requestJson(ctx, '/api/skills/demo');
    assert.equal(detail.body.data.analysis.state, 'stale');
    assert.equal(detail.body.data.analysis.stale, true);

    const templateFile = path.join(ctx.root, 'templates', fs.readdirSync(path.join(ctx.root, 'templates'))
      .find((name) => name.startsWith('demo-') && name.endsWith('.template.json')));
    const template = JSON.parse(fs.readFileSync(templateFile, 'utf8'));
    write(ctx, 'runs/run-demo/run.json', JSON.stringify({ run_id: 'run-demo', template_id: template.template_id, items: [] }));

    const remove = await requestJson(ctx, '/api/skills/demo?with_runs=1', { method: 'DELETE' });
    const removed = await waitForOperation(ctx, 'demo', 'unload');
    assert.equal(removed.status, 'completed', JSON.stringify(removed.error));
    assert.equal(fs.existsSync(path.join(ctx.root, 'skills', 'demo')), false);
    assert.equal(fs.existsSync(path.join(ctx.root, 'runs', 'run-demo')), false);
  });

  test('M3 列表走服务端分页：只回当前页，越界页夹回最后一页', async () => {
    const first = await requestJson(ctx, '/api/operations');
    assert.equal(first.body.data.page, 1);
    assert.equal(first.body.data.page_size, 10, '默认每页 10 条');
    assert.ok(first.body.data.total > 10, '前面的用例已经攒下不少操作');
    assert.equal(first.body.data.items.length, 10, 'page 1 只回一页的量');

    const second = await requestJson(ctx, '/api/operations?page=2');
    assert.equal(second.body.data.page, 2);
    assert.ok(second.body.data.items.length > 0);
    const ids = new Set(first.body.data.items.map((item) => item.operation_id));
    assert.ok(second.body.data.items.every((item) => !ids.has(item.operation_id)), '两页不重叠');

    const beyond = await requestJson(ctx, '/api/operations?page=999');
    assert.equal(beyond.body.data.page, Math.ceil(first.body.data.total / 10), '越界页夹回最后一页');
  });
});
