import { api, startOperation, watchRun } from '../lib/api.js';
import { dataPanel, dataTable, head, kv, pagedTable, panel, selectMenu, viewTitle } from '../lib/components.js';
import { actionButton, fragment, h, setNotice } from '../lib/dom.js';
import { encoded, formatDate, statusBadge, textBlock, triggerLabel } from '../lib/format.js';
import { hashLink, templateLink } from '../lib/links.js';
import { openConfirmDialog } from '../lib/dialogs.js';
import { renderViewContent } from '../lib/shell.js';

function isRunActive(status) {
  return status === 'queued' || status === 'running' || status === 'canceling';
}

// Trigger 是固定枚举（`all` / `incremental`，默认后者），选项不随当前页数据变化。
const TRIGGERS = ['all', 'incremental'];

async function runsView() {
  // 跟分页同源：Trigger 在服务端过滤，否则只会过滤当前这一页。
  let trigger = '';
  const showDeleted = h('input', { type: 'checkbox' });
  const body = h('div', { className: 'panel-slot' });
  const paint = async (page) => {
    const table = await pagedTable({
      label: 'Runs',
      page,
      headers: ['Run ID', 'Status', 'Template Name', 'Trigger', 'Succeeded / Total', 'Started'],
      load: async (target) => {
        const query = `?page=${target}${trigger ? `&trigger=${encoded(trigger)}` : ''}${showDeleted.checked ? '&include_deleted=1' : ''}`;
        const data = await api(`/api/runs${query}`);
        return {
          ...data,
          rows: data.items.map((run) => [
            // 逻辑删除的 Run 仍然打得开，只是列表里默认不出现（Show Deleted 才看到）。
            h('span', { className: 'row-inline' }, [
              hashLink(run.run_id, `#runs/${encoded(run.run_id)}`),
              run.deleted_at ? h('span', { className: 'badge deleted', textContent: 'Deleted' }) : null,
            ]),
            statusBadge(run.status),
            h('span', { className: 'truncate' }, templateLink(run.template_id, run.template_name)),
            triggerLabel(run.trigger),
            `${run.succeeded} / ${run.total}`,
            h('span', { textContent: formatDate(run.started_at) }),
          ]),
        };
      },
    });
    body.replaceChildren(dataPanel(h('div', { className: 'panel-body flush' }, table)));
  };
  // 切换只看当前 Run / 连逻辑删除的一起看：只重画列表，并回到第 1 页。
  showDeleted.addEventListener('change', () => { void paint(1); });
  await paint();
  return fragment(
    head('Runs', '', h('div', { className: 'run-actions' }, [
      h('label', { className: 'run-option' }, [showDeleted, h('span', { textContent: 'Show Deleted' })]),
      selectMenu({
        label: 'Filter by Trigger',
        any: 'All Triggers',
        groups: [{ values: TRIGGERS }],
        // 换筛选条件回到第 1 页。
        onChange: (value) => { trigger = value; void paint(1); },
      }),
    ])),
    body,
  );
}

function runContent(runId, run) {
  const deleted = Boolean(run.deleted_at);
  const items = Array.isArray(run.items) ? run.items : [];
  const rows = items.map((item) => [
    hashLink(item.record_id, `#runs/${encoded(runId)}/${encoded(item.record_id)}`),
    statusBadge(item.status),
    item.stage || '—',
    item.ms === null || item.ms === undefined ? '—' : `${item.ms} ms`,
    item.error || '—',
  ]);
  const total = run.total ?? items.length;
  const completed = run.completed ?? items.filter((item) => item.status !== 'queued' && item.status !== 'running').length;
  const percent = total ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  const actions = h('div', { className: 'run-actions' });
  if (isRunActive(run.status)) {
    const cancel = actionButton('Cancel', 'cancel');
    cancel.disabled = run.status === 'canceling';
    cancel.addEventListener('click', async (event) => {
      event.currentTarget.disabled = true;
      try {
        await api(`/api/runs/${encoded(runId)}/cancel`, { method: 'POST' });
      } catch (error) {
        setNotice(error.message, true);
        event.currentTarget.disabled = false;
      }
    });
    actions.append(cancel);
  }
  if (!isRunActive(run.status) && (run.failed || 0) > 0) {
    const retry = actionButton('Retry', 'retry', 'button primary');
    retry.addEventListener('click', async (event) => {
      event.currentTarget.disabled = true;
      try {
        const next = await api(`/api/runs/${encoded(runId)}/retry`, { method: 'POST' });
        location.hash = `runs/${encoded(next.run_id)}`;
      } catch (error) {
        setNotice(error.message, true);
        event.currentTarget.disabled = false;
      }
    });
    actions.append(retry);
  }
  // 删除：逻辑删除（文件留着，只是列表里不再出现），所以删过的 Run 不再给这个按钮。
  if (!deleted) {
    const remove = actionButton('Delete', 'unload', 'button danger');
    remove.disabled = isRunActive(run.status);
    remove.title = isRunActive(run.status) ? 'Cancel the Run before deleting it' : 'Hide this Run from the list';
    remove.addEventListener('click', async () => {
      const ok = await openConfirmDialog({
        title: 'Delete Run',
        message: `Delete run "${runId}"? It disappears from the Runs list; its logs and artifacts stay on disk and the Run can still be opened here.`,
        confirmText: 'Delete',
        danger: true,
      });
      if (!ok) return;
      // 注意：await 之后 event.currentTarget 已经是 null，按钮要直接引用。
      remove.disabled = true;
      try {
        await startOperation(`/api/runs/${encoded(runId)}`, {}, 'DELETE');
        setNotice('');
        location.hash = 'runs';
      } catch (error) {
        setNotice(error.message, true);
        remove.disabled = false;
      }
    });
    actions.append(remove);
  }

  return fragment(
    h('div', { className: 'view-head' }, [
      viewTitle(run.run_id || runId, [{ label: 'Runs', href: '#runs' }]),
      actions,
    ]),
    panel('Summary', h('div', { className: 'panel-body' }, kv([
      ['Status', statusBadge(run.status)],
      ...(deleted ? [['Deleted', h('span', { className: 'badge deleted', textContent: `Deleted · ${formatDate(run.deleted_at)}` })]] : []),
      ['Template Name', templateLink(run.template_id, run.template_name)],
      ['Trigger', triggerLabel(run.trigger)],
      ['Progress', `${completed} / ${total}`],
      ['Progress Bar', h('div', { className: 'progress' }, h('div', { className: 'progress-bar', style: `width:${percent}%` }))],
      ['Started', formatDate(run.started_at)],
      ['Finished', formatDate(run.finished_at)],
      ['Succeeded / Failed', `${run.succeeded ?? '—'} / ${run.failed ?? '—'}`],
      ['Work Hash', h('span', { className: 'mono', textContent: run.work_hash || '—' })],
    ]))),
    // 错误可能是整段 stderr（含换行与 JSON）：单独一块按日志渲染，别塞进 Summary 的一格里。
    run.error ? panel('Error', h('div', { className: 'panel-body' }, textBlock(run.error))) : null,
    panel('Run Items', h('div', { className: 'panel-body flush' }, dataTable(
      ['Record ID', 'Status', 'Stage', 'Duration', 'Error'],
      rows,
      'Run Items',
      'table-run-items',
    ))),
  );
}

async function runView(runId) {
  const initial = await api(`/api/runs/${encoded(runId)}`);
  let currentRun = initial;
  let queued = false;
  const refresh = (run, { animate = false } = {}) => {
    currentRun = run;
    // The run view repaints itself on every stream event, so it renders
    // directly and returns nothing for `render()` to place.
    renderViewContent(runContent(runId, run), { animate });
  };
  // 事件是按块推的：合并成一帧一次重画，别让页面每秒重画几十次。
  const refreshSoon = () => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      refresh(currentRun);
    }, 120);
  };
  refresh(initial, { animate: true });
  watchRun(runId, (event) => {
    if (event.type === 'item-stage') {
      const item = (currentRun.items || []).find((entry) => entry.record_id === event.record_id);
      if (item) item.stage = event.stage;
      refreshSoon();
      return;
    }
    if (event.run) {
      refresh(event.run);
    }
    if (event.type === 'error') setNotice(event.error?.message || 'Run failed', true);
  });
  return null;
}

export { runsView, runView };
