/**
 * lark.js — lark-cli 的最小封装
 *
 * cwd 固定为仓库根：lark-cli 只允许把文件写到 cwd / /tmp / ~/files，
 * 而下载目录位于 runs/ 之下——固定 cwd 才能保证它在白名单内。
 */

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function lark(args) {
  const r = spawnSync('lark-cli', args, { encoding: 'utf8', cwd: ROOT });
  if (r.status !== 0) {
    throw new Error(`lark-cli ${args.slice(0, 3).join(' ')} 失败: ${(r.stderr || r.stdout).trim()}`);
  }

  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    throw new Error(`lark-cli 返回非 JSON: ${r.stdout.slice(0, 300)}`);
  }
  if (out.ok === false) throw new Error(`lark-cli 报错: ${JSON.stringify(out).slice(0, 300)}`);
  return out;
}

module.exports = { ROOT, lark };