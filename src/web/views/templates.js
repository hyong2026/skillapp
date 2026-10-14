import { api, startOperation, watchOperation } from '../lib/api.js';
import {
  dataPanel, dataTable, head, kv, mappingInputRows, mappingOutputRows, pagedTable, panel, section, togglePanel, viewTitle,
} from '../lib/components.js';
import { actionButton, fragment, h, icon, setNotice } from '../lib/dom.js';
import { codeBlock, encoded, formatDate, statusBadge, triggerLabel } from '../lib/format.js';
import { feishuBaseLink, hashLink, skillLink } from '../lib/links.js';
import { openConfirmDialog, openMessageDialog } from '../lib/dialogs.js';
import { render } from '../lib/router.js';

function templateDefinitionPanel(template) {
  const inputs = Array.isArray(template?.mapping?.inputs) ? template.mapping.inputs : [];
  const outputs = Array.isArray(template?.mapping?.outputs) ? template.mapping.outputs : [];
  return togglePanel('Template Definition', 'JSON', () => h('div', { className: 'contract-body' }, [
    section(`Inputs (${inputs.length})`, dataTable(
      ['Key', 'Field ID', 'Type', 'Required', 'Default', 'Rules'],
      mappingInputRows(inputs),
      'Template Input Mapping',
    )),
    section(`Outputs (${outputs.length})`, dataTable(
      ['Key', 'Field ID', 'Type', 'Value Path', 'Precision'],
      mappingOutputRows(outputs),
      'Template Output Mapping',
    )),
  ]), () => codeBlock(template));
}

async function templatesView() {
  const showArchived = h('input', { type: 'checkbox' });
  const body = h('div');

  const paint = async () => {
    const query = showArchived.checked ? '?scope=all' : '';
    const templates = await api(`/api/templates${query}`);
    const rows = templates.map((template) => {
      const last = template.last_run;
      const id = template.template_id || template.name || template.ref;
      return [
        // 名字在前且带链接；链接锚点仍用 template_id（改过文件名也不会断）。
        h('span', { className: 'row-inline' }, [
          hashLink(template.name || id, `#templates/${encoded(id)}`),
          template.archived_at ? h('span', { className: 'badge archived', textContent: 'Archived' }) : null,
        ]),
        h('span', { className: 'mono truncate', textContent: template.template_id || '—' }),
        `${template.inputs} in / ${template.outputs} out`,
        last ? statusBadge(last.status) : h('span', { className: 'muted', textContent: 'Never' }),
        h('span', { textContent: formatDate(template.created_at) }),
      ];
    });
    body.replaceChildren(dataPanel(h('div', { className: 'panel-body flush' }, pagedTable(
      ['Template Name', 'Template ID', 'IO', 'Last Run', 'Created'],
      rows,
      { label: 'Templates' },
    ))));
  };

  // 切换只看当前可用 / 连归档一起看：只重画列表，不整页刷新。
  showArchived.addEventListener('change', () => { void paint(); });
  await paint();
  return fragment(
    head('Templates', '', h('label', { className: 'run-option' }, [
      showArchived,
      h('span', { textContent: 'Show archived' }),
    ])),
    body,
  );
}

function runControl(template) {
  const allRows = h('input', { type: 'checkbox' });
  const allRowsField = h('label', { className: 'run-option' }, [
    allRows,
    h('span', { textContent: 'All Rows' }),
  ]);
  const button = actionButton('Run', 'run', 'button primary');
  const preview = actionButton('Preview', 'code', 'button');
  const trigger = () => (allRows.checked ? 'all' : 'incremental');
  // 只核对，不执行：把「会动哪些行、哪些列会被跳过」先弹给用户看。
  preview.addEventListener('click', async () => {
    preview.disabled = true;
    setNotice('');
    try {
      const data = await api('/api/runs/preview', {
        method: 'POST',
        body: { template_id: template.template_id, trigger: trigger() },
      });
      openMessageDialog({
        title: 'Preview',
        rows: [
          ['Trigger', triggerLabel(data.trigger)],
          ['Rows in table', String(data.total)],
          ['Rows to process', String(data.selected)],
          ['Feishu Base URL', feishuBaseLink(data.target)],
        ],
        hint: 'Dry run only - nothing runs, nothing is written back, no Run is recorded.',
      });
    } catch (error) {
      openMessageDialog({ title: 'Preview failed', rows: [], hint: error.message });
    } finally {
      preview.disabled = false;
    }
  });
  // 归档即冻结：必须先解冻才跑。
  if (template.archived_at) {
    allRows.disabled = true;
    button.disabled = true;
    preview.disabled = true;
    button.title = 'Archived templates are frozen; unarchive to run';
    preview.title = 'Archived templates are frozen; unarchive to run';
  }
  button.addEventListener('click', async () => {
    button.disabled = true;
    setNotice('');
    try {
      const ok = !allRows.checked || await openConfirmDialog({
        title: 'Run all rows',
        message: 'Run every row and write the results back to the Feishu table?',
        confirmText: 'Run',
      });
      if (!ok) return;
      const run = await api('/api/runs', {
        method: 'POST',
        body: {
          template_id: template.template_id,
          trigger: allRows.checked ? 'all' : 'incremental',
        },
      });
      location.hash = `runs/${encoded(run.run_id)}`;
    } catch (error) {
      setNotice(error.message, true);
      button.disabled = false;
    }
  });
  return h('div', { className: 'run-actions' }, [allRowsField, preview, button]);
}

/** 归档 / 解冻：走一次持久化操作，Operations 里能查到。 */
function archiveButton(template, templateName) {
  const archived = Boolean(template.archived_at);
  const label = archived ? 'Unarchive' : 'Archive';
  const button = actionButton(label, archived ? 'retry' : 'unload', archived ? 'button' : 'button danger');
  button.addEventListener('click', async () => {
    const name = templateName || template.template_id;
    const ok = await openConfirmDialog(archived
      ? {
        title: 'Unarchive Template',
        message: `Unarchive "${name}"? It becomes visible in the list and runnable again.`,
        confirmText: 'Unarchive',
      }
      : {
        title: 'Archive Template',
        message: `Archive "${name}"? It is frozen: it disappears from the list and cannot run until unarchived. The file and its Runs are kept.`,
        confirmText: 'Archive',
        danger: true,
      });
    if (!ok) return;
    button.disabled = true;
    try {
      await startOperation(
        `/api/templates/${encoded(template.template_id)}/${archived ? 'unarchive' : 'archive'}`,
        {},
        'POST',
      );
      setNotice('');
      await render();
    } catch (error) {
      setNotice(error.message, true);
      button.disabled = false;
    }
  });
  return button;
}

async function templateView(id) {
  const data = await api(`/api/templates/${encoded(id)}`);
  const template = data.template;
  const target = template.target || {};
  const skill = template.skill || {};
  const archived = Boolean(template.archived_at);
  const templateName = data.name || data.ref;
  return fragment(
    h('div', { className: 'view-head' }, [
      // 标题就是 Template Name（文件名，唯一标识这份 Template）；面包屑只留上一级。
      viewTitle(templateName, [{ label: 'Templates', href: '#templates' }]),
      h('div', { className: 'run-actions' }, [runControl(template), archiveButton(template, templateName)]),
    ]),
    panel('Summary', h('div', { className: 'panel-body' }, kv([
      ['Template ID', h('span', { className: 'mono', textContent: template.template_id || '—' })],
      ...(archived ? [['Status', h('span', { className: 'badge archived', textContent: `Archived · ${formatDate(template.archived_at)}` })]] : []),
      ['Skill Name', skillLink(skill.path)],
      ['Skill Hash', h('span', { className: 'mono', textContent: skill.hash || '—' })],
      ['Feishu Base URL', feishuBaseLink(target)],
      ['Created', formatDate(template.created_at)],
    ]))),
    templateDefinitionPanel(template),
  );
}

export { templatesView, templateView };
