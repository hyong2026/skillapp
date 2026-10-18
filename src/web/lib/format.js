import { h } from './dom.js';
import { highlightText, jsonText } from './highlight.js';

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

/**
 * Prompt 型 Skill：入口就是 SKILL.md（cmd 一般交给 `codex exec`），没有脚本可跑。
 * 这类 Run 的过程输出走"实时日志"，脚本型 Skill 则给 stdout / stderr 两块完整日志。
 */
function isPromptSkill(run) {
  return /^SKILL\.md$/i.test(String(run?.skill_entry || '').trim());
}

/**
 * Inputs 表里合并显示的「Required [Default]」：必填只写 `Yes`；非必填带默认值时写 `No [cute]`。
 * 存储上 required 与 default 仍是两个独立字段，只是界面上并成一列（默认值不可编辑）。
 */
function requiredDefault(spec) {
  if (spec?.required === true) return 'Yes';
  const value = spec?.default;
  return value === undefined || value === null || value === '' ? 'No' : `No [${formatMeta(value)}]`;
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

const toLines = (text) => {
  const value = String(text ?? '').replace(/\n$/, '');
  return value === '' ? [''] : value.split('\n');
};

/**
 * 带行号的代码块：行号写在每行最前面（`cat -n` 那种），长行换行时续行悬挂缩进到
 * 代码起点。这样不折行也不会错位——一个逻辑行永远只有一个行号，且就在它旁边。
 */
function numberedBlock(lines, { highlight = false } = {}) {
  const code = h('code', { className: 'code-lines' });
  // 行号宽度 = 最大位数 + 2ch（这 2ch 就是行号与代码之间的间距）
  code.style.setProperty('--gutter-w', `${String(lines.length).length + 2}ch`);
  lines.forEach((line, index) => {
    const text = h('span', { className: 'code-text' });
    if (highlight) text.innerHTML = highlightText(line);
    else text.textContent = line;
    code.append(h('span', { className: 'code-line' }, [
      h('span', { className: 'code-line-no', 'aria-hidden': 'true', textContent: String(index + 1) }),
      text,
    ]));
  });
  return h('pre', { className: 'code-block' }, code);
}

function codeBlock(value) {
  if (value === null || value === undefined) return h('span', { className: 'muted', textContent: 'Not recorded' });
  // 逐行高亮：pretty JSON 的换行都在字符串之外，每行都能独立着色。
  const text = jsonText(value);
  return text === null
    ? numberedBlock(toLines(value))
    : numberedBlock(toLines(text), { highlight: true });
}

/** 日志原样展示（带行号）：整段就是 JSON 时顺手做语法高亮，纯文本保持原样。 */
function textBlock(value) {
  if (!value) return h('span', { className: 'muted', textContent: 'No output' });
  return numberedBlock(toLines(value), { highlight: jsonText(value) !== null });
}

export {
  encoded,
  formatDate,
  formatBytes,
  formatDuration,
  statusBadge,
  triggerLabel,
  isPromptSkill,
  requiredDefault,
  formatMeta,
  specMeta,
  codeBlock,
  textBlock,
};
