#!/usr/bin/env node
'use strict';

// bind-table.js — 把已分析好的 IO Schema 绑到一张飞书多维表格：
// 对齐列（复用 / 新建）、设列顺序、必要时改主字段名，最后写出 Template。
// 「Mapping」在项目里是数据概念（.data/mappings/*.mapping.json = 分析产出的 IO Schema），
// 绑到表上这个动作叫 Bind，对应 `POST /api/skills/:ref/bind`。

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadEnv } from '../core/load-env.js';

loadEnv();

// .env 必须先于路径配置生效，所以业务模块用动态 import 加载。
const { ROOT } = await import('../core/paths.js');
const { planMapping, applyMapping } = await import('../core/bind-table.js');

const USAGE = `用法: node src/cli/bind-table.js --ref <ref> --url <链接> [选项]

参数:
  --ref <ref>          已装载的 Skill 名（.data/skills/<ref>）；Template 也以此命名
  --url <链接>         目标表格链接，需带 table 与 view 参数
  --base <token>       ┐ 也可以直接给 token，替代 --url
  --table <table_id>   │
  --view <view_id>     ┘
  --dry-run            只输出绑定计划，不建列、不改顺序、不写文件
  -h, --help           显示本帮助`;

function parseArgv(argv) {
  const out = { ref: null, url: null, base: null, table: null, view: null, dryRun: false, help: false };
  const takesValue = { '--ref': 'ref', '--url': 'url', '--base': 'base', '--table': 'table', '--view': 'view' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '-h' || arg === '--help') out.help = true;
    else if (takesValue[arg]) out[takesValue[arg]] = argv[++i];
  }
  return out;
}

function printPlan(plan) {
  console.log(`目标   ${plan.target.table_id}  ${plan.target.view_id}`);
  if (plan.rename_primary?.will_rename) console.log(`改名   主字段「${plan.rename_primary.from}」→「${plan.rename_primary.to}」`);
  console.log(`复用   ${plan.reuse.length} 列`);
  console.log(`新建   ${plan.create.length} 列${plan.create.length ? `：${plan.create.join('、')}` : ''}`);
  console.log(`列序   ${plan.order.join(' → ')}`);
  console.log(`计划   ${plan.plan_hash}`);
  if (plan.type_conflicts.length) {
    for (const conflict of plan.type_conflicts) console.log(`冲突   ${conflict.name}: ${conflict.existing_type} → ${conflict.required_type}`);
  }
}

function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args.help || !args.ref) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 1);
  }
  const plan = planMapping(args);
  printPlan(plan);
  if (args.dryRun) {
    console.log('\n[dry-run] 未建列、未改顺序、未写文件');
    return;
  }
  const result = applyMapping({ ...args, planHash: plan.plan_hash }, plan);
  const templatePath = result.template_path;
  console.log(`Template  ${path.relative(ROOT, templatePath)}`
    + `${result.plan.prior_hash ? `（沿用 template_id ${result.template.template_id.slice(0, 8)}）` : `（新 template_id ${result.template.template_id.slice(0, 8)}）`}`);

  const check = spawnSync('node', [path.join(import.meta.dirname, 'run-template.js'), templatePath, '--dry-run'], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  console.log('\n自检：');
  process.stdout.write((check.stdout || check.stderr).split('\n').map((line) => (line ? `  ${line}` : line)).join('\n'));
  if (check.status !== 0) process.exit(check.status);
}

try {
  main();
} catch (err) {
  console.error(`\n❌ ${err.message}${err.action ? `\n  ${err.action}` : ''}`);
  process.exit(1);
}
