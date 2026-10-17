/**
 * messages.js — 侧边栏底部的消息区
 *
 * 所有异步操作（Load / Analyze / Mapping / Unload / 归档 / Run）都在这里出现：
 * 看状态、随时取消、跑完点进去看详情、处理完手工关掉。
 * 关掉只影响本机这块面板（localStorage），Operations 页里的记录不动。
 */

import { api, readEventStream } from './api.js';
import { h, icon, setNotice } from './dom.js';
import { encoded, statusBadge } from './format.js';

const DISMISSED_KEY = 'skillapp.messages.dismissed';
const STREAM_PATH = '/api/operations/events';
const RECONNECT_MS = 2000;
const MAX_ROWS = 3;
const ACTIVE = new Set(['queued', 'running', 'canceling']);
const TYPE_LABELS = {
  'load-skill': 'Load',
  'analyze-skill': 'Analyze',
  'bind-table': 'Bind',
  'unload-skill': 'Unload',
  'archive-template': 'Archive',
  'unarchive-template': 'Unarchive',
  'run-template': 'Run',
  'delete-run': 'Delete',
};

function readDismissed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

const dismissed = readDismissed();

function dismiss(operationId) {
  dismissed.add(operationId);
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissed]));
  } catch {
    // 隐私模式下写不了就算了，本页仍然生效。
  }
}

/** 跑完之后点进去看什么：按 subject 还原到对应详情页。 */
function detailHash(operation) {
  const { type, id } = operation.subject || {};
  if (!id) return null;
  if (type === 'run') return `#runs/${encoded(id)}`;
  if (type === 'template') return `#templates/${encoded(id)}`;
  if (type === 'skill') return `#skills/${encoded(id)}`;
  return null;
}

/** Run 的 operation 只是镜像，取消要走 Run 自己的接口。 */
function cancelPath(operation) {
  if (operation.type === 'run-template') {
    const runId = operation.input?.run_id;
    return runId ? `/api/runs/${encoded(runId)}/cancel` : null;
  }
  return `/api/operations/${encoded(operation.operation_id)}/cancel`;
}

function messageRow(operation, { onCancel, onClose }) {
  const active = ACTIVE.has(operation.status);
  const label = TYPE_LABELS[operation.type] || operation.type;
  const subject = operation.subject?.label || operation.subject?.id || '';
  const actions = h('div', { className: 'message-actions' });
  let row = null;

  if (active) {
    const cancel = h('button', {
      className: 'icon-button',
      type: 'button',
      title: 'Cancel task',
      'aria-label': `Cancel ${label}`,
    }, icon('cancel'));
    cancel.addEventListener('click', () => onCancel(operation, cancel));
    actions.append(cancel);
  } else {
    const close = h('button', {
      className: 'icon-button',
      type: 'button',
      title: 'Dismiss',
      'aria-label': `Dismiss ${label}`,
      onClick: (event) => {
        event.stopPropagation();
        onClose(operation, row);
      },
    }, icon('close'));
    actions.append(close);
  }

  row = h('div', { className: 'message' }, [
    h('div', { className: 'message-main' }, [
      h('div', { className: 'message-title' }, [
        h('span', { className: 'message-type', textContent: label }),
        statusBadge(operation.status),
      ]),
      subject ? h('span', { className: 'message-subject truncate', textContent: subject }) : null,
    ]),
    actions,
  ]);
  row.dataset.operationId = operation.operation_id;

  // 跑完的任务：整行可点，直接进对应详情页（进行中的不给点，避免误跳）。
  const hash = active ? null : detailHash(operation);
  if (hash) {
    const open = () => { location.hash = hash; };
    row.classList.add('is-clickable');
    row.setAttribute('role', 'link');
    row.tabIndex = 0;
    row.title = 'Open details';
    row.addEventListener('click', open);
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      open();
    });
  }
  return row;
}

function renderMessages(container, operations, handlers) {
  // 渲染全部（不过滤成 3 条）：滚动区只露出最近 MAX_ROWS 条，其余往下滚。
  const visible = operations
    .filter((operation) => !dismissed.has(operation.operation_id))
    .sort((a, b) => Number(ACTIVE.has(b.status)) - Number(ACTIVE.has(a.status)));

  if (!visible.length) {
    container.replaceChildren();
    container.hidden = true;
    return;
  }
  const rows = visible.map((operation) => messageRow(operation, handlers));
  const list = h('div', { className: 'messages-list' }, rows);
  // 整块是重画的，所以先把滚动位置接过来：删掉一条（或新推一条）后停在原处，不跳回顶部。
  const previousScroll = container.querySelector('.messages-list')?.scrollTop ?? 0;
  container.hidden = false;
  container.replaceChildren(
    h('div', { className: 'messages-head' }, [
      h('span', { textContent: 'Messages' }),
      h('button', {
        className: 'messages-clear',
        type: 'button',
        textContent: 'Clear',
        onClick: () => handlers.onClear(),
      }),
    ]),
    list,
  );
  // 可见高度 = 最近 MAX_ROWS 条的真实行高（字号/主题变了照样对），多出来的靠滚动条看。
  const gap = 6;
  const shown = rows.slice(0, MAX_ROWS);
  list.style.maxHeight = `${shown.reduce((sum, row) => sum + row.offsetHeight, 0)
    + gap * Math.max(0, shown.length - 1)}px`;
  if (previousScroll) list.scrollTop = previousScroll;
}

/** 新的一条覆盖旧的同 ID 记录，并按创建时间倒序排好（服务端也是这个顺序）。 */
function mergeOperation(operations, next) {
  const rest = operations.filter((operation) => operation.operation_id !== next.operation_id);
  return [next, ...rest];
}

function initMessages() {
  const container = document.getElementById('messages');
  if (!container) return;

  // 列表完全靠 SSE：连上时的一次全量快照 + 之后逐条推送，平时不发任何 GET。
  let operations = [];
  const paint = () => renderMessages(container, operations, handlers);
  const handlers = {
    async onCancel(operation, button) {
      button.disabled = true;
      try {
        const result = await api(cancelPath(operation), { method: 'POST' });
        // 任务类取消会把更新后的操作回给我们；Run 类等流推。
        if (result?.operation_id) operations = mergeOperation(operations, result);
      } catch (error) {
        setNotice(error.message, true);
        button.disabled = false;
      }
      paint();
    },
    // 关掉一条 = 从 DOM 里删掉这一行，不重画列表，滚动位置自然保持。
    onClose(operation, row) {
      dismiss(operation.operation_id);
      row?.remove();
      if (!container.querySelector('.message')) {
        container.replaceChildren();
        container.hidden = true;
      }
    },
    // 一键清空：全部标记为已关闭（只影响本机面板），清掉列表即可，之后新来的照常出现。
    onClear() {
      for (const operation of operations) dismiss(operation.operation_id);
      container.replaceChildren();
      container.hidden = true;
    },
  };
  // 只有在流连不上、而且手上还没有任何数据时兜底拉一次，绝不是轮询。
  const fallbackFetch = async () => {
    if (operations.length) return;
    try {
      operations = (await api('/api/operations')).items;
      paint();
    } catch {
      // 拿不到就保持空白，等下一次重连。
    }
  };

  const connect = async () => {
    if (!container.isConnected) return;
    try {
      const response = await fetch(STREAM_PATH, {
        headers: { accept: 'text/event-stream' },
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok || !response.body) throw new Error(`Operation stream failed (${response.status})`);
      await readEventStream(response, (event) => {
        if (event.type === 'snapshot') operations = event.operations || [];
        else if (event.type === 'operation' && event.operation) operations = mergeOperation(operations, event.operation);
        else return;
        paint();
      });
    } catch {
      // 断线：先兜底拉一次，再重连（重连成功后服务端会再发一次全量快照）。
      await fallbackFetch();
    }
    setTimeout(connect, RECONNECT_MS);
  };

  void connect();
}

export { initMessages };
