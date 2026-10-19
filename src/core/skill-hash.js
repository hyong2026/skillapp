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

/** 逐文件内容哈希（相对路径 → `sha256:<hex>`）。装进 source.json，用来把指纹差异说到文件级。 */
function skillFileHashes(skillDir) {
  const files = {};
  for (const file of definitionFiles(skillDir)) {
    const rel = path.relative(skillDir, file).split(path.sep).join('/');
    files[rel] = 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  return files;
}

function skillHash(skillDir) {
  const outer = crypto.createHash('sha256');
  const files = skillFileHashes(skillDir);
  for (const rel of Object.keys(files).sort()) outer.update(`${rel}\n${files[rel].slice('sha256:'.length)}\n`);
  return 'sha256:' + outer.digest('hex');
}

/** 拿装载时的清单对现在的目录：多 / 少 / 改动，各自按路径排序。 */
function diffSkillFiles(skillDir, manifest) {
  const live = skillFileHashes(skillDir);
  const keys = Object.keys(live);
  return {
    added: keys.filter((rel) => !(rel in manifest)).sort(),
    removed: Object.keys(manifest).filter((rel) => !(rel in live)).sort(),
    changed: keys.filter((rel) => rel in manifest && manifest[rel] !== live[rel]).sort(),
  };
}

export { skillHash, skillFileHashes, diffSkillFiles };
