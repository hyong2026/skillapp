'use strict';

const fs = require('fs');
const path = require('path');

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

const maybeJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const maybeText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

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
    this.tmpDir = path.join(this.root, 'tmp');
  }

  status() {
    const skills = this.listSkills();
    const runs = this.listRuns();
    const templates = this.listTemplates(runs);
    return {
      readonly: true,
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
      .sort((a, b) => a.ref.localeCompare(b.ref));
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
      source: source.source || null,
      loaded_at: source.loaded_at || null,
      updated_at: stat ? stat.mtime.toISOString() : null,
    };
  }

  getSkill(ref) {
    const summary = this.skillSummary(ref);
    return {
      ...summary,
      analysis: {
        report: maybeText(path.join(this.tmpDir, `${ref}.io-report.md`)),
        schema: maybeJson(path.join(this.tmpDir, `${ref}.io-schema.json`)),
      },
    };
  }

  templateFiles() {
    if (!fs.existsSync(this.templatesDir)) return [];
    return fs.readdirSync(this.templatesDir)
      .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
      .map((name) => path.join(this.templatesDir, name))
      .sort();
  }

  listTemplates(runs = null) {
    const runList = runs || this.listRuns();
    const lastRuns = new Map();
    for (const run of runList) {
      if (!lastRuns.has(run.template_id)) lastRuns.set(run.template_id, run);
    }

    return this.templateFiles().map((file) => {
      const tpl = readJson(file, `Template ${path.basename(file)}`);
      const ref = path.basename(file, '.json');
      return {
        ref,
        template_id: tpl.template_id || null,
        created_at: tpl.created_at || null,
        skill: tpl.skill || null,
        target: tpl.target || null,
        inputs: tpl.mapping?.inputs?.length || 0,
        outputs: tpl.mapping?.outputs?.length || 0,
        last_run: lastRuns.get(tpl.template_id) || null,
      };
    }).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  }

  getTemplate(id) {
    assertSegment(id, 'Template id');
    const file = this.templateFiles().find((candidate) => {
      if (path.basename(candidate, '.json') === id) return true;
      try {
        return JSON.parse(fs.readFileSync(candidate, 'utf8')).template_id === id;
      } catch {
        return false;
      }
    });

    if (!file) {
      throw new HttpError(404, 'TEMPLATE_NOT_FOUND', `Template not found: ${id}`, 'Refresh the Templates list');
    }

    const template = readJson(file, `Template ${path.basename(file)}`);
    return {
      ref: path.basename(file, '.json'),
      template,
    };
  }

  listRuns() {
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
          status: run.status || 'unknown',
          trigger: run.trigger || null,
          started_at: run.started_at || null,
          finished_at: run.finished_at || null,
          skill_hash: run.skill_hash || null,
          work_hash: run.work_hash || null,
          total: items.length,
          succeeded: run.succeeded ?? items.filter((item) => item.status === 'succeeded').length,
          failed: run.failed ?? items.filter((item) => item.status === 'failed').length,
        };
      })
      .filter(Boolean)
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
        stdout: maybeJson(path.join(recordDir, 'logs', 'stdout.json')),
        stderr: maybeJson(path.join(recordDir, 'logs', 'stderr.json')),
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

module.exports = {
  ReadModel,
  HttpError,
  isWithin,
  walkArtifacts,
};
