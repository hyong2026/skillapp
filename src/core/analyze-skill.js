import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, DATA_DIR, SKILLS_DIR, MAPPINGS_DIR } from './paths.js';
import { AppError } from './errors.js';
import { readJson } from './json-file.js';
import { assertRef } from './ref.js';
import { readMapping, saveMapping } from './mapping.js';

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

function promptFor(ref, skillDir, mappingPath) {
  return `Use the project skill analyze-skill-io.

Analyze the loaded Skill at:
${skillDir}

Loaded ref: ${ref}

Follow .agents/skills/analyze-skill-io/SKILL.md exactly. Inspect the Skill implementation, not just SKILL.md.
Write exactly this file and do not modify any other repository file:
- ${mappingPath}

Write the complete Mapping JSON consumed by the mapping step. Every judgement call must already be applied in it (columns, types, required, defaults, transforms) — there is no separate questions list.`;
}

function stopChild(child, signal) {
  try { child.kill(signal); } catch { /* already exited */ }
}

/**
 * 重分析会重写整份 Mapping，但「未映射」是用户在面板上做的选择，按 key 保留。
 * 新分析若把某个输入标成必填，以必填为准（必填输入不能未映射）。
 */
function keepUnmappedFlags(next, prior) {
  const wasUnmapped = new Set([...(prior?.inputs || []), ...(prior?.outputs || [])]
    .filter((spec) => spec.mapped === false)
    .map((spec) => spec.key));
  for (const spec of [...next.inputs, ...next.outputs]) {
    if (wasUnmapped.has(spec.key) && spec.required !== true) spec.mapped = false;
  }
  return next;
}

/** 旧 Mapping 可能已经损坏——读不出来就当没有，分析结果才是事实。 */
function priorMappingOrNull(ref) {
  try {
    return readMapping(ref);
  } catch {
    return null;
  }
}

function analyzeSkill({ ref: rawRef, onProgress = null } = {}) {
  const ref = assertRef(rawRef);
  const skillDir = path.join(SKILLS_DIR, ref);
  if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
    throw new AppError('SKILL_NOT_FOUND', `Loaded Skill not found: ${ref}`, 'Load the Skill first', 404);
  }

  fs.mkdirSync(MAPPINGS_DIR, { recursive: true });
  const mappingPath = path.join(MAPPINGS_DIR, `${ref}.mapping.json`);
  const priorMapping = priorMappingOrNull(ref);
  fs.rmSync(mappingPath, { force: true });

  const command = process.env.SKILLAPP_ANALYZE_COMMAND || 'codex';
  const args = [...analyzerArgs(), promptFor(ref, skillDir, mappingPath)];
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
        SKILLAPP_ANALYZE_MAPPING_PATH: mappingPath,
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
        const parsedMapping = readMapping(ref);
        if (!parsedMapping) {
          throw new AppError('ANALYZER_INVALID_RESULT', 'Analyzer did not write the Mapping', 'Retry the analysis', 502);
        }
        const hash = readJson(path.join(skillDir, 'source.json')).hash;
        const mapping = saveMapping(ref, keepUnmappedFlags(parsedMapping, priorMapping), hash);
        finish(resolve, { ref, mapping });
      } catch (err) {
        finish(reject, err);
      }
    });
  });
}

export { analyzeSkill, analyzerArgs };
