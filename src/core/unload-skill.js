import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, SKILLS_DIR, TEMPLATES_DIR, RUNS_DIR, OPERATIONS_DIR, MAPPINGS_DIR, TEMPLATE_SUFFIX, MAPPING_SUFFIX,
} from './paths.js';
import { AppError } from './errors.js';
import { assertRef } from './ref.js';

const CONTENT_DIRS = [SKILLS_DIR, TEMPLATES_DIR, RUNS_DIR, OPERATIONS_DIR, MAPPINGS_DIR];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function entries(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name !== 'README.md' && !name.startsWith('.'))
    .map((name) => path.join(dir, name));
}

function templatesOf(ref) {
  return entries(TEMPLATES_DIR)
    .filter((file) => file.endsWith(TEMPLATE_SUFFIX))
    .filter((file) => readJson(file)?.skill?.path === `skills/${ref}`);
}

function runsOf(templateIds) {
  const ids = new Set(templateIds.filter(Boolean));
  return entries(RUNS_DIR).filter((dir) => ids.has(readJson(path.join(dir, 'run.json'))?.template_id));
}

function hashPlan(value) {
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function planUnload(input = {}) {
  const withRuns = Boolean(input.withRuns ?? input.with_runs);
  const targets = [];
  const templates = [];
  let runs = [];

  if (input.all) {
    for (const dir of CONTENT_DIRS) {
      for (const target of entries(dir)) targets.push({ path: target, kind: path.basename(dir) });
    }
  } else {
    const ref = assertRef(input.ref);
    const skillDir = path.join(SKILLS_DIR, ref);
    if (!fs.existsSync(skillDir)) {
      throw new AppError('SKILL_NOT_FOUND', `Skill not found: ${ref}`, 'Refresh the Skills list', 404);
    }
    targets.push({ path: skillDir, kind: 'skill' });
    const mappingFile = path.join(MAPPINGS_DIR, `${ref}${MAPPING_SUFFIX}`);
    if (fs.existsSync(mappingFile)) targets.push({ path: mappingFile, kind: 'mapping' });

    for (const templateFile of templatesOf(ref)) {
      const template = readJson(templateFile);
      templates.push({
        ref: path.basename(templateFile, TEMPLATE_SUFFIX),
        template_id: template?.template_id || null,
        table_id: template?.target?.table_id || null,
        inputs: template?.mapping?.inputs?.length || 0,
        outputs: template?.mapping?.outputs?.length || 0,
      });
      targets.push({ path: templateFile, kind: 'template' });
    }

    runs = runsOf(templates.map((item) => item.template_id));
    if (withRuns) {
      for (const runDir of runs) targets.push({ path: runDir, kind: 'run' });
    }
  }

  const unique = [...new Map(targets.map((item) => [item.path, item])).values()]
    .sort((a, b) => relative(a.path).localeCompare(relative(b.path)));
  const removePaths = unique.map((item) => relative(item.path));
  const plan = {
    mode: input.all ? 'all' : 'skill',
    ref: input.all ? null : assertRef(input.ref),
    with_runs: withRuns,
    removals: unique.map((item) => ({ path: relative(item.path), kind: item.kind })),
    templates,
    runs: runs.map((item) => path.basename(item)),
    feishu_columns_remain: !input.all,
  };
  plan.plan_hash = hashPlan({ ...plan, removals: removePaths, runs: plan.runs.slice().sort() });
  return plan;
}

function applyUnload(input = {}, planned = null) {
  const fresh = planned || planUnload(input);
  if (!planned && (!input.planHash || input.planHash !== fresh.plan_hash)) {
    throw new AppError(
      'UNLOAD_PLAN_STALE',
      'Unload plan is missing or stale',
      'Preview the unload again, review the latest impact, then confirm',
      409,
    );
  }

  for (const removal of fresh.removals) {
    const target = path.resolve(ROOT, removal.path);
    if (!CONTENT_DIRS.some((dir) => target === dir || target.startsWith(`${dir}${path.sep}`))) {
      throw new AppError('INVALID_UNLOAD_TARGET', `Refusing to remove: ${removal.path}`, 'Refresh the unload preview');
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
  return fresh;
}

export { CONTENT_DIRS, planUnload, applyUnload };
