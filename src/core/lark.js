/**
 * lark.js — lark-cli 的最小封装
 *
 * cwd 固定为仓库根：lark-cli 只允许把文件写到 cwd / /tmp / ~/files，
 * 而下载目录位于 .data/runs/ 之下——固定 cwd 才能保证它在白名单内。
 */

const { spawnSync } = require('child_process');
const { ROOT } = require('./paths');

function defaultLark(args) {
  const r = spawnSync('lark-cli', args, { encoding: 'utf8', cwd: ROOT });
  if (r.status !== 0) {
    throw new Error(`lark-cli ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  }

  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    throw new Error(`lark-cli returned invalid JSON: ${r.stdout.slice(0, 300)}`);
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

module.exports = { ROOT, lark };
