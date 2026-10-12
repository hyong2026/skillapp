'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ROOT, DATA_DIR, SKILLS_DIR, TMP_DIR } = require('./paths');
const { AppError } = require('./errors');
const { readJson } = require('./json-file');
const { assertRef, readSchema, saveSchema } = require('./io-schema');

function analyzerArgs() {
  if (process.env.SKILLAPP_ANALYZE_ARGS) {
    let parsed;
    try {
      parsed = JSON.parse(process.env.SKILLAPP_ANALYZE_ARGS);
    } catch {
      throw new AppError('ANALYZER_CONFIG_INVALID', 'SKILLAPP_ANALYZE_ARGS must be a JSON array', 'Fix the analyzer configuration');
    }
    if (!Array.isArray(parsed)) {
      throw new AppError('ANALYZER_CONFIG_INVALID', 'SKILLAPP_ANALYZE_ARGS must be a JSON array', 'Fix the analyzer configuration');
    }
    return parsed.map(String);
  }
  const args = [
    'exec',
    '--ephemeral',
    '--sandbox', 'workspace-write',
    '--color', 'never',
    '-C', ROOT,
    '--add-dir', DATA_DIR,
  ];
  if (process.env.SKILLAPP_ANALYZE_MODEL) args.push('-m', process.env.SKILLAPP_ANALYZE_MODEL);
  const effort = process.env.SKILLAPP_ANALYZE_REASONING_EFFORT || 'low';
  args.push('-c', `model_reasoning_effort="${effort}"`);
  return args;
}

function promptFor(ref, skillDir, schemaPath) {
  return `Use the project skill analyze-skill-io.

Analyze the loaded Skill at:
${skillDir}

Loaded ref: ${ref}

Follow .agents/skills/analyze-skill-io/SKILL.md exactly. Inspect the Skill implementation, not just SKILL.md.
Write exactly this file and do not modify any other repository file:
- ${schemaPath}

The schema must be the complete io-schema JSON consumed by the mapping step. Pending decisions must already use the recommended defaults.`;
}

function stopChild(child, signal) {
  try { child.kill(signal); } catch { /* already exited */ }
}

function analyzeSkill({ ref: rawRef, onProgress = null } = {}) {
  const ref = assertRef(rawRef);
  const skillDir = path.join(SKILLS_DIR, ref);
  if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
    throw new AppError('SKILL_NOT_FOUND', `Loaded Skill not found: ${ref}`, 'Load the Skill first', 404);
  }

  fs.mkdirSync(TMP_DIR, { recursive: true });
  const schemaPath = path.join(TMP_DIR, `${ref}.io-schema.json`);
  fs.rmSync(schemaPath, { force: true });

  const command = process.env.SKILLAPP_ANALYZE_COMMAND || 'codex';
  const args = [...analyzerArgs(), promptFor(ref, skillDir, schemaPath)];
  const timeoutMs = Number(process.env.SKILLAPP_ANALYZE_TIMEOUT_MS || 15 * 60 * 1000);
  const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15 * 60 * 1000;

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const emit = async (progress) => {
      if (!onProgress) return;
      try { await onProgress(progress); } catch { /* progress is best effort */ }
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    emit({ stage: 'analyze', message: 'Analyzing Skill IO' });
    const child = spawn(command, args, {
      cwd: ROOT,
      env: {
        ...process.env,
        SKILLAPP_ANALYZE_REF: ref,
        SKILLAPP_ANALYZE_SKILL_DIR: skillDir,
        SKILLAPP_ANALYZE_SCHEMA_PATH: schemaPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      stopChild(child, 'SIGTERM');
      setTimeout(() => stopChild(child, 'SIGKILL'), 3000).unref?.();
    }, effectiveTimeout);

    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString('utf8')).slice(-64000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-64000); });
    child.on('error', (err) => finish(reject, new AppError(
      'ANALYZER_UNAVAILABLE',
      `Unable to start analyzer: ${err.message}`,
      'Install and log in to codex, or set SKILLAPP_ANALYZE_COMMAND',
      503,
    )));
    child.on('close', (code, signal) => {
      if (timedOut) {
        finish(reject, new AppError('ANALYZER_TIMEOUT', 'Analysis timed out', 'Increase SKILLAPP_ANALYZE_TIMEOUT_MS or retry', 504));
        return;
      }
      if (code !== 0) {
        const detail = String(stderr || stdout || '').trim().split('\n').filter(Boolean).slice(-5).join('\n');
        finish(reject, new AppError(
          'ANALYZER_FAILED',
          detail || `Analyzer exited with code ${code}${signal ? ` (${signal})` : ''}`,
          'Check analyzer authentication and logs, then retry',
          502,
        ));
        return;
      }
      try {
        const parsedSchema = readSchema(ref);
        if (!parsedSchema) {
          throw new AppError('ANALYZER_INVALID_RESULT', 'Analyzer did not write the IO Schema', 'Retry the analysis', 502);
        }
        const hash = readJson(path.join(skillDir, 'source.json')).hash;
        const schema = saveSchema(ref, parsedSchema, hash);
        finish(resolve, { ref, schema });
      } catch (err) {
        finish(reject, err);
      }
    });
  });
}

module.exports = { analyzeSkill, analyzerArgs };
