import fs from 'node:fs';
import path from 'node:path';
import { RUNS_DIR } from './paths.js';
import { AppError } from './errors.js';
import { atomicWriteJson } from './json-file.js';

/**
 * delete-run.js — 逻辑删除一次 Run（不删文件，只打 `deleted_at`）。
 *
 * 和 Template 归档一个思路：Run 列表里看不到、不再参与展示，但 `runs/<run_id>/`
 * 原样留着（日志与产物都还在），所以 Message / Operations 里的链接仍然打得开，
 * 历史也追得回来。按当前约定**不做反向操作**（没有 Restore），要回收磁盘得另外做硬删。
 */
function deleteRun({ runId } = {}) {
  const id = String(runId ?? '').trim();
  if (!id || !/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') {
    throw new AppError('INVALID_RUN_ID', 'Run ID is invalid', 'Check the Run link', 400);
  }

  const file = path.resolve(RUNS_DIR, id, 'run.json');
  // 只认 runs/<run_id>/run.json 这一种路径，别的形状一律拒绝。
  if (path.dirname(path.dirname(file)) !== path.resolve(RUNS_DIR)) {
    throw new AppError('INVALID_DELETE_TARGET', `Refusing to delete: ${id}`, 'Refresh the Runs list', 400);
  }
  if (!fs.existsSync(file)) {
    throw new AppError('RUN_NOT_FOUND', `Run not found: ${id}`, 'Refresh the Runs list', 404);
  }

  const run = JSON.parse(fs.readFileSync(file, 'utf8'));
  const deletedAt = run.deleted_at || new Date().toISOString();
  atomicWriteJson(file, { ...run, deleted_at: deletedAt });
  return {
    run_id: id,
    template_id: run.template_id || null,
    template_name: run.template_name || null,
    deleted_at: deletedAt,
  };
}

export { deleteRun };
