import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  atomicWriteJson,
  generateRunId,
  normalizeOptions,
  TERMINAL_STATUSES,
} from '../core/run-template.js';
import { HttpError, ReadModel } from './read-model.js';
import { operationSummary } from './operation-summary.js';

const ACTIVE_STATUSES = new Set(['queued', 'running', 'canceling']);
const DEFAULT_WORKER = path.join(import.meta.dirname, 'run-worker.js');
const DEFAULT_TASK_WORKER = path.join(import.meta.dirname, 'task-worker.js');
const DEFAULT_REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const TASK_TYPES = new Set([
  'load-skill',
  'analyze-skill',
  'bind-table',
  'unload-skill',
  'archive-template',
  'unarchive-template',
]);
const TERMINAL_OPERATION_STATUSES = new Set(['completed', 'failed', 'canceled', 'interrupted']);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertRunId(runId) {
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId === '.' || runId === '..') {
    throw new HttpError(400, 'INVALID_RUN_ID', 'Run ID is invalid', 'Check the Run link');
  }
}

function assertOperationId(operationId) {
  if (!/^[A-Za-z0-9._-]+$/.test(operationId) || operationId === '.' || operationId === '..') {
    throw new HttpError(400, 'INVALID_OPERATION_ID', 'Operation ID is invalid', 'Check the operation link');
  }
}

function generateOperationId(date = new Date()) {
  return generateRunId(date);
}

function summaryOfRun(run) {
  const items = Array.isArray(run.items) ? run.items : [];
  return {
    run_id: run.run_id,
    template_id: run.template_id || null,
    template_name: run.template_name || null,
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

class TaskRunner {
  constructor(options = {}) {
    this.root = path.resolve(options.root);
    this.repoRoot = path.resolve(options.repoRoot || DEFAULT_REPO_ROOT);
    this.workerPath = options.workerPath || DEFAULT_WORKER;
    this.taskWorkerPath = options.taskWorkerPath || DEFAULT_TASK_WORKER;
    this.spawn = options.spawn || spawn;
    this.model = new ReadModel(this.root);
    this.jobs = new Map();
    this.operations = new Map();
    // 全局操作订阅者：GET /api/operations/events 的连接。
    this.operationListeners = new Set();
    this.locks = new Map();
    this.recoverInterrupted();
    this.recoverInterruptedOperations();
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

  recoverInterruptedOperations() {
    if (!fs.existsSync(this.model.operationsDir)) return;
    for (const entry of fs.readdirSync(this.model.operationsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const file = path.join(this.model.operationsDir, entry.name, 'operation.json');
      if (!fs.existsSync(file)) continue;
      const job = readJson(file);
      if (TERMINAL_OPERATION_STATUSES.has(job.status)) continue;
      job.status = 'interrupted';
      job.finished_at = new Date().toISOString();
      job.error = { code: 'OPERATION_INTERRUPTED', message: 'Server restarted while the operation was active', action: 'Start the operation again' };
      atomicWriteJson(file, job);
    }
  }

  /**
   * Run 的 operation 镜像。
   *
   * Run 仍以 `.data/runs/` 为唯一真相；这里只落一份索引，让 Operations 页能把
   * 所有长期任务（load/analyze/map/unload/run）列在一起——不复制 items、日志和产物。
   */
  mirrorRunOperation(job) {
    const id = job.operationId;
    if (!id) return null;
    const run = job.run;
    const items = Array.isArray(run.items) ? run.items : [];
    const record = {
      operation_id: id,
      type: 'run-template',
      status: run.status || 'unknown',
      created_at: job.operationCreatedAt || run.started_at || null,
      started_at: run.started_at || null,
      finished_at: run.finished_at || null,
      progress: run.total ? { completed: run.completed || 0, total: run.total } : null,
      input: {
        ref: job.operationRef || null,
        run_id: run.run_id,
        template_id: run.template_id || null,
        template_name: run.template_name || null,
        trigger: run.trigger || null,
      },
      result: {
        run_id: run.run_id,
        total: run.total ?? items.length,
        succeeded: run.succeeded ?? items.filter((item) => item.status === 'succeeded').length,
        failed: run.failed ?? items.filter((item) => item.status === 'failed').length,
      },
      error: run.error
        ? { code: 'RUN_FAILED', message: String(run.error), action: 'Open the Run for per-row details' }
        : null,
      lock_keys: job.lockKey ? [job.lockKey] : [],
    };
    atomicWriteJson(path.join(this.model.operationsDir, id, 'operation.json'), record);
    this.broadcastOperation(record);
    return record;
  }

  acquireLocks(owner, keys, code = 'RESOURCE_LOCKED', message = 'Resource is already in use') {
    const unique = [...new Set((keys || []).filter(Boolean))];
    for (const key of unique) {
      const existing = this.locks.get(key);
      if (existing && existing !== owner) {
        throw new HttpError(409, code, `${message}: ${key}`, 'Wait for the active job to finish or cancel it');
      }
    }
    for (const key of unique) this.locks.set(key, owner);
    return unique;
  }

  releaseLocks(owner) {
    for (const [key, value] of this.locks) {
      if (value === owner) this.locks.delete(key);
    }
  }

  listOperations() {
    const byId = new Map();
    if (fs.existsSync(this.model.operationsDir)) {
      for (const entry of fs.readdirSync(this.model.operationsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const file = path.join(this.model.operationsDir, entry.name, 'operation.json');
        if (fs.existsSync(file)) {
          const job = readJson(file);
          byId.set(job.operation_id, job);
        }
      }
    }
    for (const item of this.operations.values()) byId.set(item.job.operation_id, item.job);
    return [...byId.values()].sort((a, b) => String(b.created_at || b.operation_id).localeCompare(String(a.created_at || a.operation_id)));
  }

  skillOperations(ref) {
    const active = this.listOperations().filter((job) => job.input?.ref === ref && ACTIVE_STATUSES.has(job.status));
    return {
      analyze: active.find((job) => job.type === 'analyze-skill') || null,
      bind: active.find((job) => job.type === 'bind-table') || null,
      unload: active.find((job) => job.type === 'unload-skill') || null,
    };
  }

  getOperation(operationId) {
    assertOperationId(operationId);
    const running = this.operations.get(operationId);
    if (running) return running.job;
    const file = path.join(this.model.operationsDir, operationId, 'operation.json');
    if (!fs.existsSync(file)) {
      throw new HttpError(404, 'OPERATION_NOT_FOUND', `Operation not found: ${operationId}`, 'Refresh the Skill details');
    }
    return readJson(file);
  }

  subscribeOperation(operationId, listener) {
    const job = this.operations.get(operationId);
    if (!job) {
      this.getOperation(operationId);
      return () => {};
    }
    job.listeners.add(listener);
    return () => job.listeners.delete(listener);
  }

  emitOperation(job, event) {
    for (const listener of job.listeners) {
      try {
        listener(event);
      } catch {
        job.listeners.delete(listener);
      }
    }
  }

  persistOperation(job) {
    atomicWriteJson(path.join(this.model.operationsDir, job.job.operation_id, 'operation.json'), job.job);
    this.broadcastOperation(job.job);
  }

  /** 全局操作流：任何一条操作落盘变化，就通知所有订阅者（消息面板）。 */
  subscribeOperations(listener) {
    this.operationListeners.add(listener);
    return () => this.operationListeners.delete(listener);
  }

  broadcastOperation(record) {
    if (!record) return;
    const summary = operationSummary(record);
    for (const listener of this.operationListeners) {
      try {
        listener(summary);
      } catch {
        this.operationListeners.delete(listener);
      }
    }
  }

  updateOperation(job, patch = {}) {
    Object.assign(job.job, patch);
    this.persistOperation(job);
    this.emitOperation(job, { type: 'snapshot', operation: job.job });
  }

  attachTask(job, child) {
    job.child = child;
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 16000) stderr = stderr.slice(-16000);
    });
    child.on('message', (message) => {
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'operation-started') {
        this.updateOperation(job, { status: 'running', started_at: job.job.started_at || new Date().toISOString() });
        return;
      }
      if (message.type === 'operation-progress') {
        this.updateOperation(job, { progress: message.progress || null });
        this.emitOperation(job, { type: 'progress', progress: message.progress || null, operation: job.job });
        return;
      }
      if (message.type === 'operation-result') {
        this.finishTask(job, message.result);
        return;
      }
      if (message.type === 'error') this.failTask(job, message.error || {});
    });
    child.on('error', (err) => this.failTask(job, { code: 'OPERATION_WORKER_ERROR', message: err.message, action: 'Retry the operation' }));
    child.on('close', (code, signal) => {
      if (job.done) return;
      if (job.cancelRequested) {
        this.cancelTaskNow(job);
        return;
      }
      const detail = stderr.trim().split('\n').filter(Boolean).pop();
      this.failTask(job, {
        code: 'OPERATION_WORKER_EXIT',
        message: detail || `Task worker exited with code ${code}${signal ? ` (${signal})` : ''}`,
        action: 'Check the server logs and retry',
      });
    });
    child.stdin.end(JSON.stringify({ type: job.job.type, input: job.input }));
  }

  startTask(type, input = {}, options = {}) {
    if (!TASK_TYPES.has(type)) {
      throw new HttpError(400, 'INVALID_OPERATION_TYPE', `Unsupported operation type: ${type}`, 'Choose a supported operation');
    }
    const jobId = generateOperationId();
    const now = new Date().toISOString();
    const record = {
      operation_id: jobId,
      type,
      status: 'queued',
      created_at: now,
      started_at: null,
      finished_at: null,
      progress: null,
      input,
      result: null,
      error: null,
      lock_keys: options.lockKeys || [],
    };
    this.acquireLocks(jobId, record.lock_keys);
    const job = {
      job: record,
      input,
      child: null,
      listeners: new Set(),
      cancelRequested: false,
      done: false,
      donePromise: null,
    };
    job.donePromise = new Promise((resolve) => { job.resolveDone = resolve; });
    this.operations.set(jobId, job);
    this.persistOperation(job);
    try {
      const child = this.spawn(process.execPath, [this.taskWorkerPath], {
        cwd: this.repoRoot,
        detached: process.platform !== 'win32',
        env: {
          ...process.env,
          SKILLAPP_ROOT: this.repoRoot,
          SKILLAPP_DATA_DIR: this.root,
        },
        stdio: ['pipe', 'ignore', 'pipe', 'ipc'],
      });
      this.attachTask(job, child);
    } catch (err) {
      this.failTask(job, { code: 'OPERATION_START_FAILED', message: err.message, action: 'Check the server logs and retry' });
    }
    return job.job;
  }

  finishTask(job, result) {
    if (job.done) return;
    job.done = true;
    this.releaseLocks(job.job.operation_id);
    Object.assign(job.job, { status: 'completed', result, finished_at: new Date().toISOString(), error: null });
    this.persistOperation(job);
    this.emitOperation(job, { type: 'snapshot', operation: job.job });
    this.emitOperation(job, { type: 'done', operation: job.job });
    job.resolveDone(job.job);
  }

  failTask(job, error = {}) {
    if (job.done) return;
    job.done = true;
    this.releaseLocks(job.job.operation_id);
    Object.assign(job.job, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      error: {
        code: error.code || 'OPERATION_FAILED',
        message: error.message || 'Operation failed',
        action: error.action || 'Check the server logs and retry',
      },
    });
    this.persistOperation(job);
    this.emitOperation(job, { type: 'snapshot', operation: job.job });
    this.emitOperation(job, { type: 'error', error: job.job.error, operation: job.job });
    this.emitOperation(job, { type: 'done', operation: job.job });
    job.resolveDone(job.job);
  }

  cancelTaskNow(job) {
    if (job.done) return;
    job.done = true;
    this.releaseLocks(job.job.operation_id);
    Object.assign(job.job, { status: 'canceled', finished_at: new Date().toISOString() });
    this.persistOperation(job);
    this.emitOperation(job, { type: 'snapshot', operation: job.job });
    this.emitOperation(job, { type: 'done', operation: job.job });
    job.resolveDone(job.job);
  }

  async cancelOperation(operationId) {
    const job = this.operations.get(operationId);
    if (!job) {
      const stored = this.getOperation(operationId);
      if (TERMINAL_OPERATION_STATUSES.has(stored.status)) return stored;
      throw new HttpError(409, 'OPERATION_NOT_ACTIVE', 'Operation is not active on this server', 'Refresh the operation details');
    }
    if (job.done || TERMINAL_OPERATION_STATUSES.has(job.job.status)) return job.job;
    job.cancelRequested = true;
    this.updateOperation(job, { status: 'canceling' });
    this.killTree(job, 'SIGTERM');
    await Promise.race([job.donePromise, new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (!job.done) this.killTree(job, 'SIGKILL');
    await Promise.race([job.donePromise, new Promise((resolve) => setTimeout(resolve, 1000))]);
    if (!job.done) this.cancelTaskNow(job);
    return job.job;
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
    this.mirrorRunOperation(job);
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
      dryRun: input.dry_run ?? input.dryRun,
    });
    const selected = this.model.getTemplate(templateId);
    const canonicalId = selected.template.template_id || templateId;
    const lockKey = `template:${canonicalId}`;
    const existing = this.locks.get(lockKey);
    if (existing) {
      throw new HttpError(409, 'TEMPLATE_LOCKED', `Template is already running: ${existing}`, 'Wait for the active run to finish or cancel it');
    }
    const templatePath = this.model.findTemplateFile(templateId);
    const runId = generateRunId();
    const runDir = options.dryRun ? null : path.join(this.model.runsDir, runId);
    const now = new Date().toISOString();
    const provisional = {
      run_id: runId,
      template_id: canonicalId,
      template_name: selected.name || null,
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
      lockKey,
      input: {
        type: 'run',
        template_path: templatePath,
        options,
        run_id: runId,
        run_dir: runDir,
        template_name: selected.name || null,
      },
    };
    job.donePromise = new Promise((resolve) => { job.resolveDone = resolve; });
    job.operationId = options.dryRun ? null : generateOperationId();
    job.operationCreatedAt = now;
    job.operationRef = selected.ref;
    this.jobs.set(runId, job);
    this.locks.set(lockKey, runId);
    this.mirrorRunOperation(job);

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
    this.mirrorRunOperation(job);
  }

  finish(job) {
    if (job.done) return;
    job.done = true;
    this.releaseLocks(job.run.run_id);
    this.emit(job, { type: 'done', run: job.run });
    job.resolveDone(job.run);
  }

  fail(job, message) {
    if (job.done) return;
    this.persistTerminal(job, 'failed', message);
    job.done = true;
    this.releaseLocks(job.run.run_id);
    this.emit(job, { type: 'snapshot', run: job.run });
    this.emit(job, { type: 'error', error: { message } });
    this.emit(job, { type: 'done', run: job.run });
    job.resolveDone(job.run);
  }

  cancelNow(job) {
    if (job.done) return;
    this.persistTerminal(job, 'canceled');
    job.done = true;
    this.releaseLocks(job.run.run_id);
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
    const failed = (run.items || []).filter((item) => item.status === 'failed').length;
    if (!failed) {
      throw new HttpError(400, 'NO_FAILED_ROWS', 'This Run has no failed rows to retry', 'Refresh the Run details');
    }
    // 指定行重跑已移除：失败行本来就会被增量重新捞出，所以重试 = 再跑一次增量。
    return this.start({
      template_id: run.template_id,
      trigger: 'incremental',
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
      this.releaseLocks(job.run.run_id);
      this.emit(job, { type: 'snapshot', run: job.run });
      this.emit(job, { type: 'done', run: job.run });
      job.resolveDone(job.run);
    }
    for (const job of this.operations.values()) {
      if (job.done) continue;
      job.cancelRequested = true;
      this.killTree(job, 'SIGTERM');
      job.done = true;
      this.releaseLocks(job.job.operation_id);
      Object.assign(job.job, {
        status: 'interrupted',
        finished_at: new Date().toISOString(),
        error: { code: 'OPERATION_INTERRUPTED', message: 'Server stopped while the job was active', action: 'Start the operation again' },
      });
      this.persistOperation(job);
      this.emitOperation(job, { type: 'snapshot', operation: job.job });
      this.emitOperation(job, { type: 'done', operation: job.job });
      job.resolveDone(job.job);
    }
  }

  preview(input = {}) {
    const templateId = String(input.template_id || '').trim();
    if (!templateId) throw new HttpError(400, 'INVALID_RUN', 'Template ID is required', 'Choose a Template and try again');
    const selected = this.model.getTemplate(templateId);
    const templatePath = this.model.findTemplateFile(templateId);
    const options = normalizeOptions({
      trigger: input.trigger,
      dryRun: true,
    });

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

export { TaskRunner };
