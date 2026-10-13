#!/usr/bin/env node
'use strict';

import { loadEnv } from '../core/load-env.js';

loadEnv();

// .env 必须先于路径配置生效，所以业务模块用动态 import 加载。
const { planUnload, applyUnload } = await import('../core/unload-skill.js');

const USAGE = `用法: node src/cli/unload-skill.js <ref> [选项]
      node src/cli/unload-skill.js --all --yes [选项]

选项:
  --with-runs    连引用这些 Template 的运行记录一起删（默认保留）
  --yes          --all 的确认开关
  --dry-run      只列出将要删的东西
  -h, --help     显示本帮助`;

function parseArgv(argv) {
  const out = { ref: null, all: false, withRuns: false, yes: false, dryRun: false, help: false };
  for (const arg of argv) {
    if (arg === '--all') out.all = true;
    else if (arg === '--with-runs') out.withRuns = true;
    else if (arg === '--yes') out.yes = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '-h' || arg === '--help') out.help = true;
    else if (!out.ref) out.ref = arg;
  }
  return out;
}

function printPlan(plan, prefix) {
  if (!plan.removals.length) {
    console.log('没有可删的东西。');
    return;
  }
  console.log(`${prefix} ${plan.removals.length} 项：`);
  for (const item of plan.removals) console.log(`  - ${item.path}`);
  console.log(`计划 ${plan.plan_hash}`);
  if (plan.templates.length) {
    console.log('\n⚠️  飞书表格不受影响，这些列还在：');
    for (const item of plan.templates) console.log(`  ${item.ref} → 表格 ${item.table_id}（${item.inputs} 进 / ${item.outputs} 出）`);
  }
}

function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args.help || (!args.ref && !args.all)) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 1);
  }
  if (args.all && !args.yes && !args.dryRun) {
    console.error('❌ --all 会清空整个内容层。确认请加 --yes，或先 --dry-run 看看。');
    process.exit(1);
  }
  const plan = planUnload(args);
  if (args.dryRun) {
    printPlan(plan, '将删除');
    return;
  }
  applyUnload({ ...args, planHash: plan.plan_hash });
  printPlan(plan, '已删除');
  if (!args.withRuns && !args.all && plan.runs.length) console.log('\n  （运行记录保留了——加 --with-runs 可一并删除）');
}

try {
  main();
} catch (err) {
  console.error(`\n❌ ${err.message}${err.action ? `\n  ${err.action}` : ''}`);
  process.exit(1);
}
