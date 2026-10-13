import { api } from '../lib/api.js';
import { dataPanel, dataTable, head, kv, panel, viewTitle } from '../lib/components.js';
import { fragment, h } from '../lib/dom.js';
import { codeBlock, encoded, formatDate, formatDuration, statusBadge } from '../lib/format.js';
import { hashLink, subjectLink } from '../lib/links.js';

async function operationsView() {
  const operations = await api('/api/operations');
  const rows = operations.map((operation) => [
    hashLink(operation.operation_id, `#operations/${encoded(operation.operation_id)}`),
    statusBadge(operation.status),
    h('span', { className: 'mono', textContent: operation.type || '—' }),
    subjectLink(operation.subject),
    h('span', { textContent: formatDate(operation.started_at || operation.created_at) }),
    h('span', { className: 'mono', textContent: formatDuration(operation.duration_ms) }),
  ]);
  return fragment(
    head('Operations'),
    dataPanel(h('div', { className: 'panel-body flush' }, dataTable(
      ['Operation', 'Status', 'Type', 'Subject', 'Started', 'Duration'],
      rows,
    ))),
  );
}

async function operationView(operationId) {
  const data = await api(`/api/operations/${encoded(operationId)}`);
  const operation = data.operation || {};
  return fragment(
    h('div', { className: 'view-head' }, [
      viewTitle(operationId, [{ label: 'Operations', href: '#operations' }]),
    ]),
    panel('Summary', h('div', { className: 'panel-body' }, kv([
      ['Type', h('span', { className: 'mono', textContent: operation.type || '—' })],
      ['Status', statusBadge(operation.status)],
      ['Subject', subjectLink(data.subject)],
      ['Trigger', data.trigger || '—'],
      ['Created', formatDate(operation.created_at)],
      ['Started', formatDate(operation.started_at)],
      ['Finished', formatDate(operation.finished_at)],
      ['Duration', h('span', { className: 'mono', textContent: formatDuration(data.duration_ms) })],
      ['Counts', data.counts ? `${data.counts.succeeded ?? '—'} / ${data.counts.total ?? '—'}` : '—'],
    ]))),
    panel('Operation Record', h('div', { className: 'panel-body' }, codeBlock(operation))),
  );
}

export { operationsView, operationView };
