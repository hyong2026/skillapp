import { api, startOperation, watchOperation } from '../lib/api.js';
import {
  dataPanel, dataTable, editableColumnTable, empty, head, kv, loadingPanel, panel, section, viewTitle,
} from '../lib/components.js';
import { openLoadDialog, openMappingDialog } from '../lib/dialogs.js';
import { actionButton, fragment, h, icon, setNotice } from '../lib/dom.js';
import { codeBlock, encoded, formatDate, statusBadge } from '../lib/format.js';
import { hashLink } from '../lib/links.js';
import { render } from '../lib/router.js';

async function skillsView() {
  const skills = await api('/api/skills');
  const rows = skills.map((skill) => [
    hashLink(skill.ref, `#skills/${encoded(skill.ref)}`),
    statusBadge(skill.status || 'invalid'),
    h('span', { textContent: formatDate(skill.loaded_at) }),
    h('span', { className: 'truncate', textContent: skill.source || '—' }),
  ]);
  const load = actionButton('Load', 'load', 'button primary');
  load.addEventListener('click', openLoadDialog);
  return fragment(
    head('Skills', '', h('div', { className: 'run-actions' }, load)),
    dataPanel(h('div', { className: 'panel-body flush' }, dataTable(
      ['Ref', 'Status', 'Loaded', 'Source'],
      rows,
    ))),
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

  const mapping = actionButton(activeOperations.mapping ? 'Mapping...' : 'Mapping', 'mapping', 'button');
  mapping.disabled = !hasMapping || Boolean(activeOperations.mapping);
  mapping.title = hasMapping ? 'Create a Template from this Skill' : 'Analyze the Skill first';
  if (activeOperations.mapping) mapping.replaceChildren(icon('spinner', 'icon spinner'), h('span', { textContent: 'Mapping...' }));
  mapping.addEventListener('click', () => openMappingDialog(ref));

  const unload = actionButton('Unload', 'unload', 'button danger');
  unload.disabled = Boolean(activeOperations.analyze || activeOperations.mapping || activeOperations.unload);
  unload.addEventListener('click', async () => {
    if (!window.confirm('Unload this Skill? Local files will be removed. Feishu columns will remain.')) return;
    unload.disabled = true;
    try {
      await startOperation(`/api/skills/${encoded(ref)}`, {}, 'DELETE');
      location.hash = 'skills';
    } catch (error) {
      setNotice(error.message, true);
      unload.disabled = false;
    }
  });
  return h('div', { className: 'run-actions' }, [analyze, mapping, unload]);
}

/** Mapping 面板：结构化 Inputs / Outputs 可直接改名与排序，JSON 开关看原文。 */
function mappingPanel(ref, mapping, canEdit) {
  const body = h('div', { className: 'panel-body toggle-body mapping-body' });
  let showJson = false;
  const contractBody = () => h('div', { className: 'contract-body' }, [
    section(`Inputs (${mapping.inputs.length})`, editableColumnTable('inputs', mapping.inputs, canEdit, save)),
    section(`Outputs (${mapping.outputs.length})`, editableColumnTable('outputs', mapping.outputs, canEdit, save)),
  ]);
  const save = async (patch) => {
    const next = { ...mapping, ...patch };
    await api(`/api/skills/${encoded(ref)}/mapping`, { method: 'PUT', body: { mapping: next } });
    setNotice('Mapping saved');
    await render({ preserveScroll: true });
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
  return panel('Mapping', body, control);
}

async function skillView(ref) {
  const skill = await api(`/api/skills/${encoded(ref)}`);
  const analysis = skill.analysis || {};
  const mapping = analysis.mapping || null;
  const activeOperations = skill.operations || {};
  const contractSlot = h('div');
  const mappingSlot = h('div');
  const paintAnalysis = () => {
    contractSlot.replaceChildren(analysis.mapping
      ? mappingPanel(ref, analysis.mapping, !activeOperations.analyze && !activeOperations.mapping && !activeOperations.unload)
      : panel('Mapping', h('div', { className: 'panel-body mapping-body' }, empty('No Mapping available.'))));
  };
  const setAnalysisLoading = () => {
    const current = contractSlot.firstElementChild;
    const height = current ? Math.round(current.getBoundingClientRect().height) : 0;
    const loading = loadingPanel('Mapping', 'Analyzing Skill IO...', 'mapping-body');
    if (height) loading.style.minHeight = `${height}px`;
    contractSlot.replaceChildren(loading);
  };
  const restoreAnalysis = () => paintAnalysis();
  paintAnalysis();
  if (activeOperations.analyze) setAnalysisLoading();
  if (activeOperations.mapping) mappingSlot.replaceChildren(loadingPanel('Mapping', 'Creating Template...'));
  const summary = panel('Summary', h('div', { className: 'panel-body' }, kv([
    ['Ref', skill.ref],
    ['Status', statusBadge(skill.status || 'invalid')],
    ['Fingerprint', h('span', { className: 'mono', textContent: skill.hash || '—' })],
    ['Loaded', formatDate(skill.loaded_at)],
    ['Source', skill.source || '—'],
  ])));
  if (activeOperations.analyze) {
    watchOperation(ref, activeOperations.analyze.operation_id).then(() => render()).catch((error) => setNotice(error.message, true));
  } else if (activeOperations.mapping) {
    watchOperation(ref, activeOperations.mapping.operation_id)
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
    mappingSlot,
  );
}

export { skillsView, skillView };
