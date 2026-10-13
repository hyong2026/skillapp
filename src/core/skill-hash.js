/**
 * skill-hash.js — Skill 内容指纹
 *
 * 算法：取目录内全部定义文件（排除 node_modules / .git / .DS_Store / source.json），
 *      按相对路径排序，逐个算内容 sha256，拼成「相对路径\n内容哈希\n」后再取 sha256。
 *
 * 与绝对路径无关，可跨机器复现；skill 内容改动任一字节，指纹即变。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const IGNORE = new Set(['node_modules', '.git', '.DS_Store', 'source.json']);

/** 递归收集定义文件，按路径排序返回绝对路径 */
function definitionFiles(root, dir = root, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) definitionFiles(root, full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

function skillHash(skillDir) {
  const outer = crypto.createHash('sha256');
  for (const file of definitionFiles(skillDir)) {
    const rel = path.relative(skillDir, file).split(path.sep).join('/');
    const inner = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    outer.update(`${rel}\n${inner}\n`);
  }
  return 'sha256:' + outer.digest('hex');
}

export { skillHash, definitionFiles };
