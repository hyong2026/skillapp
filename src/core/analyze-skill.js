import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, DATA_DIR, SKILLS_DIR, MAPPINGS_DIR } from './paths.js';
import { AppError } from './errors.js';
import { readJson } from './json-file.js';
import { assertRef } from './ref.js';
import { readMapping, saveMapping, validateMapping } from './mapping.js';

function analyzerArgs(outputPath = null) {
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
    // 不把仓库 AGENTS.md 注入分析器上下文：那是给开发 Agent 看的规则，与"分析技能"无关。
    '-c', 'project_doc_max_bytes=0',
  ];
  if (process.env.SKILLAPP_ANALYZE_MODEL) args.push('-m', process.env.SKILLAPP_ANALYZE_MODEL);
  const effort = process.env.SKILLAPP_ANALYZE_REASONING_EFFORT || 'low';
  args.push('-c', `model_reasoning_effort="${effort}"`);
  // 结果从「最后一条消息」收：模型不用再花一个回合去写文件。
  if (outputPath) args.push('-o', outputPath);
  return args;
}

/**
 * 分析器上下文：把「规则 + 文件清单 + SKILL.md」直接内联进 prompt。
 * 好处是模型不必先花回合去探索目录、找样例 mapping，也不会在 node_modules 里打转（这里只把它排除在清单外）。
 */
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build']);

function fileInventory(dir, prefix = '', out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) fileInventory(path.join(dir, entry.name), rel, out);
    else out.push(rel);
  }
  return out.sort();
}

function analyzerRules() {
  return fs.readFileSync(path.join(ROOT, '.agents', 'skills', 'analyze-skill', 'SKILL.md'), 'utf8');
}

function promptFor(ref, skillDir, mappingPath, { outputPath = null } = {}) {
  const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  const files = fileInventory(skillDir);
  const delivery = outputPath
    ? `最后一条消息**只放 Mapping JSON 本身**（不要代码块围栏、不要任何前后解释），SkillApp 会自己落盘。`
    : `把 Mapping JSON 写进这个文件，不要修改任何其它文件：\n- ${mappingPath}`;
  return `分析这个已装载的 Skill，产出一份可执行的 Mapping。

Skill 根目录：${skillDir}
ref：${ref}

规则（完整，不需要再去读文件核对）：
${analyzerRules()}

该 Skill 的文件清单（已排除 node_modules 等无关目录；真正的入口就在其中）：
${files.map((file) => `- ${file}`).join('\n')}

SKILL.md 内容：
${skillMd}

交付要求：
- 以实现为准：按上面的清单读入口实现即可，**不要探索仓库、不要搜索其它 *.mapping.json 样例、不要执行 find /、不要用 cat -A / od / hexdump 反复看同一个文件**。
- 所有判断都已经落进 Mapping（列、类型、必填、默认值、transform），没有独立报告、没有 questions。
- ${delivery} 这与 analyze-skill 规则里"写 .data/mappings/<ref>.mapping.json"的分工不同：落盘由 SkillApp 负责。`;
}

/** 从文本里取 JSON：容忍 ```json 围栏，取最外层 `{...}`。 */
function parseJsonBlock(text) {
  const raw = String(text || '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 分析结果：优先取 --output-last-message（单回合交付）；兜底读模型自己写的 mapping 文件。 */
function analyzerMapping(ref, outputPath) {
  const message = outputPath && fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  const parsed = parseJsonBlock(message);
  if (parsed) return validateMapping(parsed);
  try {
    return readMapping(ref);
  } catch {
    return null;
  }
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
  // 覆盖了 SKILLAPP_ANALYZE_ARGS 时不塞 -o（那时只能靠模型自己写文件），prompt 也跟着换回写文件。
  const outputPath = process.env.SKILLAPP_ANALYZE_ARGS
    ? null
    : path.join(os.tmpdir(), `skillapp-analyze-${process.pid}-${Date.now()}.json`);
  const args = [...analyzerArgs(outputPath), promptFor(ref, skillDir, mappingPath, { outputPath })];
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
        const parsedMapping = analyzerMapping(ref, outputPath);
        if (!parsedMapping) {
          throw new AppError('ANALYZER_INVALID_RESULT', 'Analyzer did not return a Mapping', 'Retry the analysis', 502);
        }
        const hash = readJson(path.join(skillDir, 'source.json')).hash;
        const mapping = saveMapping(ref, keepUnmappedFlags(parsedMapping, priorMapping), hash);
        finish(resolve, { ref, mapping });
      } catch (err) {
        finish(reject, err);
      } finally {
        if (outputPath) fs.rmSync(outputPath, { force: true });
      }
    });
  });
}

export { analyzeSkill };
