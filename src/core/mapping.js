import fs from 'node:fs';
import path from 'node:path';
import { MAPPINGS_DIR, MAPPING_SUFFIX } from './paths.js';
import { AppError } from './errors.js';
import { atomicWriteJson } from './json-file.js';
import { assertRef } from './ref.js';

const FIELD_TYPES = new Set(['text', 'number', 'datetime', 'checkbox', 'attachment', 'select']);

function mappingPath(ref, dataDir = null) {
  const dir = dataDir ? path.join(dataDir, 'mappings') : MAPPINGS_DIR;
  return path.join(dir, `${assertRef(ref)}${MAPPING_SUFFIX}`);
}

function assertSpec(spec, role, index) {
  const label = `${role} ${index + 1}`;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new AppError('INVALID_MAPPING', `${label} must be an object`, 'Check the Mapping JSON');
  }
  if (!spec.key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(spec.key)) {
    throw new AppError('INVALID_MAPPING', `${label} has an invalid key`, 'Use a simple identifier for every key');
  }
  if (!spec.label || typeof spec.label !== 'string') {
    throw new AppError('INVALID_MAPPING', `${label} is missing a label`, 'Add a human-readable label');
  }
  if (!FIELD_TYPES.has(spec.type)) {
    throw new AppError('INVALID_MAPPING', `${label} has unsupported type: ${spec.type}`, `Use one of: ${[...FIELD_TYPES].join(', ')}`);
  }
  if (spec.required !== undefined && typeof spec.required !== 'boolean') {
    throw new AppError('INVALID_MAPPING', `${label}.required must be a boolean`, 'Set required to true or false');
  }
  if (role === 'output' && (!spec.from || typeof spec.from !== 'string')) {
    throw new AppError('INVALID_MAPPING', `${label} is missing from`, 'Set from to a stdout expression');
  }
  if (spec.type === 'select' && spec.options !== undefined && !Array.isArray(spec.options)) {
    throw new AppError('INVALID_MAPPING', `${label}.options must be an array`, 'List the select options');
  }
}

function validateMapping(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('INVALID_MAPPING', 'Mapping must be a JSON object', 'Check the Mapping JSON');
  }
  if (!input.skill || typeof input.skill !== 'object' || !input.skill.entry) {
    throw new AppError('INVALID_MAPPING', 'Mapping is missing skill.entry', 'Set the Skill entry script');
  }
  if (!input.cmd || typeof input.cmd !== 'string') {
    throw new AppError('INVALID_MAPPING', 'Mapping is missing cmd', 'Set the command template');
  }
  for (const [role, key] of [['input', 'inputs'], ['output', 'outputs']]) {
    if (!Array.isArray(input[key])) {
      throw new AppError('INVALID_MAPPING', `Mapping is missing ${key}`, `Set ${key} to an array`);
    }
    const seen = new Set();
    input[key].forEach((spec, index) => {
      assertSpec(spec, role, index);
      if (seen.has(spec.key)) {
        throw new AppError('INVALID_MAPPING', `${key} contains duplicate key: ${spec.key}`, 'Use each key once');
      }
      seen.add(spec.key);
    });
  }
  return {
    ...input,
    skill: { ...input.skill },
    inputs: input.inputs.map((spec) => ({ ...spec })),
    outputs: input.outputs.map((spec) => ({ ...spec })),
  };
}

function readMapping(ref, dataDir = null) {
  const file = mappingPath(ref, dataDir);
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new AppError('INVALID_MAPPING', 'Mapping is not valid JSON', 'Fix or re-run the analysis', 422);
  }
  return validateMapping(parsed);
}

function saveMapping(ref, schema, skillHashValue = null, dataDir = null) {
  const normalized = validateMapping(schema);
  normalized.skill_hash = skillHashValue || normalized.skill_hash || null;
  normalized.updated_at = new Date().toISOString();
  atomicWriteJson(mappingPath(ref, dataDir), normalized);
  return normalized;
}

/** 判断这份 Mapping 是否还对得上当前 Skill 内容。 */
function analysisStatus(skillHashValue, mapping) {
  if (!mapping) return { state: 'missing', stale: null, reason: 'No Mapping' };
  if (!mapping.skill_hash) return { state: 'unverified', stale: null, reason: 'Mapping has no Skill hash' };
  const stale = mapping.skill_hash !== skillHashValue;
  return {
    state: stale ? 'stale' : 'current',
    stale,
    reason: stale ? 'Skill changed after this analysis' : 'Analysis matches the loaded Skill',
  };
}

export {
  FIELD_TYPES,
  mappingPath,
  validateMapping,
  readMapping,
  saveMapping,
  analysisStatus,
};
