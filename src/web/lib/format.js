import { h } from './dom.js';
import { highlightJson } from './highlight.js';

function encoded(value) {
  return encodeURIComponent(String(value));
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (part) => String(part).padStart(2, '0');
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  ].join(' ');
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  // Always one decimal: the value updates live during a Run and must not change width.
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

const STATUS_LABELS = {
  succeeded: 'Succeeded',
  completed: 'Completed',
  invalid: 'Invalid',
  unanalyzed: 'Unanalyzed',
  ready: 'Ready',
  failed: 'Failed',
  partial: 'Partial',
  canceled: 'Canceled',
  interrupted: 'Interrupted',
  running: 'Running',
  queued: 'Queued',
  canceling: 'Canceling',
  'dry-run': 'Dry Run',
  analyzing: 'Analyzing',
  stale: 'Stale',
  unverified: 'Unverified',
  missing: 'Missing',
};

function statusBadge(status) {
  const safe = String(status || 'unknown').toLowerCase();
  const known = Object.keys(STATUS_LABELS);
  return h('span', {
    className: `badge ${known.includes(safe) ? safe : 'unknown'}`,
    textContent: STATUS_LABELS[safe] || safe,
  });
}

function triggerLabel(value) {
  const safe = String(value || '').trim();
  return safe || '—';
}

function formatMeta(value) {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function specMeta(spec) {
  const parts = [];
  if (spec.validate) {
    parts.push(Object.entries(spec.validate).map(([key, value]) => `${key}=${formatMeta(value)}`).join(' · '));
  }
  if (spec.transform) parts.push(`transform=${JSON.stringify(spec.transform)}`);
  if (spec.hint) parts.push(spec.hint);
  return parts.join(' · ') || '—';
}

function codeBlock(value) {
  if (value === null || value === undefined) return h('span', { className: 'muted', textContent: 'Not recorded' });
  const code = h('code');
  code.innerHTML = highlightJson(value);
  return h('pre', { className: 'code-block' }, code);
}

export {
  encoded,
  formatDate,
  formatBytes,
  formatDuration,
  statusBadge,
  triggerLabel,
  formatMeta,
  specMeta,
  codeBlock,
};
