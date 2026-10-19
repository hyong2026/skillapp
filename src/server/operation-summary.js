/**
 * operation-summary.js — 一条操作的摘要
 *
 * Operations 列表（GET /api/operations）与全局 SSE（GET /api/operations/events）
 * 共用同一份形状：只带列表要用的字段，不复制 result（bind-table 的 plan 有几十 KB）。
 */

function operationSummary(operation) {
  const input = operation?.input || {};
  const result = operation?.result || {};
  const started = operation?.started_at ? Date.parse(operation.started_at) : NaN;
  const finished = operation?.finished_at ? Date.parse(operation.finished_at) : NaN;
  const templateId = input.template_id || result.template?.template_id || null;
  let subject = null;
  if (operation?.type === 'execute-template') {
    // 名字优先：消息区里显示 Template Name，比 Run ID 有意义。
    subject = input.run_id
      ? { type: 'run', id: input.run_id, label: input.template_name || input.run_id }
      : null;
  } else if (operation?.type === 'delete-run' && input.run_id) {
    // 删的是哪一次 Run：显示 Run ID（Template Name 在列表里另有出处，这里要唯一标识）。
    subject = { type: 'run', id: input.run_id, label: input.run_id };
  } else if (operation?.type === 'bind-table' && templateId) {
    subject = { type: 'template', id: templateId, label: input.ref || templateId };
  } else if ((operation?.type === 'archive-template' || operation?.type === 'unarchive-template') && templateId) {
    subject = { type: 'template', id: templateId, label: input.template_name || templateId };
  } else if (input.ref) {
    subject = { type: 'skill', id: input.ref, label: input.ref };
  }
  return {
    operation_id: operation?.operation_id,
    type: operation?.type,
    status: operation?.status || 'unknown',
    created_at: operation?.created_at || null,
    started_at: operation?.started_at || null,
    finished_at: operation?.finished_at || null,
    duration_ms: Number.isFinite(started) && Number.isFinite(finished) ? finished - started : null,
    progress: operation?.progress || null,
    subject,
    counts: operation?.type === 'execute-template'
      ? { total: result.total ?? null, succeeded: result.succeeded ?? null, failed: result.failed ?? null }
      : null,
    trigger: operation?.type === 'execute-template' ? input.trigger || null : null,
    error: operation?.error || null,
  };
}

export { operationSummary };
