#!/usr/bin/env node
/**
 * load-skill.js — 装载 Skill：把外部 Skill 复制进 SkillApp 并固定版本
 *
 * 装载后 .data/skills/<ref>/ 是运行时的唯一真相；上游改动必须重新装载才生效。
 * node_modules 属于 Skill 的运行契约（"无需额外安装"），默认一并复制，但不进 Git。
 */

const fs = require('fs');
const path = require('path');
const { skillHash } = require('../core/skill-hash');
const { SKILLS_DIR } = require('../core/paths');
const REF_RE = /^[A-Za-z0-9._-]+$/;

const USAGE = `用法: node src/cli/load-skill.js <源目录> --ref <name> [选项]

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

function isWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function main() {
  const { source, ref, withDeps, help } = parseArgv(process.argv.slice(2));
  if (help || !source || !ref) {
    console.log(USAGE);
    process.exit(help ? 0 : 1);
  }
  if (!REF_RE.test(ref) || ref === '.' || ref === '..') {
    throw new Error(`不合法的 ref: ${ref}\n  只能使用字母、数字、点、下划线和连字符`);
  }

  const srcPath = path.resolve(source);
  if (!fs.existsSync(path.join(srcPath, 'SKILL.md'))) {
    throw new Error(`不是合法的 Skill 目录（缺 SKILL.md）: ${srcPath}`);
  }

  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  const skillsDir = fs.realpathSync(SKILLS_DIR);
  const src = fs.realpathSync(srcPath);
  const dest = path.resolve(skillsDir, ref);
  if (path.dirname(dest) !== skillsDir) throw new Error(`不合法的 ref: ${ref}`);
  if (src === dest) throw new Error(`源目录和目标目录不能相同: ${src}`);
  if (isWithin(src, dest) || isWithin(dest, src)) {
    throw new Error(`源目录和目标目录不能互相包含:\n  源: ${src}\n  目标: ${dest}`);
  }

  const tmp = fs.mkdtempSync(path.join(skillsDir, `.${ref}.tmp-`));
  const backup = path.join(skillsDir, `.${ref}.bak-${process.pid}-${Date.now()}`);
  let movedOld = false;
  let hash;
  let files;

  try {
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (entry.name === '.DS_Store' || entry.name === '.git') continue;
      if (entry.name === 'node_modules' && !withDeps) continue;
      fs.cpSync(path.join(src, entry.name), path.join(tmp, entry.name), { recursive: true });
    }

    hash = skillHash(tmp);
    files = fs.readdirSync(tmp).length;

    // source.json 记溯源，本身不参与指纹（否则自引用）
    fs.writeFileSync(path.join(tmp, 'source.json'), JSON.stringify({
      source: src,
      hash,
      loaded_at: new Date().toISOString(),
    }, null, 2) + '\n');

    if (fs.existsSync(dest)) {
      fs.renameSync(dest, backup);
      movedOld = true;
    }
    fs.renameSync(tmp, dest);
    if (movedOld) fs.rmSync(backup, { recursive: true, force: true });
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (movedOld && !fs.existsSync(dest) && fs.existsSync(backup)) fs.renameSync(backup, dest);
    throw err;
  }

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
