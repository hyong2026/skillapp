import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { lark } from './lark.js';
import { SKILLS_DIR } from './paths.js';
import { AppError } from './errors.js';
import { readJson, atomicWriteJson } from './json-file.js';
import { assertRef } from './ref.js';
import { readMapping, validateMapping, analysisStatus, isMapped } from './mapping.js';
import { findTemplateFor, templatePathFor } from './template.js';

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
      throw new AppError('UNSUPPORTED_FIELD_TYPE', `Unsupported field type: ${spec.type}`, 'Use a supported Mapping type');
  }
}

const columnName = (spec, prefix) => (spec.required ? REQUIRED_MARK : '') + prefix + spec.label;

function checkCmd(cmd, io) {
  if (!cmd) throw new AppError('INVALID_MAPPING', 'Mapping is missing cmd', 'Set the command template');
  const known = new Set(['skill.entry', 'outdir', ...io.inputs.map((item) => item.key)]);
  const unmapped = new Set(io.inputs.filter((item) => !isMapped(item)).map((item) => item.key));
  const bad = [];
  const orphans = [];
  for (const [, group] of cmd.matchAll(/\{([^{}]*)\}/g)) {
    const parts = group.split(/\s+/).filter(Boolean);
    const keys = parts.filter((part) => !part.startsWith('-')).map((part) => part.replace(/\.\.\.$/, ''));
    for (const key of keys) if (!known.has(key)) bad.push(key);
    // 成对参数（{--flag key}）在值为空时会整对省略，未映射也不算错；单独变量（{key} / {key...}）必须有值。
    if (parts.some((part) => part.startsWith('-'))) continue;
    for (const key of keys) if (unmapped.has(key)) orphans.push(key);
  }
  if (bad.length) {
    throw new AppError('INVALID_MAPPING', `cmd references unknown variables: ${[...new Set(bad)].join(', ')}`, 'Fix the command template');
  }
  if (orphans.length) {
    throw new AppError(
      'INVALID_MAPPING',
      `cmd needs unmapped inputs: ${[...new Set(orphans)].join(', ')}`,
      'Map these inputs, or drop their variables from cmd',
    );
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

/**
 * 同一张表（base + table + view）上的那份 Template 就原地更新；
 * 换表就是另一份 Template，路径由目标表决定。老命名（`<ref>.template.json`）也认。
 */
function priorTemplate(rawRef, target) {
  const ref = assertRef(rawRef);
  return findTemplateFor(ref, target) || { file: templatePathFor(ref, target), template: null };
}

function wantedColumns(io) {
  return [
    ...io.inputs.filter(isMapped).map((spec) => ({ spec, role: 'input', name: columnName(spec, INPUT_PREFIX) })),
    ...io.outputs.filter(isMapped).map((spec) => ({ spec, role: 'output', name: columnName(spec, OUTPUT_PREFIX) })),
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
        reason: `Existing type is ${live.type}; mapping requires ${wantedType}`,
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
  ...(isMapped(spec) ? {} : { mapped: false }),
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
  ...(isMapped(spec) ? {} : { mapped: false }),
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
  // 未映射的列不参与对齐，但仍要留住上一次的 field_id，重新勾选时才能复用原列。
  const priorIds = new Map([...(prior?.mapping?.inputs || []), ...(prior?.mapping?.outputs || [])]
    .map((entry) => [entry.key, entry.field_id]));
  const idOf = (key) => columns.find((column) => column.key === key)?.field_id || priorIds.get(key) || null;
  return {
    template_id: prior?.template_id || (createId ? crypto.randomUUID() : null),
    created_at: prior?.created_at || (createId ? localIso() : null),
    // 归档是人为冻结，重跑 Mapping 不该悄悄解冻。
    ...(prior?.archived_at ? { archived_at: prior.archived_at } : {}),
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
  const io = validateMapping(input.mapping || readMapping(ref));
  checkCmd(io.cmd, io);
  const sourceFile = path.join(SKILLS_DIR, ref, 'source.json');
  if (!fs.existsSync(sourceFile)) {
    throw new AppError('SKILL_NOT_LOADED', `Skill is not loaded: ${ref}`, 'Load the Skill before mapping', 404);
  }
  const skillHashValue = readJson(sourceFile).hash;
  const status = analysisStatus(skillHashValue, io);
  if (status.stale) {
    throw new AppError('ANALYSIS_STALE', 'The Mapping was generated for a different Skill version', 'Re-analyze the Skill and save the Mapping again', 409);
  }

  const target = resolveTarget(input);
  if (!target.view_id) throw new AppError('VIEW_REQUIRED', 'A view_id is required for mapping', 'Use a URL with a view parameter or provide view');
  const prior = priorTemplate(ref, target);
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
  const core = {
    ref,
    skill_hash: skillHashValue,
    mapping_hash: hash(io),
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
    mapping: io,
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
    const ioByKey = new Map([...plan.mapping.inputs, ...plan.mapping.outputs].map((spec) => [spec.key, spec]));
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

  const io = plan.mapping;
  const prior = priorTemplate(plan.ref, target);
  const template = buildTemplate({
    io,
    ref: plan.ref,
    skillHashValue: plan.skill_hash,
    target,
    primaryId: primary.id,
    columns: plan.columns,
    prior: prior.template,
    createId: true,
  });
  // 同一张表就写回原来那个文件（含老命名），换表才落到新文件名上。
  const templatePath = prior.file;
  atomicWriteJson(templatePath, template);
  return { plan, template, template_path: templatePath, order: ordered };
}

export { planMapping, applyMapping };
