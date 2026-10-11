#!/usr/bin/env node
/**
 * unload-skill.js — 卸载：把装载进来的东西从本机清掉
 *
 *   node src/cli/unload-skill.js <ref> [--with-runs] [--dry-run]
 *   node src/cli/unload-skill.js --all --yes [--dry-run]
 *
 * 只清本地内容层（.data/skills / .data/templates / .data/runs / .data/tmp）。
 * 飞书表格里的列不受影响——那是用户的数据，脚本不碰。
 */

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  SKILLS_DIR,
  TEMPLATES_DIR,
  RUNS_DIR,
  TMP_DIR,
} = require('../core/paths');

const CONTENT_DIRS = [SKILLS_DIR, TEMPLATES_DIR, RUNS_DIR, TMP_DIR];

const USAGE = `用法: node src/cli/unload-skill.js <ref> [选项]
      node src/cli/unload-skill.js --all --yes [选项]

模式:
  <ref>          卸载一个 Skill：删 .data/skills/<ref>/，以及引用它的 Template
  --all          清空整个内容层（.data/skills / .data/templates / .data/runs / .data/tmp），引擎保留

选项:
  --with-runs    连引用这些 Template 的运行记录一起删（默认保留）
  --yes          --all 的确认开关
  --dry-run      只列出将要删的东西
  -h, --help     显示本帮助

注意: 只清本地。飞书表格里的列不会被删——要去掉得在表格里手工处理。`;

// ─── 参数 ─────────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const out = { ref: null, all: false, withRuns: false, yes: false, dryRun: false, help: false };
  for (const a of argv) {
    if (a === '--all') out.all = true;
    else if (a === '--with-runs') out.withRuns = true;
    else if (a === '--yes') out.yes = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (!out.ref) out.ref = a;
  }
  return out;
}

// ─── 内容层 ───────────────────────────────────────────────────────────────

const display = (file) => path.relative(ROOT, file) || '.';

/** 内容层里的条目，跳过说明文件。返回绝对路径。 */
function entries(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name !== 'README.md' && !name.startsWith('.'))
    .map((name) => path.join(dir, name));
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/** 引用某个 Skill 的 Template —— 按 skill.path 判，不按文件名 */
const templatesOf = (ref) => entries(TEMPLATES_DIR)
  .filter((file) => readJson(file)?.skill?.path === `skills/${ref}`);

/** 引用了这些 Template 的运行记录 */
function runsOf(templateIds) {
  const ids = new Set(templateIds);
  return entries(RUNS_DIR).filter((dir) => ids.has(readJson(path.join(dir, 'run.json'))?.template_id));
}

// ─── main ─────────────────────────────────────────────────────────────────

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

  const targets = [];
  const orphaned = [];

  if (args.all) {
    for (const dir of CONTENT_DIRS) targets.push(...entries(dir));
  } else {
    if (!/^[\w.-]+$/.test(args.ref) || args.ref.includes('..')) {
      console.error(`❌ 不合法的 ref: ${args.ref}`);
      process.exit(1);
    }
    const skillDir = path.join(SKILLS_DIR, args.ref);
    if (!fs.existsSync(skillDir)) {
      console.error(`❌ 没有装载过这个 Skill: ${display(skillDir)}`);
      process.exit(1);
    }

    for (const templateFile of templatesOf(args.ref)) {
      const tpl = readJson(templateFile);
      orphaned.push({
        template: templateFile,
        table: tpl?.target?.table_id ?? '未知',
        inputs: tpl?.mapping?.inputs?.length ?? 0,
        outputs: tpl?.mapping?.outputs?.length ?? 0,
      });
      targets.push(templateFile);
      if (args.withRuns) targets.push(...runsOf([tpl?.template_id]));
    }
    targets.push(skillDir);
  }

  const unique = [...new Set(targets)];
  if (!unique.length) {
    console.log('没有可删的东西。');
    return;
  }

  for (const target of unique) {
    if (!args.dryRun) fs.rmSync(target, { recursive: true, force: true });
  }

  console.log(`${args.dryRun ? '将删除' : '已删除'} ${unique.length} 项：`);
  for (const target of unique) console.log(`  - ${display(target)}`);
  if (!args.withRuns && !args.all && runsOf(orphaned.map((o) => readJson(o.template)?.template_id)).length) {
    console.log('\n  （运行记录保留了——加 --with-runs 可一并删除）');
  }

  if (orphaned.length) {
    console.log('\n⚠️  飞书表格不受影响，这些列还在：');
    for (const item of orphaned) {
      console.log(`  ${display(item.template)} → 表格 ${item.table}（${item.inputs} 进 / ${item.outputs} 出）`);
    }
    console.log('  要去掉它们，得在表格里手工删，或者换一张表。');
  }
}

try {
  main();
} catch (err) {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
}
