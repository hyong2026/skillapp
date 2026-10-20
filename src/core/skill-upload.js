/**
 * skill-upload.js — 浏览器上传 Skill 的落点（会话 → 逐文件 → commit）
 *
 * 为什么不用 multipart：仓库零依赖，手写 multipart 解析器不值当。改成"建会话 → 每个文件一个
 * PUT（原始字节，相对路径走 query）→ commit"：断点可续、进度天然可显示、服务端要做的校验也都在
 * 自己手里。
 *
 * 暂存放在内容层里（`.data/uploads/<id>/<ref>/`）：与 `skills/` 同一个文件系统，commit 时直接
 * 复用 `loadSkill`（复制 → 算指纹 → 原子替换），所以"上传"和"按路径装载"落到盘上的结果完全一致，
 * 只差 `source.json` 里的 `origin`。
 */

import fs from 'node:fs';
import path from 'node:path';
import { UPLOADS_DIR } from './paths.js';
import { AppError } from './errors.js';
import { assertRef } from './ref.js';
import { readJson, atomicWriteJson } from './json-file.js';

/** 上传上限：先定死在这里，要调就改这几个数（以后也可以挪进 Settings 白名单）。 */
const LIMITS = {
  fileBytes: 20 * 1024 * 1024,
  files: 2000,
  totalBytes: 100 * 1024 * 1024,
};

/** 与装载同一套忽略规则：客户端没滤掉的依赖 / 字节码，服务端这里再挡一次。 */
const SKIP_SEGMENTS = new Set(['node_modules', '__pycache__', '.venv', 'venv', '.git', '.DS_Store']);

const SESSION_ID = /^[A-Za-z0-9._-]+$/;

/** 暂存根：默认取内容层，服务端会显式传自己的 root（两者不一定一致，见 app.js）。 */
const sessionDir = (uploadsDir, id) => path.join(uploadsDir || UPLOADS_DIR, id);

/** 会话 id：时间戳 + 短随机，与 run / operation 一个口味。 */
function newId() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  return `${stamp}-${Math.random().toString(16).slice(2, 6)}`;
}

function readSession(uploadsDir, rawId) {
  const id = String(rawId || '');
  const dir = sessionDir(uploadsDir, id);
  const meta = path.join(dir, 'upload.json');
  if (!SESSION_ID.test(id) || !fs.existsSync(meta)) {
    throw new AppError('UPLOAD_NOT_FOUND', `Upload session not found: ${rawId}`, 'Start the upload again', 404);
  }
  return { id, dir, meta, record: readJson(meta) };
}

/** 相对路径校验：不收绝对路径、`..`、空段；命中依赖 / 字节码的标记为 skipped。 */
function normalizeRelPath(raw) {
  const value = String(raw || '').replace(/\\/g, '/');
  if (!value || value.startsWith('/')) {
    throw new AppError('UPLOAD_PATH_INVALID', 'File path is required and must be relative', 'Upload the folder again');
  }
  const parts = value.split('/').filter((part) => part && part !== '.');
  if (!parts.length || parts.some((part) => part === '..' || part.includes('\0'))) {
    throw new AppError('UPLOAD_PATH_INVALID', `Unsafe file path: ${raw}`, 'Upload the folder again');
  }
  return { rel: parts.join('/'), skipped: parts.some((part) => SKIP_SEGMENTS.has(part)) };
}

/** 建会话：ref 取用户选中的目录名（与按路径装载的规则一致）。 */
function createUpload({ ref: rawRef, uploadsDir } = {}) {
  const ref = assertRef(rawRef);
  const id = newId();
  const dir = sessionDir(uploadsDir, id);
  // 暂存目录就用 ref 命名：loadSkill 的 ref 取自来源目录名，这样 commit 时不用另传。
  fs.mkdirSync(path.join(dir, ref), { recursive: true });
  atomicWriteJson(path.join(dir, 'upload.json'), {
    upload_id: id,
    ref,
    created_at: new Date().toISOString(),
    files: 0,
    bytes: 0,
    skipped: 0,
  });
  return { upload_id: id, ref };
}

/** 收一个文件；命中的是依赖 / 字节码就计数后丢弃（服务端这层不信任客户端的过滤）。 */
function writeUploadFile({ uploadId, relPath, body, uploadsDir } = {}) {
  const { dir, meta, record } = readSession(uploadsDir, uploadId);
  const { rel, skipped } = normalizeRelPath(relPath);
  const base = path.join(dir, record.ref);
  const bytes = Buffer.byteLength(body || '');
  if (bytes > LIMITS.fileBytes) {
    throw new AppError('UPLOAD_FILE_TOO_LARGE', `${rel} is larger than ${LIMITS.fileBytes} bytes`, 'Split or trim the Skill', 413);
  }
  const next = { ...record, files: record.files + 1, bytes: record.bytes + bytes, skipped: record.skipped + (skipped ? 1 : 0) };
  if (next.files - next.skipped > LIMITS.files) {
    throw new AppError('UPLOAD_TOO_MANY_FILES', `More than ${LIMITS.files} files`, 'Trim the Skill (dependencies are not uploaded)', 413);
  }
  if (next.bytes > LIMITS.totalBytes) {
    throw new AppError('UPLOAD_TOO_LARGE', `Upload exceeds ${LIMITS.totalBytes} bytes`, 'Trim the Skill', 413);
  }
  if (!skipped) {
    const dest = path.join(base, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
  }
  atomicWriteJson(meta, next);
  return { skipped, files: next.files - next.skipped, bytes: next.bytes };
}

/**
 * 收尾：只校验暂存里确实有 SKILL.md，并把会话标记成已提交。
 * 真正的装载交给任务队列（见 app.js）—— worker 进程里的内容根才是对的：`paths.js` 的路径是
 * 导入期从环境变量定的，在服务端进程里同步跑 loadSkill 会写到别处去。
 */
function commitUpload({ uploadId, uploadsDir } = {}) {
  const { dir, meta, record } = readSession(uploadsDir, uploadId);
  const source = path.join(dir, record.ref);
  if (!fs.existsSync(path.join(source, 'SKILL.md'))) {
    throw new AppError(
      'UPLOAD_INCOMPLETE',
      'The uploaded folder has no SKILL.md',
      'Pick the Skill root folder — the one that contains SKILL.md',
    );
  }
  atomicWriteJson(meta, { ...record, committed_at: new Date().toISOString() });
  return { ref: record.ref, source, skipped: record.skipped };
}

function discardUpload({ uploadId, uploadsDir } = {}) {
  const { dir } = readSession(uploadsDir, uploadId);
  fs.rmSync(dir, { recursive: true, force: true });
  return { upload_id: uploadId, discarded: true };
}

/** 服务启动时清掉残留会话（进程被杀、页面关掉都会留下）。 */
function cleanupStaleUploads({ maxAgeMs = 12 * 60 * 60 * 1000, uploadsDir } = {}) {
  const root = uploadsDir || UPLOADS_DIR;
  if (!fs.existsSync(root)) return 0;
  const now = Date.now();
  let removed = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const stamp = fs.existsSync(path.join(dir, 'upload.json'))
      ? fs.statSync(path.join(dir, 'upload.json')).mtimeMs
      : fs.statSync(dir).mtimeMs;
    if (now - stamp > maxAgeMs) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

export {
  LIMITS,
  createUpload,
  writeUploadFile,
  commitUpload,
  discardUpload,
  cleanupStaleUploads,
  normalizeRelPath,
};
