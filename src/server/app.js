import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DATA_DIR, WEB_DIR } from '../core/paths.js';
import { assertRef } from '../core/ref.js';
import { saveMapping } from '../core/mapping.js';
import { readSettings, saveSettings } from '../core/settings.js';
import { ReadModel, HttpError, isWithin } from './read-model.js';
import { TaskRunner } from './task-runner.js';
import { operationSummary } from './operation-summary.js';
const MAX_BODY_BYTES = 1024 * 1024;
const OPERATION_TERMINAL = new Set(['completed', 'failed', 'canceled', 'interrupted']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
};

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isAuthorized(req, token) {
  if (!token) return true;
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      const password = colon >= 0 ? decoded.slice(colon + 1) : '';
      return safeEqual(password, token);
    } catch {
      return false;
    }
  }
  if (header.startsWith('Bearer ')) return safeEqual(header.slice(7), token);
  return false;
}

function securityHeaders() {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
}

function sendJson(req, res, status, payload) {
  const body = JSON.stringify(payload, null, 2) + '\n';
  res.writeHead(status, {
    ...securityHeaders(),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        reject(new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large', 'Send a smaller JSON body'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON', 'Send a valid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function assertSameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site') {
    throw new HttpError(403, 'CROSS_ORIGIN_BLOCKED', 'Cross-site writes are blocked', 'Open the Web UI from its own origin');
  }
  const origin = req.headers.origin;
  if (!origin) return;
  try {
    if (new URL(origin).host !== req.headers.host) {
      throw new Error('origin mismatch');
    }
  } catch {
    throw new HttpError(403, 'CROSS_ORIGIN_BLOCKED', 'Cross-origin writes are blocked', 'Open the Web UI from its own origin');
  }
}

function sendSseEvent(res, event) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function serveEvents(req, res, runner, runId) {
  const initialRun = runner.getRun(runId);
  res.writeHead(200, {
    ...securityHeaders(),
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();
  let unsubscribe = () => {};
  let heartbeat = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
  };
  unsubscribe = runner.subscribe(runId, (event) => {
    sendSseEvent(res, event);
    const terminal = event.run && ['completed', 'partial', 'failed', 'canceled', 'interrupted', 'dry-run'].includes(event.run.status);
    if (event.type === 'done' || terminal) {
      res.end();
      close();
    }
  });
  sendSseEvent(res, { type: 'snapshot', run: initialRun });
  const initialTerminal = ['completed', 'partial', 'failed', 'canceled', 'interrupted', 'dry-run'].includes(initialRun.status);
  if (initialTerminal) {
    res.end();
    close();
  }
  if (closed) return;
  heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  heartbeat.unref?.();
  req.on('close', close);
  req.on('end', close);
}

/**
 * 全局操作流：先给一次全量快照，之后只推单条操作的摘要。
 * 侧边栏消息区靠它实时更新，不需要轮询。
 */
function serveOperationListEvents(req, res, runner) {
  res.writeHead(200, {
    ...securityHeaders(),
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();
  let heartbeat = null;
  let closed = false;
  const unsubscribe = runner.subscribeOperations((summary) => {
    sendSseEvent(res, { type: 'operation', operation: summary });
  });
  const close = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
  };

  sendSseEvent(res, {
    type: 'snapshot',
    operations: runner.listOperations().map(operationSummary),
  });
  heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  heartbeat.unref?.();
  req.on('close', close);
  req.on('end', close);
}

function serveOperationEvents(req, res, runner, operationId) {
  const initialOperation = runner.getOperation(operationId);
  res.writeHead(200, {
    ...securityHeaders(),
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();
  let unsubscribe = () => {};
  let heartbeat = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
  };
  unsubscribe = runner.subscribeOperation(operationId, (event) => {
    sendSseEvent(res, event);
    if (event.type === 'done' || (event.operation && OPERATION_TERMINAL.has(event.operation.status))) {
      res.end();
      close();
    }
  });
  sendSseEvent(res, { type: 'snapshot', operation: initialOperation });
  if (OPERATION_TERMINAL.has(initialOperation.status)) {
    res.end();
    close();
  }
  if (closed) return;
  heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  heartbeat.unref?.();
  req.on('close', close);
  req.on('end', close);
}

function serveSkillEvents(req, res, runner, ref, operationId = null) {
  let operation = operationId ? runner.getOperation(operationId) : null;
  if (!operation) {
    const active = runner.skillOperations(ref);
    operation = active.analyze || active.mapping || active.unload || null;
  }
  if (!operation) {
    res.writeHead(200, {
      ...securityHeaders(),
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
    });
    sendSseEvent(res, { type: 'snapshot', operation: null });
    res.end();
    return;
  }
  return serveOperationEvents(req, res, runner, operation.operation_id);
}

function skillStatus(skill, analysis, operations) {
  if (operations?.analyze) return 'analyzing';
  if (!skill.valid) return 'invalid';
  if (!analysis || analysis.state === 'missing') return 'unanalyzed';
  if (analysis.state === 'current') return 'ready';
  if (analysis.state === 'stale') return 'stale';
  return 'unverified';
}

function operationData(operation) {
  return operation || null;
}

function skillOperations(runner, ref) {
  const operations = runner.skillOperations(ref);
  return Object.fromEntries(Object.entries(operations).map(([alias, operation]) => [alias, operationData(operation)]));
}

function operationDetail(operation) {
  return { ...operationSummary(operation), operation };
}

function settingsRuntime(options, model, token) {
  return {
    node: process.version,
    content_root: model.root,
    repo_root: path.resolve(options.repoRoot || path.join(import.meta.dirname, '..', '..')),
    token_required: Boolean(token),
  };
}

function sendApi(req, res, data) {
  sendJson(req, res, 200, { ok: true, data, error: null });
}

function sendError(req, res, err) {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  const code = err?.code || (status === 500 ? 'SERVER_ERROR' : 'REQUEST_ERROR');
  const message = status === 500 ? 'Internal server error' : err.message;
  const action = err?.action || (status === 500 ? 'Check the server logs' : 'Check the request and try again');
  if (status === 500) console.error(err);
  sendJson(req, res, status, {
    ok: false,
    data: null,
    error: { code, message, action },
  });
}

const decodeSegment = (value, label = 'Path') => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, 'INVALID_PATH', `${label} is invalid`, 'Check the request path');
  }
};

function staticFileFor(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'INVALID_PATH', 'Invalid path encoding', 'Check the request path');
  }

  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  let full = path.resolve(WEB_DIR, relative);
  if (!isWithin(WEB_DIR, full)) {
    throw new HttpError(400, 'INVALID_PATH', 'Invalid static asset path', 'Check the request path');
  }

  if (!fs.existsSync(full)) throw new HttpError(404, 'NOT_FOUND', 'Resource not found', 'Return home');
  if (fs.statSync(full).isDirectory()) full = path.join(full, 'index.html');
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    throw new HttpError(404, 'NOT_FOUND', 'Resource not found', 'Return home');
  }
  return full;
}

function serveStatic(req, res, pathname) {
  const file = staticFileFor(pathname);
  const stat = fs.statSync(file);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    ...securityHeaders(),
    'content-type': type,
    'cache-control': 'no-cache',
    'content-length': stat.size,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(file).pipe(res);
}

function contentDisposition(filename, type = 'attachment') {
  const raw = path.basename(String(filename));
  const fallback = raw.replace(/[^\x20-\x7e]/g, '_').replace(/["\\\r\n]/g, '_');
  const encoded = encodeURIComponent(raw)
    .replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function serveArtifact(req, res, file) {
  const stat = fs.statSync(file);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    ...securityHeaders(),
    'content-type': type,
    'cache-control': 'private, max-age=60',
    'content-disposition': contentDisposition(path.basename(file), 'inline'),
    'content-length': stat.size,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(file).pipe(res);
}

async function routeApi(req, res, model, runner, segments, runtime = {}) {
  const readOnly = req.method === 'GET' || req.method === 'HEAD';

  if (segments.length === 2 && segments[1] === 'status') {
    return sendApi(req, res, model.status());
  }

  if (segments[1] === 'skills') {
    if (req.method === 'POST' && segments.length === 3 && segments[2] === 'load') {
      assertSameOrigin(req);
      const body = await readJsonBody(req);
      const sourcePath = String(body.source_path || '').trim();
      if (!sourcePath) {
        throw new HttpError(400, 'SOURCE_REQUIRED', 'Skill root directory is required', 'Enter the absolute path to a Skill root');
      }
      const ref = assertRef(path.basename(path.resolve(sourcePath)));
      return sendJson(req, res, 202, {
        ok: true,
        data: operationData(runner.startTask('load-skill', { ref, source_path: sourcePath }, { lockKeys: [`skill:${ref}`] })),
        error: null,
      });
    }

    if (req.method === 'POST' && segments.length === 4 && segments[3] === 'analyze') {
      assertSameOrigin(req);
      const ref = assertRef(segments[2]);
      return sendJson(req, res, 202, {
        ok: true,
        data: operationData(runner.startTask('analyze-skill', { ref }, { lockKeys: [`skill:${ref}`] })),
        error: null,
      });
    }

    const allowedWrite = (segments.length === 4 && segments[3] === 'mapping' && req.method === 'PUT')
      || (segments.length === 4 && segments[3] === 'analyze' && req.method === 'POST')
      || (segments.length === 3 && req.method === 'DELETE');
    if (!readOnly && !allowedWrite) {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed', 'Check the request method');
    }
    if (segments.length === 2 && readOnly) {
      const skills = model.listSkills().map((skill) => {
        const operations = runner.skillOperations(skill.ref);
        return { ...skill, status: skillStatus(skill, model.getSkill(skill.ref).analysis, operations) };
      });
      return sendApi(req, res, skills);
    }
    if (segments.length === 3 && readOnly) {
      const ref = assertRef(segments[2]);
      const detail = model.getSkill(ref);
      const operations = skillOperations(runner, ref);
      return sendApi(req, res, { ...detail, status: skillStatus(detail, detail.analysis, operations), operations });
    }
    if (segments.length === 5 && segments[3] === 'operations' && readOnly) {
      const ref = assertRef(segments[2]);
      const operation = runner.skillOperation(ref, segments[4]);
      if (!operation) throw new HttpError(404, 'OPERATION_NOT_FOUND', `Operation not found: ${segments[4]}`, 'Refresh the Skill details');
      return sendApi(req, res, operationData(operation));
    }

    if (segments.length === 4 && segments[3] === 'events' && readOnly) {
      const ref = assertRef(segments[2]);
      const operationId = new URL(req.url, 'http://localhost').searchParams.get('operation_id');
      return serveSkillEvents(req, res, runner, ref, operationId);
    }
    if (segments.length === 4 && segments[3] === 'analysis' && readOnly) {
      return sendApi(req, res, model.getSkill(segments[2]).analysis);
    }
    if (segments.length === 4 && segments[3] === 'mapping' && req.method === 'PUT') {
      assertSameOrigin(req);
      const body = await readJsonBody(req);
      const ref = assertRef(segments[2]);
      const skill = model.getSkill(ref);
      const mapping = saveMapping(ref, body.mapping || body, skill.hash, model.root);
      return sendApi(req, res, { mapping, state: 'current' });
    }
    if (segments.length === 3 && req.method === 'DELETE') {
      assertSameOrigin(req);
      const body = await readJsonBody(req);
      const ref = assertRef(segments[2]);
      return sendJson(req, res, 202, {
        ok: true,
        data: operationData(runner.startTask('unload-skill', {
          ref,
          with_runs: body.with_runs !== false,
        }, { lockKeys: [`skill:${ref}`] })),
        error: null,
      });
    }
    throw new HttpError(404, 'NOT_FOUND', 'Skill endpoint not found', 'Check the request path');
  }

  if (segments[1] === 'templates') {
    if (segments.length === 4 && (segments[3] === 'archive' || segments[3] === 'unarchive') && req.method === 'POST') {
      assertSameOrigin(req);
      const templateId = segments[2];
      // 先校验 id 与存在性：找不到就没必要起任务。ref 用来把进度挂在同一个 Skill 的事件流上。
      const selected = model.getTemplate(templateId);
      const ref = path.basename(String(selected.template.skill?.path || '')) || null;
      const type = segments[3] === 'archive' ? 'archive-template' : 'unarchive-template';
      return sendJson(req, res, 202, {
        ok: true,
        data: operationData(runner.startTask(
          type,
          { template_id: templateId, template_name: selected.name || null, ref },
          { lockKeys: [`template:${templateId}`] },
        )),
        error: null,
      });
    }
    if (!readOnly) throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Only GET / HEAD are supported', 'Check the request method');
    if (segments.length === 2) {
      const includeArchived = new URL(req.url, 'http://localhost').searchParams.get('scope') === 'all';
      return sendApi(req, res, model.listTemplates(null, { includeArchived }));
    }
    if (segments.length === 3) return sendApi(req, res, model.getTemplate(segments[2]));
  }

  if (segments[1] === 'mappings') {
    if (req.method === 'POST' && segments.length === 2) {
      assertSameOrigin(req);
      const body = await readJsonBody(req);
      const ref = assertRef(body.ref);
      const base = body.base || body.base_token;
      const table = body.table || body.table_id;
      const lockKeys = [`skill:${ref}`];
      if (base && table) lockKeys.push(`table:${base}:${table}`);
      return sendJson(req, res, 202, {
        ok: true,
        data: operationData(runner.startTask('map-table', body, { lockKeys })),
        error: null,
      });
    }
    throw new HttpError(404, 'NOT_FOUND', 'Mapping endpoint not found', 'Check the request path');
  }

  if (segments[1] === 'operations') {
    if (segments.length === 4 && segments[3] === 'cancel' && req.method === 'POST') {
      assertSameOrigin(req);
      return sendApi(req, res, await runner.cancelOperation(segments[2]));
    }
    if (!readOnly) throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Only GET / HEAD are supported', 'Check the request method');
    if (segments.length === 3 && segments[2] === 'events') return serveOperationListEvents(req, res, runner);
    if (segments.length === 2) return sendApi(req, res, runner.listOperations().map(operationSummary));
    if (segments.length === 3) return sendApi(req, res, operationDetail(runner.getOperation(segments[2])));
    throw new HttpError(404, 'NOT_FOUND', 'Operation endpoint not found', 'Check the request path');
  }

  if (segments[1] === 'settings') {
    if (segments.length !== 2) throw new HttpError(404, 'NOT_FOUND', 'Settings endpoint not found', 'Check the request path');
    if (readOnly) return sendApi(req, res, readSettings(runtime));
    if (req.method === 'PUT') {
      assertSameOrigin(req);
      const body = await readJsonBody(req);
      saveSettings(body.values || {});
      return sendApi(req, res, readSettings(runtime));
    }
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Only GET / HEAD / PUT are supported', 'Check the request method');
  }

  if (segments[1] === 'runs') {
    if (req.method === 'POST' && segments.length === 2) {
      assertSameOrigin(req);
      const body = await readJsonBody(req);
      return sendJson(req, res, 202, { ok: true, data: runner.start(body), error: null });
    }
    if (req.method === 'POST' && segments.length === 3 && segments[2] === 'preview') {
      assertSameOrigin(req);
      const body = await readJsonBody(req);
      return sendApi(req, res, await runner.preview(body));
    }
    if (req.method === 'POST' && segments.length === 4 && segments[3] === 'cancel') {
      assertSameOrigin(req);
      return sendApi(req, res, await runner.cancel(segments[2]));
    }
    if (req.method === 'POST' && segments.length === 4 && segments[3] === 'retry') {
      assertSameOrigin(req);
      return sendJson(req, res, 202, { ok: true, data: runner.retry(segments[2]), error: null });
    }
    if (req.method === 'GET' && segments.length === 4 && segments[3] === 'events') {
      return serveEvents(req, res, runner, segments[2]);
    }
    if (!readOnly) throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Only GET / HEAD are supported', 'Check the request method');
    if (segments.length === 3) {
      return sendApi(req, res, runner.getRun(segments[2]));
    }
    if (segments.length === 5 && segments[3] === 'items') {
      return sendApi(req, res, model.getRunItem(segments[2], segments[4]));
    }
    if (segments.length >= 6 && segments[3] === 'artifacts') {
      const relative = segments.slice(5).join('/');
      return serveArtifact(req, res, model.artifactPath(segments[2], segments[4], relative));
    }
    if (segments.length === 2) return sendApi(req, res, runner.listRuns());
  }

  throw new HttpError(404, 'NOT_FOUND', 'API endpoint not found', 'Check the request path');
}

function createRequestHandler(options = {}) {
  const root = path.resolve(options.root || DATA_DIR);
  const token = options.token ? String(options.token) : null;
  const model = new ReadModel(root);
  const runner = options.taskRunner || new TaskRunner({ root, repoRoot: options.repoRoot });

  const handler = async (req, res) => {
    try {
      let url;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        throw new HttpError(400, 'INVALID_URL', 'Invalid request URL', 'Check the request path');
      }

      if (!isAuthorized(req, token)) {
        res.writeHead(401, {
          ...securityHeaders(),
          'www-authenticate': 'Basic realm="SkillApp Web UI", charset="UTF-8"',
          'content-type': 'text/plain; charset=utf-8',
        });
        res.end('Authentication required\n');
        return;
      }

      const segments = url.pathname.split('/').filter(Boolean).map((part, i) => decodeSegment(part, i ? 'Path segment' : 'Path'));
      if (segments[0] === 'api') {
        await routeApi(req, res, model, runner, segments, settingsRuntime(options, model, token));
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Only GET / HEAD are supported', 'Check the request method');
      }
      serveStatic(req, res, url.pathname);
    } catch (err) {
      if (res.headersSent) {
        res.destroy(err);
        return;
      }
      sendError(req, res, err);
    }
  };
  handler.taskRunner = runner;
  return handler;
}

function createServer(options = {}) {
  const handler = createRequestHandler(options);
  const server = http.createServer(handler);
  server.taskRunner = handler.taskRunner;
  return server;
}

export {
  createServer,
  createRequestHandler,
  isAuthorized,
  isWithin,
};
