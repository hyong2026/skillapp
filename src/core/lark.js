/**
 * lark.js — lark-cli 的最小封装
 *
 * cwd 固定为内容层根（.data/）：lark-cli 只允许把文件写到 cwd / /tmp / ~/files，
 * 而下载目录位于 .data/runs/ 之下——cwd 必须是它的祖先，调用才不会被白名单拒绝。
 */

import { spawnSync } from 'node:child_process';
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

function defaultLark(args) {
  const r = spawnSync('lark-cli', args, { encoding: 'utf8', cwd: DATA_DIR });
  if (r.status !== 0) {
    throw new Error(`lark-cli ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  }

  let out;
  try {
    out = parseOutput(r.stdout);
  } catch {
    throw new Error(`lark-cli returned invalid JSON: ${String(r.stdout).slice(0, 300)}`);
  }
  if (out.ok === false) throw new Error(`lark-cli error: ${JSON.stringify(out).slice(0, 300)}`);
  return out;
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

function lark(args) {
  if (!implementation) implementation = loadImplementation();
  return implementation(args);
}

export { lark, parseOutput };
