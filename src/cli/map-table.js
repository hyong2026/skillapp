#!/usr/bin/env node
/**
 * map-table.js — 把 IO 契约映射到飞书多维表格中的某张表格，并生成 Template
 *
 *   node src/cli/map-table.js --ref <ref> --url <表格链接> [契约路径] [--dry-run]
 *
 * 契约路径默认由 --ref 推导为 .data/tmp/<ref>.io-schema.json，可不传——这样就不会指错文件。
 *
 * 只做机械的事：列对齐、列顺序、写 Template。
 * 类型怎么选、这一列要不要，都在上游（analyze-skill-io）决定好了——这里不替人做判断。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { lark } = require('../core/lark');
const { ROOT, SKILLS_DIR, TEMPLATES_DIR, TMP_DIR } = require('../core/paths');
const INPUT_PREFIX = 'in: ';
const OUTPUT_PREFIX = 'out: ';
const REQUIRED_MARK = '＊'; // 必填项在列名行首加全角星号
const PRIMARY_NAME = '任务名称';
const DEFAULT_PRIMARY = '文本'; // 新建表格时多维表格给主字段的默认名

const USAGE = `用法: node src/cli/map-table.js --ref <ref> --url <链接> [契约路径] [选项]

参数:
  --ref <ref>          已装载的 Skill 名（.data/skills/<ref>）；Template 也以此命名
  [契约路径]           省略则用 .data/tmp/<ref>.io-schema.json；路径以仓库根为基准
  --url <链接>         目标表格链接，需带 table 与 view 参数
  --base <token>       ┐ 也可以直接给 token，替代 --url
  --table <table_id>   │
  --view <view_id>     ┘
  --dry-run            只报告将要做什么，不建列、不改顺序、不写文件
  -h, --help           显示本帮助`;

// ─── 参数 ─────────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const out = { schema: null, ref: null, url: null, base: null, table: null, view: null, dryRun: false, help: false };
  const takesValue = { '--ref': 'ref', '--url': 'url', '--base': 'base', '--table': 'table', '--view': 'view' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (takesValue[a]) out[takesValue[a]] = argv[++i];
    else if (!out.schema) out.schema = a;
  }
  return out;
}

const tableFlags = (t, ...rest) => ['--base-token', t.base_token, '--table-id', t.table_id, '--as', 'user', ...rest];

const readFields = (t) => lark(['base', '+field-list', ...tableFlags(t)]).data.fields;

// ─── 契约 → 列 ────────────────────────────────────────────────────────────

/** io-schema 的字段类型 → 多维表格字段 JSON */
function fieldJson(spec) {
  switch (spec.type) {
    case 'text': return { type: 'text' };
    case 'number': return { type: 'number', style: { type: 'plain', precision: spec.precision ?? 0 } };
    case 'datetime': return { type: 'datetime', style: { format: 'yyyy-MM-dd HH:mm' } };
    case 'checkbox': return { type: 'checkbox' };
    case 'attachment': return { type: 'attachment' };
    case 'select':
      return {
        type: 'select',
        multiple: Boolean(spec.multiple),
        options: (spec.options || []).map((name) => ({ name })),
        ...(spec.default === undefined ? {} : { default_value: [spec.default] }),
      };
    default:
      throw new Error(`暂不支持的字段类型: ${spec.type}（${spec.label}）`);
  }
}

const columnName = (spec, prefix) => (spec.required ? REQUIRED_MARK : '') + prefix + spec.label;

/** cmd 里引用的变量必须都能解析——拼错的 key 现在就报错，而不是等运行时 */
function checkCmd(cmd, io) {
  if (!cmd) throw new Error('io-schema 缺少 cmd');
  const known = new Set(['skill.entry', 'outdir', ...io.inputs.map((i) => i.key)]);
  const bad = [];
  for (const [, group] of cmd.matchAll(/\{([^{}]*)\}/g)) {
    const keys = group.split(/\s+/).filter((p) => p && !p.startsWith('-')).map((p) => p.replace(/\.\.\.$/, ''));
    for (const k of keys) if (!known.has(k)) bad.push(k);
  }
  if (bad.length) throw new Error(`cmd 里引用了契约中没有的变量: ${[...new Set(bad)].join(', ')}`);
}

// ─── 目标表格 ─────────────────────────────────────────────────────────────

function resolveTarget(args) {
  if (args.url) {
    const d = lark(['base', '+url-resolve', '--url', args.url, '--as', 'user']).data;
    return { base_token: d.base_token, table_id: d.table_id, view_id: args.view || d.view_id };
  }
  if (!args.base || !args.table) throw new Error('需要 --url，或者 --base + --table');
  return { base_token: args.base, table_id: args.table, view_id: args.view };
}

/** 已经把同一张表当目标的其它 Template —— 多个 Skill 落在同一张表是合法的，但值得说一声 */
function siblingTemplates(tableId, selfPath) {
  if (!fs.existsSync(TEMPLATES_DIR)) return [];
  return fs.readdirSync(TEMPLATES_DIR)
    .filter((n) => n.endsWith('.json') && path.join(TEMPLATES_DIR, n) !== selfPath)
    .filter((n) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, n), 'utf8')).target?.table_id === tableId;
      } catch {
        return false;
      }
    });
}

/** 主字段是视图里的第一列（接口会把主字段强制排到最前） */
function primaryField(target) {
  const [first] = lark(['base', '+view-get-visible-fields', ...tableFlags(target, '--view-id', target.view_id)])
    .data.visible_fields;
  const field = readFields(target).find((f) => f.name === first);
  if (!field) throw new Error(`找不到主字段: ${first}`);
  return field;
}

// ─── 列对齐 ───────────────────────────────────────────────────────────────

/** 建字段之后写入是异步传播的，重试前等一下。同步脚本里用 sleep，不引定时器。 */
const sleep = (seconds) => spawnSync('sleep', [String(seconds)]);

const CREATE_ATTEMPTS = 10; // 建列后回读的重试次数
const CREATE_WAIT_S = 3;    // 每次重试前等待秒数（最坏 CREATE_ATTEMPTS × CREATE_WAIT_S）

/**
 * 逐列决定「复用 / 新建」。
 * 复用优先按上一版 Template 里的 field_id——这样用户手工改过列名也不会被覆盖。
 * 类型不符直接报错：把 number 改成 text 是人的决定，脚本不擅自做。
 */
function alignColumns(target, io, prior, dryRun) {
  const wanted = [
    ...io.inputs.map((spec) => ({ spec, name: columnName(spec, INPUT_PREFIX) })),
    ...io.outputs.map((spec) => ({ spec, name: columnName(spec, OUTPUT_PREFIX) })),
  ];

  const priorIds = new Map();
  for (const e of [...(prior?.mapping?.inputs || []), ...(prior?.mapping?.outputs || [])]) priorIds.set(e.key, e.field_id);

  const fields = readFields(target);
  const byId = new Map(fields.map((f) => [f.id, f]));
  const byName = new Map(fields.map((f) => [f.name, f]));

  const reused = [];
  const missing = [];
  for (const w of wanted) {
    const live = byId.get(priorIds.get(w.spec.key)) || byName.get(w.name);
    if (!live) {
      missing.push(w);
      continue;
    }
    const wantType = fieldJson(w.spec).type;
    if (live.type !== wantType) {
      throw new Error(`列「${live.name}」现有类型是 ${live.type}，契约要求 ${wantType}；类型转换需要人决定`);
    }
    reused.push({ ...w, field_id: live.id });
  }

  if (missing.length && !dryRun) {
    const payload = missing.map((w) => ({
      ...fieldJson(w.spec),
      name: w.name,
      ...(w.spec.hint ? { description: w.spec.hint } : {}),
    }));
    lark(['base', '+field-create', ...tableFlags(target, '--json', JSON.stringify(payload))]);

    // 回读一次可能还看不到刚建的列：字段创建是异步传播的（第一次映射就在这儿断过）。
    // 顺利时第 1 次就读到，不付出等待；慢的时候退避重试，而不是一次读不到就放弃。
    let after = new Map();
    let unresolved = missing;
    for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++) {
      after = new Map(readFields(target).map((f) => [f.name, f]));
      unresolved = missing.filter((w) => !after.has(w.name));
      if (!unresolved.length) break;
      if (attempt < CREATE_ATTEMPTS - 1) sleep(CREATE_WAIT_S);
    }
    if (unresolved.length) {
      throw new Error(`新建后仍找不到列（飞书字段传播延迟）: ${unresolved.map((w) => w.name).join('、')}\n`
        + '  列已经建好了，重跑本命令即可——它按列名复用，是幂等的');
    }
    for (const w of missing) reused.push({ ...w, field_id: after.get(w.name).id });
  }

  return { wanted, reused, missing };
}

/** 顺序固定为 主字段 → 输入 → 输出 → 其余既有列；新建字段后写入是异步的，故重试 */
function setColumnOrder(target, wanted, reused, primary, dryRun) {
  const idToName = new Map(readFields(target).map((f) => [f.id, f.name]));
  const ordered = [primary.name];

  for (const w of wanted) {
    const hit = reused.find((r) => r.spec.key === w.spec.key);
    if (hit) ordered.push(hit.live_name || idToName.get(hit.field_id) || w.name);
    else ordered.push(w.name);
  }
  for (const f of readFields(target)) if (!ordered.includes(f.name)) ordered.push(f.name);

  if (dryRun) return ordered;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      lark(['base', '+view-set-visible-fields', ...tableFlags(target,
        '--view-id', target.view_id, '--json', JSON.stringify({ visible_fields: ordered }))]);
      return ordered;
    } catch (err) {
      if (attempt === 2) throw err;
      sleep(2); // 刚建字段时的传播延迟
    }
  }
}

// ─── Template ─────────────────────────────────────────────────────────────

const inputEntry = (s, fieldId) => ({
  key: s.key,
  field_id: fieldId,
  type: s.type,
  ...(s.required ? { required: true } : {}),
  ...(s.default === undefined ? {} : { default: s.default }),
  ...(s.validate ? { validate: s.validate } : {}),
  ...(s.transform ? { transform: s.transform } : {}),
});

const outputEntry = (s, fieldId) => ({
  key: s.key,
  field_id: fieldId,
  type: s.type,
  from: s.from,
  ...(s.round === undefined ? {} : { round: s.round }),
});

function localIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  const [sign, abs] = [offset >= 0 ? '+' : '-', Math.abs(offset)];
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    + `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

function buildTemplate({ io, ref, hash, target, primaryId, reused, prior }) {
  const idOf = (key) => reused.find((r) => r.spec.key === key)?.field_id;
  return {
    // 沿用上一版的 id 与创建时间，让重跑是幂等的
    template_id: prior?.template_id || crypto.randomUUID(),
    created_at: prior?.created_at || localIso(),

    skill: { path: `skills/${ref}`, hash, entry: io.skill.entry },

    target: {
      base_token: target.base_token,
      table_id: target.table_id,
      view_id: target.view_id,
      primary_field_id: primaryId,
    },

    mapping: {
      cmd: io.cmd,
      inputs: io.inputs.map((s) => inputEntry(s, idOf(s.key))),
      outputs: io.outputs.map((s) => outputEntry(s, idOf(s.key))),
    },

    ...(io.limits ? { limits: io.limits } : {}),
  };
}

// ─── main ─────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args.help || !args.ref) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 1);
  }

  // 契约路径默认由 --ref 推导。让正确的做法成为唯一做法——指错文件的机会就没了。
  const schemaPath = args.schema
    ? path.resolve(ROOT, args.schema)
    : path.join(TMP_DIR, `${args.ref}.io-schema.json`);
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`找不到 IO 契约: ${path.relative(ROOT, schemaPath)}\n`
      + `  先跑 analyze-skill-io，或用位置参数指定契约路径`);
  }
  const io = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  if (!Array.isArray(io.inputs) || !Array.isArray(io.outputs)) {
    throw new Error(`契约格式不对（缺 inputs / outputs 数组）: ${path.relative(ROOT, schemaPath)}`);
  }
  checkCmd(io.cmd, io);

  const target = resolveTarget(args);
  if (!target.view_id) throw new Error('缺少 view_id：映射目标是「表格 + 视图」，请给出带 view 参数的链接或显式 --view');

  const sourceFile = path.join(SKILLS_DIR, args.ref, 'source.json');
  if (!fs.existsSync(sourceFile)) {
    throw new Error(`Skill 未装载: ${path.relative(ROOT, path.join(SKILLS_DIR, args.ref))}\n  先执行: node src/cli/load-skill.js <源目录> --ref ${args.ref}`);
  }
  const { hash } = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));

  // 一个 Skill 一张表，因此只按 Skill 名命名（要支持多表得把表格也写进文件名）
  const templatePath = path.join(TEMPLATES_DIR, `${args.ref}.json`);
  const prior = fs.existsSync(templatePath) ? JSON.parse(fs.readFileSync(templatePath, 'utf8')) : null;

  // 主字段：新建的表格默认叫「文本」，按命名规范改名
  let primary = primaryField(target);
  const renamePrimary = primary.name === DEFAULT_PRIMARY;
  if (renamePrimary && !args.dryRun) {
    lark(['base', '+field-update', ...tableFlags(target, '--field-id', primary.id, '--yes',
      '--json', JSON.stringify({ type: 'text', name: PRIMARY_NAME, style: { type: 'plain' } }))]);
    primary = { ...primary, name: PRIMARY_NAME };
  }

  const { wanted, reused, missing } = alignColumns(target, io, prior, args.dryRun);
  const ordered = setColumnOrder(target, wanted, reused, primary, args.dryRun);

  const template = buildTemplate({
    io, ref: args.ref, hash, target, primaryId: primary.id, reused, prior,
  });

  console.log(`目标   ${target.table_id}  ${target.view_id}`);
  if (renamePrimary) console.log(`改名   主字段「${DEFAULT_PRIMARY}」→「${PRIMARY_NAME}」`);
  console.log(`复用   ${reused.length} 列`);
  console.log(`新建   ${missing.length} 列${missing.length ? `：${missing.map((m) => m.name).join('、')}` : ''}`);
  console.log(`列序   ${ordered.join(' → ')}`);
  console.log(`Template  ${path.relative(ROOT, templatePath)}`
    + `${prior ? `（沿用 template_id ${template.template_id.slice(0, 8)}）` : `（新 template_id ${template.template_id.slice(0, 8)}）`}`);

  const shared = siblingTemplates(target.table_id, templatePath);
  if (shared.length) {
    console.log(`\n注意   这张表已被 ${shared.join('、')} 映射了。`);
    console.log('       多个 Skill 落在同一张表是合法的：列各自独立，运行历史按 Template 分开记。');
  }

  if (args.dryRun) {
    console.log('\n[dry-run] 未建列、未改顺序、未写文件');
    return;
  }

  fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
  fs.writeFileSync(templatePath, JSON.stringify(template, null, 2) + '\n');

  // 自检：交给执行器核对 Skill 指纹、字段存在性与类型
  const check = spawnSync('node', [path.join(__dirname, 'run-template.js'), templatePath, '--dry-run'],
    { encoding: 'utf8', cwd: ROOT });
  console.log('\n自检：');
  process.stdout.write((check.stdout || check.stderr).split('\n').map((l) => (l ? `  ${l}` : l)).join('\n'));
  if (check.status !== 0) process.exit(check.status);
}

try {
  main();
} catch (err) {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
}
