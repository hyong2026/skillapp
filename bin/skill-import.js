#!/usr/bin/env node
/**
 * skill-import.js — 把外部 skill 导入 SkillApp
 *
 * 导入后 skills/<ref>/ 是运行时的唯一真相；上游改动必须重新导入才生效。
 * node_modules 属于 skill 的运行契约（"无需额外安装"），默认一并复制，但不进 git。
 */

const fs = require('fs');
const path = require('path');
const { skillHash, definitionFiles } = require('./skill-hash');

const SKILLS_DIR = path.join(__dirname, '..', 'skills');

const USAGE = `用法: node bin/skill-import.js <源目录> --ref <name> [选项]

选项:
  --ref <name>   导入后的目录名，也是 Template 引用的 skill.ref
  --no-deps      不复制 node_modules（之后需自行安装依赖）
  -h, --help     显示本帮助`;

function parseArgv(argv) {
  const out = { source: null, ref: null, withDeps: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ref') out.ref = argv[++i];
    else if (a === '--no-deps') out.withDeps = false;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (!out.source) out.source = a;
  }
  return out;
}

function main() {
  const { source, ref, withDeps, help } = parseArgv(process.argv.slice(2));
  if (help || !source || !ref) {
    console.log(USAGE);
    process.exit(help ? 0 : 1);
  }

  const src = path.resolve(source);
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) {
    throw new Error(`不是合法的 skill 目录（缺 SKILL.md）: ${src}`);
  }

  // 重新导入 = 覆盖，因此 old 副本先整体删除
  const dest = path.join(SKILLS_DIR, ref);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  const skipped = [];
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || entry.name === '.git') continue;
    if (entry.name === 'node_modules' && !withDeps) {
      skipped.push(entry.name);
      continue;
    }
    fs.cpSync(path.join(src, entry.name), path.join(dest, entry.name), { recursive: true });
  }

  const hash = skillHash(dest);
  const files = definitionFiles(dest).map((f) => path.relative(dest, f));

  // import.json 记录溯源，但它本身不参与指纹（否则自引用）
  fs.writeFileSync(path.join(dest, 'import.json'), JSON.stringify({
    ref,
    origin: src,
    content_hash: hash,
    hash_algorithm: 'sha256(相对路径 + 内容哈希)；排除 node_modules / .DS_Store / import.json',
    imported_at: new Date().toISOString(),
    with_deps: withDeps,
    files,
  }, null, 2) + '\n');

  console.log(`已导入 ${ref}`);
  console.log(`  origin : ${src}`);
  console.log(`  hash   : ${hash}`);
  console.log(`  files  : ${files.length} 个定义文件${withDeps ? ' + node_modules' : ''}`);
  if (skipped.length) console.log(`  跳过   : ${skipped.join(', ')}`);
}

try {
  main();
} catch (err) {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
}