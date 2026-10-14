/**
 * messages.js — 侧边栏底部的消息区
 *
 * 所有异步操作（Load / Analyze / Mapping / Unload / 归档 / Run）都在这里出现：
 * 看状态、随时取消、跑完点进去看详情、处理完手工关掉。
 * 关掉只影响本机这块面板（localStorage），Operations 页里的记录不动。
 */

import { api } from './api.js';
import { h, icon, setNotice } from './dom.js';
import { encoded, statusBadge } from './format.js';

const DISMISSED_KEY = 'skillapp.messages.dismissed';
const POLL_MS = 3000;
const MAX_ROWS = 3;
const ACTIVE = new Set(['queued', 'running', 'canceling']);
const TYPE_LABELS = {
  'load-skill': 'Load',
  'analyze-skill': 'Analyze',
  'map-table': 'Mapping',
  'unload-skill': 'Unload',
  'archive-template': 'Archive',
  'unarchive-template': 'Unarchive',
  'run-template': 'Run',
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

function messageRow(operation, refresh) {
  const active = ACTIVE.has(operation.status);
  const label = TYPE_LABELS[operation.type] || operation.type;
  const subject = operation.subject?.label || operation.subject?.id || '';
  const actions = h('div', { className: 'message-actions' });

  if (active) {
    const cancel = h('button', {
      className: 'icon-button',
      type: 'button',
      title: 'Cancel task',
      'aria-label': `Cancel ${label}`,
    }, icon('cancel'));
    cancel.addEventListener('click', async () => {
      cancel.disabled = true;
      try {
        await api(cancelPath(operation), { method: 'POST' });
      } catch (error) {
        setNotice(error.message, true);
        cancel.disabled = false;
      }
      await refresh();
    });
    actions.append(cancel);
  } else {
    const close = h('button', {
      className: 'icon-button',
      type: 'button',
      title: 'Dismiss',
      'aria-label': `Dismiss ${label}`,
      onClick: (event) => {
        event.stopPropagation();
        dismiss(operation.operation_id);
        refresh();
      },
    }, icon('close'));
    actions.append(close);
  }

  const row = h('div', { className: 'message' }, [
    h('div', { className: 'message-main' }, [
      h('div', { className: 'message-title' }, [
        h('span', { className: 'message-type', textContent: label }),
        statusBadge(operation.status),
      ]),
      subject ? h('span', { className: 'message-subject truncate', textContent: subject }) : null,
    ]),
    actions,
  ]);

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

function renderMessages(container, operations, refresh) {
  const visible = operations
    .filter((operation) => !dismissed.has(operation.operation_id))
    .sort((a, b) => Number(ACTIVE.has(b.status)) - Number(ACTIVE.has(a.status)))
    .slice(0, MAX_ROWS);

  if (!visible.length) {
    container.replaceChildren();
    container.hidden = true;
    return;
  }
  container.hidden = false;
  container.replaceChildren(
    h('div', { className: 'messages-head', textContent: 'Messages' }),
    ...visible.map((operation) => messageRow(operation, refresh)),
  );
}

function initMessages() {
  const container = document.getElementById('messages');
  if (!container) return;

  const refresh = async () => {
    try {
      renderMessages(container, await api('/api/operations'), refresh);
    } catch {
      // 服务暂时不可用时保持现状，等下一次轮询。
    }
  };

  window.addEventListener('hashchange', () => { void refresh(); });
  window.addEventListener('skillapp:message', () => { void refresh(); });
  setInterval(() => {
    if (!document.hidden) void refresh();
  }, POLL_MS);
  void refresh();
}

export { initMessages };
