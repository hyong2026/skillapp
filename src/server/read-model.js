import fs from 'node:fs';
import path from 'node:path';
import { analysisStatus } from '../core/mapping.js';
import { TEMPLATE_SUFFIX } from '../core/paths.js';

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const IGNORED = new Set(['README.md', '.DS_Store']);

class HttpError extends Error {
  constructor(status, code, message, action = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.action = action;
  }
}

const isWithin = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

const assertSegment = (value, label) => {
  if (!value || !SAFE_SEGMENT.test(value) || value === '.' || value === '..') {
    throw new HttpError(400, 'INVALID_PATH', `${label} is invalid`, 'Check the request path');
  }
  return value;
};

const readJson = (file, label) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new HttpError(500, 'INVALID_DATA', `${label} is not valid JSON`, `Check ${path.relative(process.cwd(), file)}`);
  }
};

/** Template 的 ref 以 `skill.path` 为准——文件名现在带目标表指纹。 */
const templateRef = (template, file) => {
  const fromSkill = path.basename(String(template?.skill?.path || ''));
  return fromSkill && fromSkill !== '.' ? fromSkill : path.basename(file, TEMPLATE_SUFFIX);
};

const maybeJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/** 日志按文本读；早期 Run 存的是 JSON 包装，读旧格式时把里面的文本取出来。 */
function readLog(recordDir, stream) {
  const file = path.join(recordDir, 'logs', `${stream}.log`);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');

  const legacy = maybeJson(path.join(recordDir, 'logs', `${stream}.json`));
  if (legacy === null) return null;
  const data = legacy.data;
  if (data && typeof data === 'object' && 'raw' in data) return String(data.raw);
  return JSON.stringify(data, null, 2);
}

function listFiles(root, predicate = () => true) {
  if (!fs.existsSync(root)) return [];

  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || IGNORED.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && predicate(full)) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

function walkArtifacts(base, dir = base) {
  if (!fs.existsSync(dir)) return [];
  const out = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkArtifacts(base, full));
    else if (entry.isFile()) {
      const stat = fs.statSync(full);
      out.push({
        name: entry.name,
        path: path.relative(base, full).split(path.sep).join('/'),
        size: stat.size,
        modified_at: stat.mtime.toISOString(),
      });
    }
  }

  return out.sort((a, b) => a.path.localeCompare(b.path));
}

class ReadModel {
  constructor(root) {
    this.root = path.resolve(root);
    this.skillsDir = path.join(this.root, 'skills');
    this.templatesDir = path.join(this.root, 'templates');
    this.runsDir = path.join(this.root, 'runs');
    this.mappingsDir = path.join(this.root, 'mappings');
    this.operationsDir = path.join(this.root, 'operations');
  }

  status() {
    const skills = this.listSkills();
    const runs = this.listRuns();
    const templates = this.listTemplates(runs);
    return {
      readonly: false,
      generated_at: new Date().toISOString(),
      counts: {
        skills: skills.length,
        valid_skills: skills.filter((s) => s.valid).length,
        templates: templates.length,
        runs: runs.length,
        failed_runs: runs.filter((r) => r.status === 'failed' || r.status === 'partial').length,
      },
    };
  }

  listSkills() {
    if (!fs.existsSync(this.skillsDir)) return [];

    return fs.readdirSync(this.skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => this.skillSummary(entry.name))
      .sort((a, b) => String(b.loaded_at || '').localeCompare(String(a.loaded_at || '')) || a.ref.localeCompare(b.ref));
  }

  skillSummary(ref) {
    assertSegment(ref, 'Skill ref');
    const dir = path.join(this.skillsDir, ref);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new HttpError(404, 'SKILL_NOT_FOUND', `Skill not found: ${ref}`, 'Refresh the Skills list');
    }

    const source = maybeJson(path.join(dir, 'source.json')) || {};
    const skillFile = path.join(dir, 'SKILL.md');
    const stat = fs.existsSync(skillFile) ? fs.statSync(skillFile) : null;
    return {
      ref,
      valid: Boolean(stat),
      hash: source.hash || null,
      description: source.description || null,
      source: source.source || null,
      loaded_at: source.loaded_at || null,
      updated_at: stat ? stat.mtime.toISOString() : null,
    };
  }

  getSkill(ref) {
    const summary = this.skillSummary(ref);
    const mapping = maybeJson(path.join(this.mappingsDir, `${ref}.mapping.json`));
    return {
      ...summary,
      analysis: { mapping, ...analysisStatus(summary.hash, mapping) },
    };
  }

  templateFiles() {
    if (!fs.existsSync(this.templatesDir)) return [];
    return fs.readdirSync(this.templatesDir)
      .filter((name) => name.endsWith(TEMPLATE_SUFFIX) && !name.startsWith('.'))
      .map((name) => path.join(this.templatesDir, name))
      .sort();
  }

  listTemplates(runs = null, { includeArchived = false } = {}) {
    const runList = runs || this.listRuns();
    const lastRuns = new Map();
    for (const run of runList) {
      if (!lastRuns.has(run.template_id)) lastRuns.set(run.template_id, run);
    }

    return this.templateFiles().map((file) => {
      const tpl = readJson(file, `Template ${path.basename(file)}`);
      return {
        ref: templateRef(tpl, file),
        // Template Name 就是文件名（`<ref>-<目标指纹>`），末尾带 Hash。
        name: path.basename(file, TEMPLATE_SUFFIX),
        template_id: tpl.template_id || null,
        created_at: tpl.created_at || null,
        archived_at: tpl.archived_at || null,
        skill: tpl.skill || null,
        target: tpl.target || null,
        inputs: tpl.mapping?.inputs?.length || 0,
        outputs: tpl.mapping?.outputs?.length || 0,
        last_run: lastRuns.get(tpl.template_id) || null,
      };
    })
      // 归档默认不出现（文件还在，Run 里按 template_id 仍能打开）；要看得显式要。
      .filter((item) => includeArchived || !item.archived_at)
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  }

  findTemplateFile(id) {
    assertSegment(id, 'Template id');
    return this.templateFiles().find((candidate) => {
      if (path.basename(candidate, TEMPLATE_SUFFIX) === id) return true;
      try {
        return JSON.parse(fs.readFileSync(candidate, 'utf8')).template_id === id;
      } catch {
        return false;
      }
    }) || null;
  }

  getTemplate(id) {
    const file = this.findTemplateFile(id);
    if (!file) {
      throw new HttpError(404, 'TEMPLATE_NOT_FOUND', `Template not found: ${id}`, 'Refresh the Templates list');
    }

    const template = readJson(file, `Template ${path.basename(file)}`);
    return {
      ref: templateRef(template, file),
      name: path.basename(file, TEMPLATE_SUFFIX),
      template,
    };
  }

  /** `includeDeleted` 只影响"看得到看不到"：逻辑删除的 Run 文件仍在，详情照样打得开。 */
  listRuns({ includeDeleted = false } = {}) {
    if (!fs.existsSync(this.runsDir)) return [];

    return fs.readdirSync(this.runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => {
        const file = path.join(this.runsDir, entry.name, 'run.json');
        if (!fs.existsSync(file)) return null;
        const run = readJson(file, `Run ${entry.name}`);
        const items = Array.isArray(run.items) ? run.items : [];
        return {
          run_id: run.run_id || entry.name,
          template_id: run.template_id || null,
          template_name: run.template_name || null,
          status: run.status || 'unknown',
          trigger: run.trigger || null,
          started_at: run.started_at || null,
          finished_at: run.finished_at || null,
          skill_hash: run.skill_hash || null,
          work_hash: run.work_hash || null,
          deleted_at: run.deleted_at || null,
          total: items.length,
          succeeded: run.succeeded ?? items.filter((item) => item.status === 'succeeded').length,
          failed: run.failed ?? items.filter((item) => item.status === 'failed').length,
        };
      })
      .filter(Boolean)
      .filter((run) => includeDeleted || !run.deleted_at)
      .sort((a, b) => String(b.started_at || b.run_id).localeCompare(String(a.started_at || a.run_id)));
  }

  getRun(runId) {
    assertSegment(runId, 'Run id');
    const file = path.join(this.runsDir, runId, 'run.json');
    if (!fs.existsSync(file)) {
      throw new HttpError(404, 'RUN_NOT_FOUND', `Run not found: ${runId}`, 'Refresh the Runs list');
    }
    return readJson(file, `Run ${runId}`);
  }

  getRunItem(runId, recordId) {
    assertSegment(runId, 'Run id');
    assertSegment(recordId, 'Record id');
    const run = this.getRun(runId);
    const item = (run.items || []).find((candidate) => candidate.record_id === recordId);
    if (!item) {
      throw new HttpError(404, 'RUN_ITEM_NOT_FOUND', `Record not found: ${recordId} in run ${runId}`, 'Refresh the Run details');
    }

    const recordDir = path.join(this.runsDir, runId, recordId);
    return {
      ...item,
      logs: {
        stdout: readLog(recordDir, 'stdout'),
        stderr: readLog(recordDir, 'stderr'),
      },
      artifacts: walkArtifacts(path.join(recordDir, 'artifacts')),
    };
  }

  artifactPath(runId, recordId, relativePath) {
    assertSegment(runId, 'Run id');
    assertSegment(recordId, 'Record id');
    if (!relativePath || path.isAbsolute(relativePath)) {
      throw new HttpError(400, 'INVALID_ARTIFACT_PATH', 'Artifact path is invalid', 'Return to Run details and open it again');
    }

    const base = path.join(this.runsDir, runId, recordId, 'artifacts');
    const full = path.resolve(base, relativePath);
    if (!isWithin(base, full)) {
      throw new HttpError(400, 'INVALID_ARTIFACT_PATH', 'Artifact path is invalid', 'Return to Run details and open it again');
    }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      throw new HttpError(404, 'ARTIFACT_NOT_FOUND', 'Artifact not found', 'Refresh the Run details');
    }

    const realBase = fs.realpathSync(base);
    const realFull = fs.realpathSync(full);
    if (!isWithin(realBase, realFull)) {
      throw new HttpError(400, 'INVALID_ARTIFACT_PATH', 'Artifact path is invalid', 'Return to Run details and open it again');
    }
    return realFull;
  }
}

export { ReadModel, HttpError, isWithin };
