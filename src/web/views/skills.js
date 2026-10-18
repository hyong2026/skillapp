import { api, startOperation, watchOperation } from '../lib/api.js';
import {
  dataPanel, editableSchemaTable, empty, head, kv, loadingPanel, pagedTable, panel, section, viewTitle,
} from '../lib/components.js';
import { openConfirmDialog, openLoadDialog, openMappingDialog } from '../lib/dialogs.js';
import { actionButton, fragment, h, icon, setNotice } from '../lib/dom.js';
import { codeBlock, encoded, formatDate, statusBadge } from '../lib/format.js';
import { hashLink } from '../lib/links.js';
import { render } from '../lib/router.js';

async function skillsView() {
  const table = await pagedTable({
    label: 'Skills',
    headers: ['Skill Name', 'Status', 'Loaded', 'Source'],
    load: async (page) => {
      const data = await api(`/api/skills?page=${page}`);
      return {
        ...data,
        rows: data.items.map((skill) => [
          hashLink(skill.ref, `#skills/${encoded(skill.ref)}`),
          statusBadge(skill.status || 'invalid'),
          h('span', { textContent: formatDate(skill.loaded_at) }),
          h('span', { className: 'truncate', textContent: skill.source || '—' }),
        ]),
      };
    },
  });
  const loadButton = actionButton('Load', 'load', 'button primary');
  loadButton.addEventListener('click', openLoadDialog);
  return fragment(
    head('Skills', '', h('div', { className: 'run-actions' }, loadButton)),
    dataPanel(h('div', { className: 'panel-body flush' }, table)),
  );
}

function skillActions(ref, analysis, hasMapping, activeOperations, setAnalysisLoading, restoreAnalysis) {
  const analyzeLabel = analysis?.state === 'missing' || !analysis?.state ? 'Analyze' : 'Re-analyze';
  const analyze = actionButton(activeOperations.analyze ? 'Analyzing' : analyzeLabel, 'analyze', 'button primary');
  if (activeOperations.analyze) {
    analyze.disabled = true;
    analyze.replaceChildren(icon('spinner', 'icon spinner'), h('span', { textContent: 'Analyzing' }));
  }
  analyze.addEventListener('click', async () => {
    analyze.disabled = true;
    analyze.replaceChildren(icon('spinner', 'icon spinner'), h('span', { textContent: 'Analyzing' }));
    setAnalysisLoading();
    try {
      await startOperation(`/api/skills/${encoded(ref)}/analyze`, {}, 'POST');
      setNotice('');
      render();
    } catch (error) {
      restoreAnalysis();
      setNotice(error.message, true);
      analyze.disabled = false;
      analyze.replaceChildren(icon('analyze'), h('span', { textContent: analyzeLabel }));
    }
  });

  const mapping = actionButton(activeOperations.bind ? 'Binding...' : 'Bind Table', 'mapping', 'button');
  mapping.disabled = !hasMapping || Boolean(activeOperations.bind);
  mapping.title = hasMapping ? 'Bind this IO Schema to a Lark table and create a Template' : 'Analyze the Skill first';
  if (activeOperations.bind) mapping.replaceChildren(icon('spinner', 'icon spinner'), h('span', { textContent: 'Binding...' }));
  mapping.addEventListener('click', () => openMappingDialog(ref));

  const unload = actionButton('Unload', 'unload', 'button danger');
  unload.disabled = Boolean(activeOperations.analyze || activeOperations.bind || activeOperations.unload);
  unload.addEventListener('click', async () => {
    const ok = await openConfirmDialog({
      title: 'Unload Skill',
      message: `Unload "${ref}"? The loaded copy, its IO Schema and its Templates are removed. Lark columns and past Runs are kept.`,
      confirmText: 'Unload',
      danger: true,
    });
    if (!ok) return;
    unload.disabled = true;
    try {
      // 不带 ?with_runs=1：默认只删副本 + IO Schema + Template，Run 作为历史留着。
      await startOperation(`/api/skills/${encoded(ref)}`, {}, 'DELETE');
      location.hash = 'skills';
    } catch (error) {
      setNotice(error.message, true);
      unload.disabled = false;
    }
  });
  return h('div', { className: 'run-actions' }, [analyze, mapping, unload]);
}

/** 面板编辑的是分析产出的 IO Schema（还没绑定）；把它绑到表上的动作叫 Bind。 */
const SCHEMA_PANEL_TITLE = 'IO Schema';

/** IO Schema 面板：结构化 Inputs / Outputs 可改名、排序、勾选映射，JSON 开关看原文。 */
function schemaPanel(ref, mapping, canEdit) {
  const body = h('div', { className: 'panel-body toggle-body schema-body' });
  let showJson = false;
  const contractBody = () => h('div', { className: 'contract-body' }, [
    section(`Inputs (${mapping.inputs.length})`, editableSchemaTable('inputs', mapping.inputs, canEdit, save)),
    section(`Outputs (${mapping.outputs.length})`, editableSchemaTable('outputs', mapping.outputs, canEdit, save)),
  ]);
  const save = async () => {
    // 面板自己维护状态（原地改 mapping.inputs / outputs），保存后不重绘页面。
    await api(`/api/skills/${encoded(ref)}/schema`, { method: 'PUT', body: { mapping } });
  };
  const control = h('button', {
    className: 'code-toggle',
    type: 'button',
    role: 'switch',
    'aria-checked': 'false',
    'aria-label': 'Show JSON',
    onClick: () => {
      showJson = !showJson;
      control.classList.toggle('active', showJson);
      control.setAttribute('aria-checked', String(showJson));
      control.setAttribute('aria-label', `${showJson ? 'Hide' : 'Show'} JSON`);
      body.replaceChildren(showJson ? codeBlock(mapping) : contractBody());
    },
  }, [
    icon('code'),
    h('span', { textContent: 'JSON' }),
    h('span', { className: 'toggle-track', 'aria-hidden': 'true' }, h('span', { className: 'toggle-thumb' })),
  ]);
  body.replaceChildren(contractBody());
  return panel(SCHEMA_PANEL_TITLE, body, control);
}

async function skillView(ref) {
  const skill = await api(`/api/skills/${encoded(ref)}`);
  const analysis = skill.analysis || {};
  const mapping = analysis.mapping || null;
  const activeOperations = skill.operations || {};
  const contractSlot = h('div');
  const bindSlot = h('div');
  const paintAnalysis = () => {
    contractSlot.replaceChildren(analysis.mapping
      ? schemaPanel(ref, analysis.mapping, !activeOperations.analyze && !activeOperations.bind && !activeOperations.unload)
      : panel(SCHEMA_PANEL_TITLE, h('div', { className: 'panel-body schema-body' }, empty('No Mapping available.'))));
  };
  const setAnalysisLoading = () => {
    // 不继承上一份 Schema 的高度（那会把"分析中"撑成一大片空白），回到面板的默认高度。
    contractSlot.replaceChildren(loadingPanel(SCHEMA_PANEL_TITLE, 'Analyzing Skill IO...', 'schema-body'));
  };
  const restoreAnalysis = () => paintAnalysis();
  paintAnalysis();
  if (activeOperations.analyze) setAnalysisLoading();
  if (activeOperations.bind) bindSlot.replaceChildren(loadingPanel(SCHEMA_PANEL_TITLE, 'Creating Template...'));
  const summary = panel('Summary', h('div', { className: 'panel-body' }, kv([
    ['Status', statusBadge(skill.status || 'invalid')],
    ['Fingerprint', h('span', { className: 'mono', textContent: skill.hash || '—' })],
    ['Loaded', formatDate(skill.loaded_at)],
    ['Source', skill.source || '—'],
    ['Description', skill.description || '—'],
  ])));
  if (activeOperations.analyze) {
    watchOperation(activeOperations.analyze.operation_id).then(() => render()).catch((error) => setNotice(error.message, true));
  } else if (activeOperations.bind) {
    watchOperation(activeOperations.bind.operation_id)
      .then((result) => { location.hash = `templates/${encoded(result.template.template_id)}`; })
      .catch((error) => setNotice(error.message, true));
  }

  return fragment(
    h('div', { className: 'view-head' }, [
      viewTitle(skill.ref, [{ label: 'Skills', href: '#skills' }]),
      skillActions(ref, analysis, Boolean(mapping), activeOperations, setAnalysisLoading, restoreAnalysis),
    ]),
    summary,
    analysis.state === 'stale' || analysis.state === 'unverified' ? h('div', { className: 'warning-box', textContent: analysis.reason }) : null,
    contractSlot,
    bindSlot,
  );
}

export { skillsView, skillView };
