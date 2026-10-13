import { api } from '../lib/api.js';
import {
  dataPanel, dataTable, head, kv, mappingInputRows, mappingOutputRows, panel, section, togglePanel, viewTitle,
} from '../lib/components.js';
import { actionButton, fragment, h, setNotice } from '../lib/dom.js';
import { codeBlock, encoded, formatDate, statusBadge } from '../lib/format.js';
import { feishuBaseLink, hashLink, skillLink } from '../lib/links.js';

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
  const templates = await api('/api/templates');
  const rows = templates.map((template) => {
    const last = template.last_run;
    const id = template.template_id || template.ref;
    return [
      hashLink(template.ref, `#templates/${encoded(id)}`),
      h('span', { className: 'mono truncate', textContent: template.template_id || '—' }),
      `${template.inputs} in / ${template.outputs} out`,
      last ? statusBadge(last.status) : h('span', { className: 'muted', textContent: 'Never' }),
      h('span', { textContent: formatDate(template.created_at) }),
    ];
  });
  return fragment(
    head('Templates'),
    dataPanel(h('div', { className: 'panel-body flush' }, dataTable(
      ['Ref', 'Template ID', 'IO', 'Last Run', 'Created'],
      rows,
    ))),
  );
}

function runControl(template) {
  const allRows = h('input', { type: 'checkbox' });
  const allRowsField = h('label', { className: 'run-option' }, [
    allRows,
    h('span', { textContent: 'All Rows' }),
  ]);
  const button = actionButton('Run', 'run', 'button primary');
  button.addEventListener('click', async () => {
    button.disabled = true;
    setNotice('');
    try {
      if (allRows.checked && !window.confirm('Run all rows and write results back to the table?')) return;
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
  return h('div', { className: 'run-actions' }, [allRowsField, button]);
}

async function templateView(id) {
  const data = await api(`/api/templates/${encoded(id)}`);
  const template = data.template;
  const target = template.target || {};
  const skill = template.skill || {};
  return fragment(
    h('div', { className: 'view-head' }, [
      viewTitle(data.ref, [{ label: 'Templates', href: '#templates' }]),
      runControl(template),
    ]),
    panel('Summary', h('div', { className: 'panel-body' }, kv([
      ['Template ID', h('span', { className: 'mono', textContent: template.template_id || '—' })],
      ['Skill', skillLink(skill.path)],
      ['Skill Hash', h('span', { className: 'mono', textContent: skill.hash || '—' })],
      ['Feishu Base URL', feishuBaseLink(target)],
      ['Created', formatDate(template.created_at)],
    ]))),
    templateDefinitionPanel(template),
  );
}

export { templatesView, templateView };
