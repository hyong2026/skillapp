/**
 * lark.js — lark-cli 的最小封装
 *
 * cwd 固定为内容层根（.data/）：lark-cli 只允许把文件写到 cwd / /tmp / ~/files，
 * 而下载目录位于 .data/runs/ 之下——cwd 必须是它的祖先，调用才不会被白名单拒绝。
 */

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { DATA_DIR } from './paths.js';

const require = createRequire(import.meta.url);

/**
 * lark-cli 偶尔会在 JSON 前面打印横幅（例如刚升级完的提示），
 * 所以解析时只取第一对 `{` … `}` 之间的内容。
 */
function parseOutput(stdout) {
  const text = String(stdout || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
}

/** 同步与异步两条路共用的结果判定：退出码、JSON 解析、`ok: false`。 */
function checkResult(args, status, stdout, stderr) {
  if (status !== 0) {
    throw new Error(`lark-cli ${args.slice(0, 3).join(' ')} failed: ${String(stderr || stdout || '').trim()}`);
  }
  let out;
  try {
    out = parseOutput(stdout);
  } catch {
    throw new Error(`lark-cli returned invalid JSON: ${String(stdout).slice(0, 300)}`);
  }
  if (out.ok === false) throw new Error(`lark-cli error: ${JSON.stringify(out).slice(0, 300)}`);
  return out;
}

function defaultLark(args) {
  const r = spawnSync('lark-cli', args, { encoding: 'utf8', cwd: DATA_DIR });
  return checkResult(args, r.status, r.stdout, r.stderr);
}

function loadImplementation() {
  if (!process.env.SKILLAPP_LARK_MODULE) return defaultLark;
  const mod = require(process.env.SKILLAPP_LARK_MODULE);
  if (typeof mod !== 'function' && typeof mod.lark !== 'function') {
    throw new Error(`SKILLAPP_LARK_MODULE does not export a lark function: ${process.env.SKILLAPP_LARK_MODULE}`);
  }
  return typeof mod === 'function' ? mod : mod.lark;
}

let implementation;
let asyncImplementation;

function lark(args) {
  if (!implementation) implementation = loadImplementation();
  return implementation(args);
}

/**
 * 异步版：`spawnSync` 会阻塞事件循环，Run 的并发会因此退化成串行（下载 / 上传 / 回写
 * 只能排队）。需要真正并行的调用点用这个。
 * 注入的假实现若只有同步版，就包一层 Promise——语义不变，测试不用改。
 */
function larkAsync(args) {
  if (asyncImplementation === undefined) {
    if (process.env.SKILLAPP_LARK_MODULE) {
      const mod = require(process.env.SKILLAPP_LARK_MODULE);
      asyncImplementation = typeof mod?.larkAsync === 'function' ? mod.larkAsync : null;
    } else {
      asyncImplementation = null;
    }
  }
  if (asyncImplementation) return Promise.resolve(asyncImplementation(args));
  if (process.env.SKILLAPP_LARK_MODULE) return Promise.resolve(lark(args));
  return new Promise((resolve, reject) => {
    const child = spawn('lark-cli', args, { cwd: DATA_DIR });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (status) => {
      try {
        resolve(checkResult(args, status, stdout, stderr));
      } catch (err) {
        reject(err);
      }
    });
  });
}

export { lark, larkAsync, parseOutput };
