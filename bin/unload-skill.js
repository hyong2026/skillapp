#!/usr/bin/env node
/**
 * unload-skill.js — 卸载：把装载进来的东西从本机清掉
 *
 *   node bin/unload-skill.js <ref> [--with-runs] [--dry-run]
 *   node bin/unload-skill.js --all --yes [--dry-run]
 *
 * 只清本地内容层（skills / templates / runs / tmp）。飞书表格里的列不受影响——
 * 那是用户的数据，脚本不碰。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONTENT_DIRS = ['skills', 'templates', 'runs', 'tmp'];

const USAGE = `用法: node bin/unload-skill.js <ref> [选项]
      node bin/unload-skill.js --all --yes [选项]

模式:
  <ref>          卸载一个 Skill：删 skills/<ref>/，以及引用它的 Template
  --all          清空整个内容层（skills / templates / runs / tmp），引擎保留

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

const abs = (p) => path.join(ROOT, p);

/** 内容层里的条目，跳过说明文件 */
function entries(dir) {
  if (!fs.existsSync(abs(dir))) return [];
  return fs.readdirSync(abs(dir)).filter((n) => n !== 'README.md').map((n) => `${dir}/${n}`);
}

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(abs(p), 'utf8'));
  } catch {
    return null;
  }
};

/** 引用某个 Skill 的 Template —— 按 skill.path 判，不按文件名 */
const templatesOf = (ref) => entries('templates')
  .filter((p) => readJson(p)?.skill?.path === `skills/${ref}`);

/** 引用了这些 Template 的运行记录 */
function runsOf(templateIds) {
  const ids = new Set(templateIds);
  return entries('runs').filter((p) => ids.has(readJson(`${p}/run.json`)?.template_id));
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
    if (!fs.existsSync(abs(`skills/${args.ref}`))) {
      console.error(`❌ 没有装载过这个 Skill: skills/${args.ref}`);
      process.exit(1);
    }

    for (const t of templatesOf(args.ref)) {
      const tpl = readJson(t);
      orphaned.push({
        template: t,
        table: tpl?.target?.table_id ?? '未知',
        inputs: tpl?.mapping?.inputs?.length ?? 0,
        outputs: tpl?.mapping?.outputs?.length ?? 0,
      });
      targets.push(t);
      if (args.withRuns) targets.push(...runsOf([tpl?.template_id]));
    }
    targets.push(`skills/${args.ref}`);
  }

  const unique = [...new Set(targets)];
  if (!unique.length) {
    console.log('没有可删的东西。');
    return;
  }

  for (const t of unique) {
    if (!args.dryRun) fs.rmSync(abs(t), { recursive: true, force: true });
  }

  console.log(`${args.dryRun ? '将删除' : '已删除'} ${unique.length} 项：`);
  for (const t of unique) console.log(`  - ${t}`);
  if (!args.withRuns && !args.all && runsOf(orphaned.map((o) => readJson(o.template)?.template_id)).length) {
    console.log('\n  （运行记录保留了——加 --with-runs 可一并删除）');
  }

  if (orphaned.length) {
    console.log('\n⚠️  飞书表格不受影响，这些列还在：');
    for (const o of orphaned) {
      console.log(`  ${o.template} → 表格 ${o.table}（${o.inputs} 进 / ${o.outputs} 出）`);
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