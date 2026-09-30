#!/usr/bin/env node
/**
 * load-skill.js — 装载 Skill：把外部 Skill 复制进 SkillApp 并固定版本
 *
 * 装载后 skills/<ref>/ 是运行时的唯一真相；上游改动必须重新装载才生效。
 * node_modules 属于 Skill 的运行契约（"无需额外安装"），默认一并复制，但不进 Git。
 */

const fs = require('fs');
const path = require('path');
const { skillHash } = require('../lib/skill-hash');

const SKILLS_DIR = path.join(__dirname, '..', 'skills');

const USAGE = `用法: node bin/load-skill.js <源目录> --ref <name> [选项]

选项:
  --ref <name>   装载后的目录名，也是 Template 里 skill.path 的末段
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
    throw new Error(`不是合法的 Skill 目录（缺 SKILL.md）: ${src}`);
  }

  // 重新装载 = 覆盖，因此旧副本先整体删除
  const dest = path.join(SKILLS_DIR, ref);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || entry.name === '.git') continue;
    if (entry.name === 'node_modules' && !withDeps) continue;
    fs.cpSync(path.join(src, entry.name), path.join(dest, entry.name), { recursive: true });
  }

  const hash = skillHash(dest);
  const files = fs.readdirSync(dest).length;

  // source.json 记溯源，本身不参与指纹（否则自引用）
  fs.writeFileSync(path.join(dest, 'source.json'), JSON.stringify({
    source: src,
    hash,
    loaded_at: new Date().toISOString(),
  }, null, 2) + '\n');

  console.log(`已装载 ${ref}`);
  console.log(`  来源 : ${src}`);
  console.log(`  指纹 : ${hash}`);
  console.log(`  内容 : ${files} 项${withDeps ? '（含 node_modules）' : ''}`);
}

try {
  main();
} catch (err) {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
}