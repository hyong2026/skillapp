'use strict';

const fs = require('fs');
const path = require('path');
const { TMP_DIR } = require('./paths');
const { AppError } = require('./errors');
const { atomicWriteJson } = require('./json-file');

const SCHEMA_VERSION = 1;
const FIELD_TYPES = new Set(['text', 'number', 'datetime', 'checkbox', 'attachment', 'select']);
const SAFE_REF = /^[A-Za-z0-9._-]+$/;

function assertRef(ref) {
  const value = String(ref || '').trim();
  if (!SAFE_REF.test(value) || value === '.' || value === '..') {
    throw new AppError('INVALID_SKILL_REF', 'Skill ref is invalid', 'Use letters, numbers, dots, underscores, and hyphens');
  }
  return value;
}

function schemaPath(ref, dataDir = null) {
  const root = dataDir ? path.join(dataDir, 'tmp') : TMP_DIR;
  return path.join(root, `${assertRef(ref)}.io-schema.json`);
}

function assertSpec(spec, role, index) {
  const label = `${role} ${index + 1}`;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new AppError('INVALID_IO_SCHEMA', `${label} must be an object`, 'Check the IO Schema JSON');
  }
  if (!spec.key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(spec.key)) {
    throw new AppError('INVALID_IO_SCHEMA', `${label} has an invalid key`, 'Use a simple identifier for every key');
  }
  if (!spec.label || typeof spec.label !== 'string') {
    throw new AppError('INVALID_IO_SCHEMA', `${label} is missing a label`, 'Add a human-readable label');
  }
  if (!FIELD_TYPES.has(spec.type)) {
    throw new AppError('INVALID_IO_SCHEMA', `${label} has unsupported type: ${spec.type}`, `Use one of: ${[...FIELD_TYPES].join(', ')}`);
  }
  if (spec.required !== undefined && typeof spec.required !== 'boolean') {
    throw new AppError('INVALID_IO_SCHEMA', `${label}.required must be a boolean`, 'Set required to true or false');
  }
  if (role === 'output' && (!spec.from || typeof spec.from !== 'string')) {
    throw new AppError('INVALID_IO_SCHEMA', `${label} is missing from`, 'Set from to a stdout expression');
  }
  if (spec.type === 'select' && spec.options !== undefined && !Array.isArray(spec.options)) {
    throw new AppError('INVALID_IO_SCHEMA', `${label}.options must be an array`, 'List the select options');
  }
}

function validateSchema(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('INVALID_IO_SCHEMA', 'IO Schema must be a JSON object', 'Check the IO Schema JSON');
  }
  if (!input.skill || typeof input.skill !== 'object' || !input.skill.entry) {
    throw new AppError('INVALID_IO_SCHEMA', 'IO Schema is missing skill.entry', 'Set the Skill entry script');
  }
  if (!input.cmd || typeof input.cmd !== 'string') {
    throw new AppError('INVALID_IO_SCHEMA', 'IO Schema is missing cmd', 'Set the command template');
  }
  for (const [role, key] of [['input', 'inputs'], ['output', 'outputs']]) {
    if (!Array.isArray(input[key])) {
      throw new AppError('INVALID_IO_SCHEMA', `IO Schema is missing ${key}`, `Set ${key} to an array`);
    }
    const seen = new Set();
    input[key].forEach((spec, index) => {
      assertSpec(spec, role, index);
      if (seen.has(spec.key)) {
        throw new AppError('INVALID_IO_SCHEMA', `${key} contains duplicate key: ${spec.key}`, 'Use each key once');
      }
      seen.add(spec.key);
    });
  }
  if (input.questions !== undefined && !Array.isArray(input.questions)) {
    throw new AppError('INVALID_IO_SCHEMA', 'IO Schema questions must be an array', 'Set questions to an array');
  }
  const questions = (input.questions || []).map((question, index) => {
    if (!question || typeof question !== 'object' || Array.isArray(question)) {
      throw new AppError('INVALID_IO_SCHEMA', `Question ${index + 1} must be an object`, 'Check the questions array');
    }
    const normalized = {
      ...question,
      id: String(question.id || `q${index + 1}`),
      question: String(question.question || question.title || '').trim(),
      recommendation: question.recommendation ?? question.suggestion ?? null,
      rationale: question.rationale ?? null,
      default: question.default ?? null,
      answer: question.answer ?? question.recommendation ?? question.suggestion ?? question.default ?? null,
    };
    if (!normalized.question) {
      throw new AppError('INVALID_IO_SCHEMA', `Question ${index + 1} is missing text`, 'Add the question text');
    }
    return normalized;
  });
  return {
    ...input,
    version: SCHEMA_VERSION,
    skill: { ...input.skill },
    inputs: input.inputs.map((spec) => ({ ...spec })),
    outputs: input.outputs.map((spec) => ({ ...spec })),
    questions,
  };
}

function readSchema(ref, dataDir = null) {
  const file = schemaPath(ref, dataDir);
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new AppError('INVALID_IO_SCHEMA', 'IO Schema is not valid JSON', 'Fix or regenerate the analysis result', 422);
  }
  return validateSchema(parsed);
}

function saveSchema(ref, schema, skillHashValue = null, dataDir = null) {
  const normalized = validateSchema(schema);
  normalized.version = SCHEMA_VERSION;
  normalized.skill_hash = skillHashValue || normalized.skill_hash || null;
  normalized.updated_at = new Date().toISOString();
  atomicWriteJson(schemaPath(ref, dataDir), normalized);
  return normalized;
}

function analysisStatus(ref, skillHashValue, schema) {
  if (!schema) return { state: 'missing', stale: null, reason: 'No IO Schema' };
  if (!schema.skill_hash) return { state: 'unverified', stale: null, reason: 'Schema has no Skill hash' };
  const stale = schema.skill_hash !== skillHashValue;
  return {
    state: stale ? 'stale' : 'current',
    stale,
    reason: stale ? 'Skill changed after this analysis' : 'Analysis matches the loaded Skill',
  };
}

module.exports = {
  SCHEMA_VERSION,
  FIELD_TYPES,
  assertRef,
  schemaPath,
  validateSchema,
  readSchema,
  saveSchema,
  analysisStatus,
};
