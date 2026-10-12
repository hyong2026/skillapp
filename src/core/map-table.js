'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { lark } = require('./lark');
const { ROOT, SKILLS_DIR, TEMPLATES_DIR } = require('./paths');
const { AppError } = require('./errors');
const { readJson, atomicWriteJson } = require('./json-file');
const { assertRef, readSchema, validateSchema, analysisStatus } = require('./io-schema');

const INPUT_PREFIX = 'in: ';
const OUTPUT_PREFIX = 'out: ';
const REQUIRED_MARK = '＊';
const PRIMARY_NAME = '任务名称';
const DEFAULT_PRIMARY = '文本';
const CREATE_ATTEMPTS = 10;
const CREATE_WAIT_S = 3;

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
};
const hash = (value) => 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const tableFlags = (target, ...rest) => ['--base-token', target.base_token, '--table-id', target.table_id, '--as', 'user', ...rest];
const readFields = (target) => lark(['base', '+field-list', ...tableFlags(target)]).data.fields;
const sleep = (seconds) => spawnSync('sleep', [String(seconds)]);

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
      throw new AppError('UNSUPPORTED_FIELD_TYPE', `Unsupported field type: ${spec.type}`, 'Use a supported IO Schema type');
  }
}

const columnName = (spec, prefix) => (spec.required ? REQUIRED_MARK : '') + prefix + spec.label;

function checkCmd(cmd, io) {
  if (!cmd) throw new AppError('INVALID_IO_SCHEMA', 'IO Schema is missing cmd', 'Set the command template');
  const known = new Set(['skill.entry', 'outdir', ...io.inputs.map((item) => item.key)]);
  const bad = [];
  for (const [, group] of cmd.matchAll(/\{([^{}]*)\}/g)) {
    const keys = group.split(/\s+/).filter((part) => part && !part.startsWith('-')).map((part) => part.replace(/\.\.\.$/, ''));
    for (const key of keys) if (!known.has(key)) bad.push(key);
  }
  if (bad.length) {
    throw new AppError('INVALID_IO_SCHEMA', `cmd references unknown variables: ${[...new Set(bad)].join(', ')}`, 'Fix the command template');
  }
}

function resolveTarget(input = {}) {
  if (input.url) {
    const data = lark(['base', '+url-resolve', '--url', input.url, '--as', 'user']).data;
    return { base_token: data.base_token, table_id: data.table_id, view_id: input.view || data.view_id };
  }
  const base = input.base || input.base_token;
  const table = input.table || input.table_id;
  if (!base || !table) {
    throw new AppError('INVALID_TARGET', 'A Feishu Base URL or Base/Table pair is required', 'Paste a Feishu Base URL with table and view parameters');
  }
  return { base_token: base, table_id: table, view_id: input.view || input.view_id || null };
}

function primaryField(target) {
  const visible = lark(['base', '+view-get-visible-fields', ...tableFlags(target, '--view-id', target.view_id)]).data.visible_fields || [];
  const first = visible[0];
  const field = readFields(target).find((item) => item.name === first);
  if (!field) throw new AppError('PRIMARY_FIELD_NOT_FOUND', `Primary field not found: ${first || 'unknown'}`, 'Check the target view');
  return field;
}

function priorTemplate(ref) {
  const file = path.join(TEMPLATES_DIR, `${assertRef(ref)}.json`);
  return fs.existsSync(file) ? { file, template: readJson(file) } : { file, template: null };
}

function wantedColumns(io) {
  return [
    ...io.inputs.map((spec) => ({ spec, role: 'input', name: columnName(spec, INPUT_PREFIX) })),
    ...io.outputs.map((spec) => ({ spec, role: 'output', name: columnName(spec, OUTPUT_PREFIX) })),
  ];
}

function alignColumns(target, io, prior) {
  const priorIds = new Map();
  for (const entry of [...(prior?.mapping?.inputs || []), ...(prior?.mapping?.outputs || [])]) {
    priorIds.set(entry.key, entry.field_id);
  }
  const fields = readFields(target);
  const byId = new Map(fields.map((field) => [field.id, field]));
  const byName = new Map(fields.map((field) => [field.name, field]));
  return wantedColumns(io).map((wanted) => {
    const live = byId.get(priorIds.get(wanted.spec.key)) || byName.get(wanted.name);
    if (!live) {
      return {
        role: wanted.role,
        key: wanted.spec.key,
        name: wanted.name,
        type: wanted.spec.type,
        required: Boolean(wanted.spec.required),
        field_id: null,
        action: 'create',
        reason: 'No matching field id or name',
      };
    }
    const wantedType = fieldJson(wanted.spec).type;
    if (live.type !== wantedType) {
      return {
        role: wanted.role,
        key: wanted.spec.key,
        name: wanted.name,
        type: wanted.spec.type,
        required: Boolean(wanted.spec.required),
        field_id: live.id,
        live_name: live.name,
        live_type: live.type,
        action: 'conflict',
        reason: `Existing type is ${live.type}; schema requires ${wantedType}`,
      };
    }
    return {
      role: wanted.role,
      key: wanted.spec.key,
      name: wanted.name,
      type: wanted.spec.type,
      required: Boolean(wanted.spec.required),
      field_id: live.id,
      live_name: live.name,
      action: 'reuse',
      reason: live.name === wanted.name ? 'Matched by name' : 'Matched by prior field id',
    };
  });
}

function plannedOrder(target, primary, columns) {
  const fields = readFields(target);
  const idToName = new Map(fields.map((field) => [field.id, field.name]));
  const ordered = [primary.name];
  for (const column of columns) ordered.push(idToName.get(column.field_id) || column.name);
  for (const field of fields) if (!ordered.includes(field.name)) ordered.push(field.name);
  return ordered;
}

const inputEntry = (spec, fieldId) => ({
  key: spec.key,
  field_id: fieldId,
  type: spec.type,
  ...(spec.required ? { required: true } : {}),
  ...(spec.default === undefined ? {} : { default: spec.default }),
  ...(spec.validate ? { validate: spec.validate } : {}),
  ...(spec.transform ? { transform: spec.transform } : {}),
});

const outputEntry = (spec, fieldId) => ({
  key: spec.key,
  field_id: fieldId,
  type: spec.type,
  from: spec.from,
  ...(spec.round === undefined ? {} : { round: spec.round }),
});

function localIso() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const [sign, abs] = [offset >= 0 ? '+' : '-', Math.abs(offset)];
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function buildTemplate({ io, ref, skillHashValue, target, primaryId, columns, prior, createId = false }) {
  const idOf = (key) => columns.find((column) => column.key === key)?.field_id || null;
  return {
    template_id: prior?.template_id || (createId ? crypto.randomUUID() : null),
    created_at: prior?.created_at || (createId ? localIso() : null),
    skill: { path: `skills/${assertRef(ref)}`, hash: skillHashValue, entry: io.skill.entry },
    target: { ...target, primary_field_id: primaryId },
    mapping: {
      cmd: io.cmd,
      inputs: io.inputs.map((spec) => inputEntry(spec, idOf(spec.key))),
      outputs: io.outputs.map((spec) => outputEntry(spec, idOf(spec.key))),
    },
    ...(io.limits ? { limits: io.limits } : {}),
  };
}

function planMapping(input = {}) {
  const ref = assertRef(input.ref);
  const io = validateSchema(input.schema || readSchema(ref));
  checkCmd(io.cmd, io);
  const sourceFile = path.join(SKILLS_DIR, ref, 'source.json');
  if (!fs.existsSync(sourceFile)) {
    throw new AppError('SKILL_NOT_LOADED', `Skill is not loaded: ${ref}`, 'Load the Skill before mapping', 404);
  }
  const skillHashValue = readJson(sourceFile).hash;
  const status = analysisStatus(ref, skillHashValue, io);
  if (status.stale) {
    throw new AppError('ANALYSIS_STALE', 'The IO Schema was generated for a different Skill version', 'Re-analyze the Skill and save the IO Schema again', 409);
  }

  const target = resolveTarget(input);
  if (!target.view_id) throw new AppError('VIEW_REQUIRED', 'A view_id is required for mapping', 'Use a URL with a view parameter or provide view');
  const prior = priorTemplate(ref);
  const primary = primaryField(target);
  const columns = alignColumns(target, io, prior.template);
  const renamePrimary = primary.name === DEFAULT_PRIMARY ? { from: primary.name, to: PRIMARY_NAME, will_rename: true } : null;
  const order = plannedOrder(target, renamePrimary ? { ...primary, name: PRIMARY_NAME } : primary, columns);
  const specByKey = new Map([...io.inputs, ...io.outputs].map((spec) => [spec.key, spec]));
  const typeConflicts = columns.filter((column) => column.action === 'conflict').map((column) => ({
    key: column.key,
    name: column.live_name || column.name,
    existing_type: column.live_type,
    required_type: specByKey.get(column.key).type,
  }));
  const requiredRisks = columns.filter((column) => column.required && column.action === 'create').map((column) => ({
    key: column.key,
    name: column.name,
    message: 'Required input will be created; existing rows need a value before a run',
  }));
  const liveFingerprint = hash({
    fields: readFields(target).map(({ id, name, type }) => ({ id, name, type })).sort((a, b) => a.id.localeCompare(b.id)),
    visible: lark(['base', '+view-get-visible-fields', ...tableFlags(target, '--view-id', target.view_id)]).data.visible_fields || [],
    primary: primary.id,
  });
  const priorHash = prior.template ? hash(prior.template) : null;
  const decisions = (io.questions || []).map((question) => ({
    id: question.id,
    question: question.question,
    recommendation: question.recommendation,
    rationale: question.rationale,
    default: question.default,
    answer: question.answer ?? question.recommendation ?? question.default ?? null,
  }));
  const core = {
    version: 1,
    ref,
    skill_hash: skillHashValue,
    schema_hash: hash(io),
    live_fingerprint: liveFingerprint,
    prior_hash: priorHash,
    target,
    primary_field_id: primary.id,
    rename_primary: renamePrimary,
    columns: columns.map(({ role, key, name, type, required, field_id, live_name, action, reason }) => ({
      role, key, name, type, required, field_id, live_name: live_name || null, action, reason,
    })),
    create: columns.filter((column) => column.action === 'create').map((column) => column.name),
    reuse: columns.filter((column) => column.action === 'reuse').map((column) => column.name),
    decisions,
    order,
  };
  const planHash = hash(core);
  const template = buildTemplate({
    io,
    ref,
    skillHashValue,
    target,
    primaryId: primary.id,
    columns,
    prior: prior.template,
  });
  return {
    ...core,
    plan_hash: planHash,
    diff: {
      create: core.create,
      reuse: core.reuse,
      rename_primary: renamePrimary,
      type_conflicts: typeConflicts,
      required_risks: requiredRisks,
      order,
    },
    type_conflicts: typeConflicts,
    required_risks: requiredRisks,
    template,
    schema: io,
  };
}

function applyMapping(input = {}, planned = null) {
  const planHash = input.planHash || input.plan_hash;
  const plan = planned || planMapping(input);
  if (!planned && (!planHash || planHash !== plan.plan_hash)) {
    throw new AppError(
      'MAPPING_PLAN_STALE',
      `Mapping plan is missing or stale (provided ${planHash || 'none'}, current ${plan.plan_hash})`,
      'Preview the mapping again, review the latest changes, then apply',
      409,
    );
  }
  if (plan.type_conflicts.length) {
    throw new AppError('MAPPING_CONFLICT', `Type conflict: ${plan.type_conflicts[0].name}`, 'Resolve the type conflict before applying', 409);
  }

  const target = plan.target;
  let primary = primaryField(target);
  if (plan.rename_primary?.will_rename) {
    lark(['base', '+field-update', ...tableFlags(target, '--field-id', primary.id, '--yes',
      '--json', JSON.stringify({ type: 'text', name: PRIMARY_NAME, style: { type: 'plain' } }))]);
    primary = { ...primary, name: PRIMARY_NAME };
  }

  const create = plan.columns.filter((column) => column.action === 'create');
  if (create.length) {
    const ioByKey = new Map([...plan.schema.inputs, ...plan.schema.outputs].map((spec) => [spec.key, spec]));
    const payload = create.map((column) => {
      const spec = ioByKey.get(column.key);
      return {
        ...fieldJson(spec),
        name: column.name,
        ...(spec.hint ? { description: spec.hint } : {}),
      };
    });
    lark(['base', '+field-create', ...tableFlags(target, '--json', JSON.stringify(payload))]);

    let after = new Map();
    let unresolved = create;
    for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++) {
      after = new Map(readFields(target).map((field) => [field.name, field]));
      unresolved = create.filter((column) => !after.has(column.name));
      if (!unresolved.length) break;
      if (attempt < CREATE_ATTEMPTS - 1) sleep(CREATE_WAIT_S);
    }
    if (unresolved.length) {
      throw new AppError(
        'FIELD_PROPAGATION_TIMEOUT',
        `新建后仍找不到列（飞书字段传播延迟）: ${unresolved.map((column) => column.name).join('、')}`,
        '列已经建好了，重跑本命令即可——它按列名复用，是幂等的',
        504,
      );
    }
    for (const column of create) column.field_id = after.get(column.name).id;
  }

  const idToName = new Map(readFields(target).map((field) => [field.id, field.name]));
  const ordered = [primary.name];
  for (const column of plan.columns) ordered.push(idToName.get(column.field_id) || column.name);
  for (const field of readFields(target)) if (!ordered.includes(field.name)) ordered.push(field.name);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      lark(['base', '+view-set-visible-fields', ...tableFlags(target,
        '--view-id', target.view_id, '--json', JSON.stringify({ visible_fields: ordered }))]);
      break;
    } catch (err) {
      if (attempt === 2) throw err;
      sleep(2);
    }
  }

  const io = plan.schema;
  const prior = priorTemplate(plan.ref).template;
  const template = buildTemplate({
    io,
    ref: plan.ref,
    skillHashValue: plan.skill_hash,
    target,
    primaryId: primary.id,
    columns: plan.columns,
    prior,
    createId: true,
  });
  const templatePath = path.join(TEMPLATES_DIR, `${plan.ref}.json`);
  atomicWriteJson(templatePath, template);
  return { plan, template, template_path: templatePath, order: ordered };
}

module.exports = {
  INPUT_PREFIX,
  OUTPUT_PREFIX,
  REQUIRED_MARK,
  PRIMARY_NAME,
  DEFAULT_PRIMARY,
  fieldJson,
  columnName,
  checkCmd,
  resolveTarget,
  primaryField,
  planMapping,
  applyMapping,
  buildTemplate,
};
