#!/usr/bin/env node
'use strict';

const { loadEnv } = require('../core/load-env');
loadEnv();

const { loadSkill } = require('../core/load-skill');

const USAGE = `用法: node src/cli/load-skill.js <Skill 根目录>

Skill 目录名就是装载后的 ref。目录必须包含 SKILL.md，默认完整导入。`;

function parseArgv(argv) {
  const out = { source: null, help: false };
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') out.help = true;
    else if (!out.source) out.source = arg;
  }
  return out;
}

function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args.help || !args.source) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 1);
  }
  const result = loadSkill({ sourcePath: args.source });
  console.log(`已装载 ${result.ref}`);
  console.log(`  来源 : ${result.source}`);
  console.log(`  指纹 : ${result.hash}`);
  console.log(`  内容 : ${result.files} 项`);
}

try {
  main();
} catch (err) {
  console.error(`\n❌ ${err.message}${err.action ? `\n  ${err.action}` : ''}`);
  process.exit(1);
}
