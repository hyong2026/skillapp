'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  atomicWriteJson,
  generateRunId,
  normalizeOptions,
  TERMINAL_STATUSES,
} = require('../core/run-template');
const { HttpError, ReadModel } = require('./read-model');

const ACTIVE_STATUSES = new Set(['queued', 'running', 'canceling']);
const DEFAULT_WORKER = path.join(__dirname, 'run-worker.js');
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..', '..');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertRunId(runId) {
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId === '.' || runId === '..') {
    throw new HttpError(400, 'INVALID_RUN_ID', 'Run ID is invalid', 'Check the Run link');
  }
}

function summaryOfRun(run) {
  const items = Array.isArray(run.items) ? run.items : [];
  return {
    run_id: run.run_id,
    template_id: run.template_id || null,
    status: run.status || 'unknown',
    trigger: run.trigger || null,
    dry_run: Boolean(run.dry_run),
    started_at: run.started_at || null,
    finished_at: run.finished_at || null,
    skill_hash: run.skill_hash || null,
    work_hash: run.work_hash || null,
    total: run.total ?? items.length,
    completed: run.completed ?? items.filter((item) => item.status !== 'queued' && item.status !== 'running').length,
    succeeded: run.succeeded ?? items.filter((item) => item.status === 'succeeded').length,
    failed: run.failed ?? items.filter((item) => item.status === 'failed').length,
  };
}

function normalizePreviewError(rawMessage) {
  const raw = String(rawMessage || 'Preview failed');
  const jsonStart = raw.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const payload = JSON.parse(raw.slice(jsonStart));
      const detail = payload.error || {};
      const code = detail.subtype || detail.type || 'PREVIEW_FAILED';
      const message = detail.message || raw;
      if (code === 'token_missing' || code === 'authentication' || /need_user_authorization/i.test(message)) {
        return new HttpError(
          424,
          'LARK_AUTH_REQUIRED',
          'Lark authorization is required',
          detail.hint || 'Authorize lark-cli, then retry Preview',
        );
      }
      return new HttpError(502, 'PREVIEW_FAILED', message, 'Check lark-cli access and Template bindings, then retry');
    } catch {
      // Fall through to the raw worker error.
    }
  }
  return new HttpError(502, 'PREVIEW_FAILED', raw.slice(0, 2000), 'Check the server logs and retry');
}

class JobRunner {
  constructor(options = {}) {
    this.root = path.resolve(options.root);
    this.repoRoot = path.resolve(options.repoRoot || DEFAULT_REPO_ROOT);
    this.workerPath = options.workerPath || DEFAULT_WORKER;
    this.spawn = options.spawn || spawn;
    this.model = new ReadModel(this.root);
    this.jobs = new Map();
    this.locks = new Map();
    this.recoverInterrupted();
  }

  recoverInterrupted() {
    if (!fs.existsSync(this.model.runsDir)) return;
    for (const entry of fs.readdirSync(this.model.runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const file = path.join(this.model.runsDir, entry.name, 'run.json');
      if (!fs.existsSync(file)) continue;
      const run = readJson(file);
      if (!ACTIVE_STATUSES.has(run.status)) continue;
      run.status = 'interrupted';
      run.finished_at = new Date().toISOString();
      run.error = 'Server restarted while the run was active';
      atomicWriteJson(file, run);
    }
  }

  listRuns() {
    const byId = new Map(this.model.listRuns().map((run) => [run.run_id, run]));
    for (const job of this.jobs.values()) {
      byId.set(job.run.run_id, summaryOfRun(job.run));
    }
    return [...byId.values()].sort((a, b) => String(b.started_at || b.run_id).localeCompare(String(a.started_at || a.run_id)));
  }

  getRun(runId) {
    assertRunId(runId);
    const job = this.jobs.get(runId);
    if (job) return job.run;
    const file = path.join(this.model.runsDir, runId, 'run.json');
    if (!fs.existsSync(file)) {
      throw new HttpError(404, 'RUN_NOT_FOUND', `Run not found: ${runId}`, 'Refresh the Runs list');
    }
    return readJson(file);
  }

  subscribe(runId, listener) {
    const job = this.jobs.get(runId);
    if (!job) {
      const run = this.getRun(runId);
      return () => {};
    }
    job.listeners.add(listener);
    return () => job.listeners.delete(listener);
  }

  emit(job, event) {
    for (const listener of job.listeners) {
      try {
        listener(event);
      } catch {
        job.listeners.delete(listener);
      }
    }
  }

  updateRun(job, run) {
    job.run = run;
    this.emit(job, { type: 'snapshot', run });
  }

  handleMessage(job, message) {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'run-created') {
      this.updateRun(job, message.run);
      return;
    }
    if (message.type === 'item-stage') {
      const item = job.run.items.find((entry) => entry.record_id === message.record_id);
      if (item) item.stage = message.stage;
      this.emit(job, message);
      return;
    }
    if (message.type === 'item-log') {
      this.emit(job, message);
      return;
    }
    if (message.type === 'item-started' || message.type === 'item-finished') {
      this.updateRun(job, message.run);
      this.emit(job, message);
      return;
    }
    if (message.type === 'run-finished') {
      this.updateRun(job, message.run);
      this.finish(job);
      return;
    }
    if (message.type === 'error') {
      this.fail(job, message.error?.message || 'Worker failed');
    }
  }

  attach(job, child) {
    job.child = child;
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 16000) stderr = stderr.slice(-16000);
    });
    child.on('message', (message) => this.handleMessage(job, message));
    child.on('error', (err) => this.fail(job, err.message));
    child.on('close', (code, signal) => {
      if (job.done) return;
      if (job.cancelRequested) {
        this.cancelNow(job);
        return;
      }
      const detail = stderr.trim().split('\n').filter(Boolean).pop();
      this.fail(job, detail || `Worker exited with code ${code}${signal ? ` (${signal})` : ''}`);
    });
    child.stdin.end(JSON.stringify(job.input));
  }

  start(input = {}) {
    const templateId = String(input.template_id || '').trim();
    if (!templateId) throw new HttpError(400, 'INVALID_RUN', 'Template ID is required', 'Choose a Template and try again');
    const options = normalizeOptions({
      trigger: input.trigger,
      recordIds: input.record_ids || input.recordIds,
      dryRun: input.dry_run ?? input.dryRun,
    });
    if (options.trigger === 'record-id' && !options.recordIds.length) {
      throw new HttpError(400, 'INVALID_RUN', 'At least one record ID is required', 'Enter one or more record IDs');
    }
    const selected = this.model.getTemplate(templateId);
    const canonicalId = selected.template.template_id || templateId;
    const existing = this.locks.get(canonicalId);
    if (existing) {
      throw new HttpError(409, 'TEMPLATE_LOCKED', `Template is already running: ${existing}`, 'Wait for the active run to finish or cancel it');
    }
    const templatePath = path.join(this.model.templatesDir, `${selected.ref}.json`);
    const runId = generateRunId();
    const runDir = options.dryRun ? null : path.join(this.model.runsDir, runId);
    const now = new Date().toISOString();
    const provisional = {
      run_id: runId,
      template_id: canonicalId,
      skill_hash: selected.template.skill?.hash || null,
      work_hash: null,
      trigger: options.trigger,
      dry_run: options.dryRun,
      started_at: now,
      finished_at: null,
      status: 'queued',
      total: null,
      completed: 0,
      succeeded: 0,
      failed: 0,
      dropped: [],
      items: [],
    };

    if (runDir) atomicWriteJson(path.join(runDir, 'run.json'), provisional);

    const job = {
      run: provisional,
      child: null,
      listeners: new Set(),
      cancelRequested: false,
      done: false,
      donePromise: null,
      input: {
        type: 'run',
        template_path: templatePath,
        options,
        run_id: runId,
        run_dir: runDir,
      },
    };
    job.donePromise = new Promise((resolve) => { job.resolveDone = resolve; });
    this.jobs.set(runId, job);
    this.locks.set(canonicalId, runId);

    try {
      const child = this.spawn(process.execPath, [this.workerPath], {
        cwd: this.repoRoot,
        detached: process.platform !== 'win32',
        env: {
          ...process.env,
          SKILLAPP_ROOT: this.repoRoot,
          SKILLAPP_DATA_DIR: this.root,
        },
        stdio: ['pipe', 'ignore', 'pipe', 'ipc'],
      });
      this.attach(job, child);
    } catch (err) {
      this.fail(job, err.message);
    }
    return job.run;
  }

  persistTerminal(job, status, error) {
    job.run.status = status;
    job.run.finished_at = new Date().toISOString();
    if (error) job.run.error = error;
    if (!job.run.dry_run && job.child !== null) {
      atomicWriteJson(path.join(this.model.runsDir, job.run.run_id, 'run.json'), job.run);
    } else if (!job.run.dry_run) {
      const runDir = path.join(this.model.runsDir, job.run.run_id);
      atomicWriteJson(path.join(runDir, 'run.json'), job.run);
    }
  }

  finish(job) {
    if (job.done) return;
    job.done = true;
    if (this.locks.get(job.run.template_id) === job.run.run_id) this.locks.delete(job.run.template_id);
    this.emit(job, { type: 'done', run: job.run });
    job.resolveDone(job.run);
  }

  fail(job, message) {
    if (job.done) return;
    this.persistTerminal(job, 'failed', message);
    job.done = true;
    if (this.locks.get(job.run.template_id) === job.run.run_id) this.locks.delete(job.run.template_id);
    this.emit(job, { type: 'snapshot', run: job.run });
    this.emit(job, { type: 'error', error: { message } });
    this.emit(job, { type: 'done', run: job.run });
    job.resolveDone(job.run);
  }

  cancelNow(job) {
    if (job.done) return;
    this.persistTerminal(job, 'canceled');
    job.done = true;
    if (this.locks.get(job.run.template_id) === job.run.run_id) this.locks.delete(job.run.template_id);
    this.emit(job, { type: 'snapshot', run: job.run });
    this.emit(job, { type: 'done', run: job.run });
    job.resolveDone(job.run);
  }

  killTree(job, signal) {
    const child = job.child;
    if (!child || !child.pid) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      try { child.kill(signal); } catch { /* already exited */ }
    }
  }

  async cancel(runId) {
    const job = this.jobs.get(runId);
    if (!job) {
      const run = this.getRun(runId);
      if (TERMINAL_STATUSES.has(run.status)) {
        throw new HttpError(409, 'RUN_NOT_ACTIVE', `Run is already ${run.status}`, 'Refresh the Run details');
      }
      throw new HttpError(409, 'RUN_NOT_ACTIVE', 'Run is not active on this server', 'Refresh the Run details');
    }
    if (job.done || TERMINAL_STATUSES.has(job.run.status)) return job.run;

    job.cancelRequested = true;
    job.run.status = 'canceling';
    if (!job.run.dry_run) {
      atomicWriteJson(path.join(this.model.runsDir, runId, 'run.json'), job.run);
    }
    this.updateRun(job, job.run);
    this.killTree(job, 'SIGTERM');
    const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
    await Promise.race([job.donePromise, timeout]);
    if (!job.done) this.killTree(job, 'SIGKILL');
    await Promise.race([job.donePromise, new Promise((resolve) => setTimeout(resolve, 1000))]);
    if (!job.done) this.cancelNow(job);
    return job.run;
  }

  retry(runId) {
    const run = this.getRun(runId);
    if (ACTIVE_STATUSES.has(run.status)) {
      throw new HttpError(409, 'RUN_ACTIVE', 'Cannot retry a running Run', 'Wait for the Run to finish');
    }
    const recordIds = (run.items || []).filter((item) => item.status === 'failed').map((item) => item.record_id);
    if (!recordIds.length) {
      throw new HttpError(400, 'NO_FAILED_ROWS', 'This Run has no failed rows to retry', 'Refresh the Run details');
    }
    return this.start({
      template_id: run.template_id,
      trigger: 'record-id',
      record_ids: recordIds,
      dry_run: false,
    });
  }

  shutdown() {
    for (const job of this.jobs.values()) {
      if (job.done) continue;
      job.cancelRequested = true;
      this.killTree(job, 'SIGTERM');
      this.persistTerminal(job, 'interrupted', 'Server stopped while the run was active');
      job.done = true;
      if (this.locks.get(job.run.template_id) === job.run.run_id) this.locks.delete(job.run.template_id);
      this.emit(job, { type: 'snapshot', run: job.run });
      this.emit(job, { type: 'done', run: job.run });
      job.resolveDone(job.run);
    }
  }

  preview(input = {}) {
    const templateId = String(input.template_id || '').trim();
    if (!templateId) throw new HttpError(400, 'INVALID_RUN', 'Template ID is required', 'Choose a Template and try again');
    const selected = this.model.getTemplate(templateId);
    const templatePath = path.join(this.model.templatesDir, `${selected.ref}.json`);
    const options = normalizeOptions({
      trigger: input.trigger,
      recordIds: input.record_ids || input.recordIds,
      dryRun: true,
    });
    if (options.trigger === 'record-id' && !options.recordIds.length) {
      throw new HttpError(400, 'INVALID_RUN', 'At least one record ID is required', 'Enter one or more record IDs');
    }

    return new Promise((resolve, reject) => {
      let stderr = '';
      let settled = false;
      const child = this.spawn(process.execPath, [this.workerPath], {
        cwd: this.repoRoot,
        env: {
          ...process.env,
          SKILLAPP_ROOT: this.repoRoot,
          SKILLAPP_DATA_DIR: this.root,
        },
        stdio: ['pipe', 'ignore', 'pipe', 'ipc'],
      });
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill('SIGTERM');
          reject(new HttpError(504, 'PREVIEW_TIMEOUT', 'Run preview timed out', 'Try again with fewer records'));
        }
      }, 60000);
      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.on('message', (message) => {
        if (message.type === 'preview') done(resolve, message.data);
        else if (message.type === 'error') done(reject, normalizePreviewError(message.error?.message));
      });
      child.on('error', (err) => done(reject, err));
      child.on('close', (code) => {
        if (settled) return;
        const detail = stderr.trim().split('\n').filter(Boolean).pop();
        done(reject, normalizePreviewError(detail || `Preview worker exited with code ${code}`));
      });
      child.stdin.end(JSON.stringify({ type: 'preview', template_path: templatePath, options }));
    });
  }
}

module.exports = {
  JobRunner,
  ACTIVE_STATUSES,
  normalizePreviewError,
  summaryOfRun,
};
