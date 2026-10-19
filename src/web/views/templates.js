import { api, startOperation, watchOperation } from '../lib/api.js';
import {
  dataPanel, dataTable, head, kv, mappingInputRows, mappingOutputRows, pagedTable, panel, section, togglePanel, viewTitle,
} from '../lib/components.js';
import { actionButton, fragment, h, icon, setNotice } from '../lib/dom.js';
import { codeBlock, encoded, formatDate, statusBadge } from '../lib/format.js';
import { larkBaseLink, hashLink, skillLink } from '../lib/links.js';
import { openConfirmDialog, openRunDialog } from '../lib/dialogs.js';
import { render } from '../lib/router.js';

function templateDefinitionPanel(template) {
  // 模板里只有已映射的条目，所以这两张表天然与飞书表里的列一一对应。
  const inputs = Array.isArray(template?.mapping?.inputs) ? template.mapping.inputs : [];
  const outputs = Array.isArray(template?.mapping?.outputs) ? template.mapping.outputs : [];
  return togglePanel('Template Definition', 'JSON', () => h('div', { className: 'contract-body' }, [
    section(`Inputs (${inputs.length})`, dataTable(
      ['Key', 'Field ID', 'Type', 'Required [Default]', 'Notes'],
      mappingInputRows(inputs),
      'Template Input Mapping',
      'contract-table',
    )),
    section(`Outputs (${outputs.length})`, dataTable(
      ['Key', 'Field ID', 'Type', 'Value Path', 'Notes'],
      mappingOutputRows(outputs),
      'Template Output Mapping',
      'contract-table',
    )),
  ]), () => codeBlock(template));
}

async function templatesView() {
  const showArchived = h('input', { type: 'checkbox' });
  const body = h('div', { className: 'panel-slot' });

  // `page` 不传就用记住的页号（首屏）；切「显示归档」时回到第 1 页。
  const paint = async (page) => {
    const includeArchived = showArchived.checked ? '&include_archived=1' : '';
    const table = await pagedTable({
      label: 'Templates',
      page,
      headers: ['Template Name', 'Template ID', 'IO', 'Last Run', 'Created'],
      load: async (target) => {
        const data = await api(`/api/templates?page=${target}${includeArchived}`);
        return {
          ...data,
          rows: data.items.map((template) => {
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
          }),
        };
      },
    });
    body.replaceChildren(dataPanel(h('div', { className: 'panel-body flush' }, table)));
  };

  // 切换只看当前可用 / 连归档一起看：只重画列表，不整页刷新。
  showArchived.addEventListener('change', () => { void paint(1); });
  await paint();
  return fragment(
    head('Templates', '', h('label', { className: 'run-option' }, [
      showArchived,
      h('span', { textContent: 'Show Archived' }),
    ])),
    body,
  );
}

function runControl(template) {
  const button = actionButton('Execute', 'run', 'button primary');
  // 归档即冻结：必须先解冻才跑。
  if (template.archived_at) {
    button.disabled = true;
    button.title = 'Archived templates are frozen; unarchive to run';
    return button;
  }
  // Run 之前先预览：弹框里给出「会影响多少行」，并让用户在这里决定要不要 All Rows；
  // 确认后弹框自己提交 Run，成功后带回 Run 记录用于跳转。
  button.addEventListener('click', async () => {
    button.disabled = true;
    setNotice('');
    try {
      const run = await openRunDialog({ templateId: template.template_id, target: template.target });
      if (run) location.hash = `runs/${encoded(run.run_id)}`;
    } finally {
      button.disabled = false;
    }
  });
  return button;
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
      ['Lark Base URL', larkBaseLink(target)],
      ['Created', formatDate(template.created_at)],
    ]))),
    templateDefinitionPanel(template),
  );
}

export { templatesView, templateView };
