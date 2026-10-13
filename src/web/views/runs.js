import { api, watchRun } from '../lib/api.js';
import { dataPanel, dataTable, empty, head, kv, panel, viewTitle } from '../lib/components.js';
import { actionButton, fragment, h, setNotice } from '../lib/dom.js';
import { codeBlock, encoded, formatDate, statusBadge, triggerLabel } from '../lib/format.js';
import { hashLink, templateLink } from '../lib/links.js';
import { renderViewContent } from '../lib/shell.js';

function isRunActive(status) {
  return status === 'queued' || status === 'running' || status === 'canceling';
}

async function runsView() {
  const runs = await api('/api/runs');
  const rows = runs.map((run) => [
    hashLink(run.run_id, `#runs/${encoded(run.run_id)}`),
    statusBadge(run.status),
    h('span', { className: 'mono truncate' }, templateLink(run.template_id)),
    triggerLabel(run.trigger),
    `${run.succeeded} / ${run.total}`,
    run.failed ? h('span', { className: 'mono', textContent: String(run.failed) }) : '0',
    h('span', { textContent: formatDate(run.started_at) }),
  ]);
  return fragment(
    head('Runs'),
    dataPanel(h('div', { className: 'panel-body flush' }, dataTable(
      ['Run ID', 'Status', 'Template ID', 'Trigger', 'Succeeded / Total', 'Failed', 'Started'],
      rows,
    ))),
  );
}

function runContent(runId, run, liveLogs) {
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

  const logPanel = h('div', { className: 'live-logs' });
  for (const [recordId, streams] of liveLogs.entries()) {
    logPanel.append(h('section', { className: 'live-log' }, [
      h('h3', { textContent: recordId }),
      h('div', { className: 'detail-grid' }, [
        panel('Stdout', h('div', { className: 'panel-body' }, streams.stdout ? codeBlock(streams.stdout) : empty('No output'))),
        panel('Stderr', h('div', { className: 'panel-body' }, streams.stderr ? codeBlock(streams.stderr) : empty('No output'))),
      ]),
    ]));
  }

  return fragment(
    h('div', { className: 'view-head' }, [
      viewTitle(run.run_id || runId, [{ label: 'Runs', href: '#runs' }]),
      actions,
    ]),
    panel('Summary', h('div', { className: 'panel-body' }, kv([
      ['Status', statusBadge(run.status)],
      ['Template ID', h('span', { className: 'mono' }, templateLink(run.template_id))],
      ['Trigger', triggerLabel(run.trigger)],
      ['Progress', `${completed} / ${total}`],
      ['Progress Bar', h('div', { className: 'progress' }, h('div', { className: 'progress-bar', style: `width:${percent}%` }))],
      ['Started', formatDate(run.started_at)],
      ['Finished', formatDate(run.finished_at)],
      ['Succeeded / Failed', `${run.succeeded ?? '—'} / ${run.failed ?? '—'}`],
      ['Work Hash', h('span', { className: 'mono', textContent: run.work_hash || '—' })],
    ]))),
    panel('Run Items', h('div', { className: 'panel-body flush' }, dataTable(
      ['Record ID', 'Status', 'Stage', 'Duration', 'Error'],
      rows,
      'Run Items',
      'table-run-items',
    ))),
    logPanel.childElementCount ? panel('Live Output', h('div', { className: 'panel-body' }, logPanel)) : null,
  );
}

async function runView(runId) {
  const initial = await api(`/api/runs/${encoded(runId)}`);
  const liveLogs = new Map();
  let currentRun = initial;
  const refresh = (run) => {
    currentRun = run;
    // The run view repaints itself on every stream event, so it renders
    // directly and returns nothing for `render()` to place.
    renderViewContent(runContent(runId, run, liveLogs));
  };
  refresh(initial);
  watchRun(runId, (event) => {
    if (event.type === 'item-stage') {
      const item = (currentRun.items || []).find((entry) => entry.record_id === event.record_id);
      if (item) item.stage = event.stage;
      refresh(currentRun);
      return;
    }
    if (event.type === 'item-log') {
      const streams = liveLogs.get(event.record_id) || { stdout: '', stderr: '' };
      streams[event.stream] = `${streams[event.stream]}${event.chunk}`.slice(-24000);
      liveLogs.set(event.record_id, streams);
      refresh(currentRun);
      return;
    }
    if (event.run) refresh(event.run);
    if (event.type === 'error') setNotice(event.error?.message || 'Run failed', true);
  });
  return null;
}

export { runsView, runView };
