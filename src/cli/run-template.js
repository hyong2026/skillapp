#!/usr/bin/env node
'use strict';

/**
 * run-template.js — 按 Template 执行：逐行读多维表格 → 跑 Skill → 回写结果
 *
 *   node src/cli/run-template.js <template.json> [--all | --incremental | --record-id <id> ...] [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../core/load-env.js';

loadEnv();

// .env 必须先于路径配置生效，所以业务模块用动态 import 加载。
const { runTemplate } = await import('../core/run-template.js');
const { ROOT } = await import('../core/paths.js');

const USAGE = `用法: node src/cli/run-template.js <template.json> [选项]

选项:
  --all               处理表内所有行（默认）
  --incremental       只处理工作版本或输入变化的行
  --record-id <id>    只处理指定行，可重复传
  --dry-run           只核对，不执行、不回写、不产生 Run 记录
  -h, --help          显示本帮助`;

function parseArgv(argv) {
  const out = { template: null, recordIds: [], dryRun: false, incremental: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--incremental') out.incremental = true;
    else if (arg === '--record-id') out.recordIds.push(argv[++i]);
    else if (arg === '-h' || arg === '--help') out.help = true;
    else if (!out.template) out.template = arg;
  }
  return out;
}

function logEvent(event) {
  if (event.type === 'run-created') {
    const run = event.run;
    console.log(`Run ${run.run_id}  ${run.template_id.slice(0, 8)}  trigger=${run.trigger}  rows=${run.total}`);
    if (run.dropped.length) console.log(`  [跳过 ${run.dropped.length} 个不在表格里的列] ${run.dropped.join('、')}`);
    if (run.dry_run) console.log('  [dry-run] 只核对，不执行、不回写');
    return;
  }
  if (event.type !== 'item-finished') return;

  const item = event.item;
  if (item.status === 'dry-run') {
    console.log(`  → ${item.record_id}  argv: ${JSON.stringify(item.argv)}`);
  } else {
    const flag = item.status === 'succeeded' ? '✅' : '❌';
    console.log(`  ${flag} ${item.record_id}  ${item.stage || 'done'}  ${item.ms ?? '-'}ms  ${item.error || ''}`);
  }
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args.help || !args.template) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 1);
  }

  const template = JSON.parse(fs.readFileSync(args.template, 'utf8'));
  const { run, workdir } = await runTemplate({
    template,
    options: {
      trigger: args.incremental ? 'incremental' : 'all',
      recordIds: args.recordIds,
      dryRun: args.dryRun,
    },
    onEvent: logEvent,
  });

  if (!run.total) {
    console.log('没有符合条件的行');
    return;
  }
  if (args.dryRun) return;
  console.log(`\n完成: ${run.succeeded} 成功 / ${run.failed} 失败`);
  console.log(`记录: ${path.relative(ROOT, path.join(workdir, 'run.json'))}`);
}

const mainPromise = main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});

export { mainPromise };
