import { api } from '../lib/api.js';
import { dataPanel, head, kv, pagedTable, panel, selectMenu, viewTitle } from '../lib/components.js';
import { fragment, h } from '../lib/dom.js';
import { codeBlock, encoded, formatDate, formatDuration, statusBadge } from '../lib/format.js';
import { hashLink, subjectLink } from '../lib/links.js';

// 操作类型按业务对象分组（Skill / Template / Run），组内按业务顺序（装载 → 分析 → 卸载 这种）。
const TYPE_GROUPS = [
  { label: 'Skills', values: ['load-skill', 'analyze-skill', 'unload-skill'] },
  { label: 'Templates', values: ['bind-table', 'archive-template', 'unarchive-template'] },
  { label: 'Runs', values: ['execute-template', 'delete-run'] },
];

async function operationsView() {
  // 筛选要跟分页同源，所以 Type 走服务端过滤（`?type=`）：选项是固定的领域类型，
  // 不随当前这页的数据变化（筛出来为空也是有效结果）。
  let type = '';
  const body = h('div', { className: 'panel-slot' });
  const paint = async (page) => {
    const table = await pagedTable({
      label: 'Operations',
      page,
      headers: ['Operation ID', 'Status', 'Type', 'Subject', 'Started', 'Duration'],
      load: async (target) => {
        const data = await api(`/api/operations?page=${target}${type ? `&type=${encoded(type)}` : ''}`);
        return {
          ...data,
          rows: data.items.map((operation) => [
            hashLink(operation.operation_id, `#operations/${encoded(operation.operation_id)}`),
            statusBadge(operation.status),
            h('span', { className: 'mono', textContent: operation.type || '—' }),
            subjectLink(operation.subject),
            h('span', { textContent: formatDate(operation.started_at || operation.created_at) }),
            h('span', { className: 'mono', textContent: formatDuration(operation.duration_ms) }),
          ]),
        };
      },
    });
    body.replaceChildren(dataPanel(h('div', { className: 'panel-body flush' }, table)));
  };
  await paint();
  return fragment(
    head('Operations', '', selectMenu({
      label: 'Filter by Type',
      groups: TYPE_GROUPS,
      // 换筛选条件回到第 1 页，否则会停在一个无意义的页号上。
      onChange: (value) => { type = value; void paint(1); },
    })),
    body,
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
