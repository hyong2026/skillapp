'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { ReadModel, HttpError, isWithin } = require('./read-model');
const { DATA_DIR, WEB_DIR } = require('../core/paths');

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

function serveArtifact(req, res, file) {
  const stat = fs.statSync(file);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const rawName = path.basename(file);
  const fallbackName = rawName
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\\r\n]/g, '_');
  const encodedName = encodeURIComponent(rawName)
    .replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  res.writeHead(200, {
    ...securityHeaders(),
    'content-type': type,
    'cache-control': 'private, max-age=60',
    'content-disposition': `inline; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`,
    'content-length': stat.size,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(file).pipe(res);
}

function routeApi(req, res, model, segments) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new HttpError(405, 'READ_ONLY', 'This API is read-only', 'Write operations are not supported in this version');
  }

  if (segments.length === 2 && segments[1] === 'status') {
    return sendApi(req, res, model.status());
  }

  if (segments[1] === 'skills') {
    if (segments.length === 2) return sendApi(req, res, model.listSkills());
    if (segments.length === 3) return sendApi(req, res, model.getSkill(segments[2]));
  }

  if (segments[1] === 'templates') {
    if (segments.length === 2) return sendApi(req, res, model.listTemplates());
    if (segments.length === 3) return sendApi(req, res, model.getTemplate(segments[2]));
  }

  if (segments[1] === 'runs') {
    if (segments.length === 3) return sendApi(req, res, model.getRun(segments[2]));
    if (segments.length === 5 && segments[3] === 'items') {
      return sendApi(req, res, model.getRunItem(segments[2], segments[4]));
    }
    if (segments.length >= 6 && segments[3] === 'artifacts') {
      const relative = segments.slice(5).join('/');
      return serveArtifact(req, res, model.artifactPath(segments[2], segments[4], relative));
    }
    if (segments.length === 2) return sendApi(req, res, model.listRuns());
  }

  throw new HttpError(404, 'NOT_FOUND', 'API endpoint not found', 'Check the request path');
}

function createRequestHandler(options = {}) {
  const root = path.resolve(options.root || DATA_DIR);
  const token = options.token ? String(options.token) : null;
  const model = new ReadModel(root);

  return (req, res) => {
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
        routeApi(req, res, model, segments);
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
}

function createServer(options = {}) {
  return http.createServer(createRequestHandler(options));
}

module.exports = {
  createServer,
  createRequestHandler,
  isAuthorized,
  isWithin,
};
