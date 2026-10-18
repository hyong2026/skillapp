/**
 * home.js — Home：SkillApp 的全流程入口
 *
 * 四步：Load Skill → Analyze IO（含 IO Schema 配置）→ Bind Table → Run Template。
 * Run 一发起就跳去 Run 详情页（那里有实时结果与日志），所以本页没有"结果"这一步。
 * 状态只活在这一次访问里：刷新或切走就从头开始，不持久化"当前 Skill"。
 * 每一步都调现有接口（装载 / 分析 / 保存 Schema / 绑定 / 执行），
 * 所以 Operations 与左侧 Messages 会自动出现对应记录。
 */
import { api, startOperation } from '../lib/api.js';
import { editableSchemaTable, kv, loadingPanel, section, viewTitle } from '../lib/components.js';
import { actionButton, fragment, h, icon, setNotice } from '../lib/dom.js';
import { encoded, formatDate } from '../lib/format.js';
import { larkBaseLink, hashLink } from '../lib/links.js';

const STEPS = [
  ['load', '1', 'Load Skill'],
  ['analyze', '2', 'Analyze IO'],
  ['bind', '3', 'Bind Table'],
  ['run', '4', 'Run Template'],
];

function stepSection(key, index, title, body, note) {
  const state = h('span', { className: 'step-state' });
  const section_ = h('section', { className: 'step is-pending', 'data-step': key }, [
    h('div', { className: 'step-rail' }, h('span', { className: 'step-index', textContent: index })),
    h('div', { className: 'step-card' }, [
      h('div', { className: 'step-head' }, [h('h3', { className: 'step-title', textContent: title }), state]),
      note ? h('p', { className: 'step-note', textContent: note }) : null,
      body ? h('div', { className: 'step-body' }, body) : null,
    ]),
  ]);
  return { section: section_, state };
}

/** replaceChildren(null) 会渲染成字面量 "null"，所以统一走这里。 */
function fill(slot, node) {
  if (node) slot.replaceChildren(node);
  else slot.replaceChildren();
}

async function homeView() {
  // 一次访问内的流程状态（不持久化，符合"Home 不保留当前 Skill"）。
  const state = { ref: null, skill: null, mapping: null, template: null, run: null, busy: null };

  // ---------- 1. Load ----------
  const pathInput = h('input', {
    className: 'flow-input',
    type: 'text',
    placeholder: '/Users/me/skills/my-skill',
    'aria-label': 'Skill root path',
  });
  const loadButton = actionButton('Load', 'load', 'button primary');
  const loadResult = h('div', { className: 'step-result' });
  const loadStep = stepSection('load', '1', 'Load Skill', h('div', { className: 'flow-row' }, [pathInput, loadButton]), 'Copies the Skill into SkillApp and pins it by content fingerprint.');
  loadStep.section.querySelector('.step-card').append(loadResult);

  const runLoad = async () => {
    const source = pathInput.value.trim();
    if (!source) {
      setNotice('Enter a Skill root path', true);
      pathInput.focus();
      return;
    }
    loadButton.disabled = true;
    state.busy = 'load';
    paint();
    try {
      const result = await startOperation('/api/skills', { source_path: source }, 'POST');
      state.ref = result.ref;
      state.skill = await api(`/api/skills/${encoded(result.ref)}`);
      state.mapping = state.skill.analysis?.mapping || null;
      setNotice('');
    } catch (error) {
      setNotice(error.message, true);
    } finally {
      state.busy = null;
      loadButton.disabled = false;
      loadButton.replaceChildren(icon('load'), h('span', { textContent: 'Load' }));
      paint();
    }
  };
  loadButton.addEventListener('click', runLoad);
  pathInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') runLoad(); });

  // ---------- 2. Analyze + IO Schema ----------
  const analyzeButton = actionButton('Analyze', 'analyze', 'button primary');
  const analyzeSlot = h('div');
  const analyzeStep = stepSection('analyze', '2', 'Analyze IO', analyzeSlot, 'Reads the Skill and writes the IO Schema below. Rename, reorder or uncheck fields - saved as you go.');

  const saveMapping = async () => {
    await api(`/api/skills/${encoded(state.ref)}/schema`, { method: 'PUT', body: { mapping: state.mapping } });
  };

  const paintAnalyze = () => {
    if (!state.ref) {
      analyzeSlot.replaceChildren(h('p', { className: 'step-hint', textContent: 'Load a Skill first.' }));
      analyzeButton.disabled = true;
      return;
    }
    analyzeButton.disabled = Boolean(state.busy) || !state.ref;
    analyzeButton.replaceChildren(icon('analyze'), h('span', { textContent: state.mapping ? 'Re-analyze' : 'Analyze' }));
    analyzeSlot.replaceChildren(h('div', { className: 'flow-row' }, analyzeButton));
    if (!state.mapping) return;
    const mapping = state.mapping;
    const editor = h('div', { className: 'contract-body' }, [
      section(`Inputs (${mapping.inputs.length})`, editableSchemaTable('inputs', mapping.inputs, true, saveMapping)),
      section(`Outputs (${mapping.outputs.length})`, editableSchemaTable('outputs', mapping.outputs, true, saveMapping)),
    ]);
    analyzeSlot.append(h('div', { className: 'flow-editor' }, editor));
  };

  const runAnalyze = async () => {
    if (!state.ref) return;
    state.busy = 'analyze';
    paint();
    // 同上：分析中用面板默认高度，不继承上一份 Schema 的高度。
    analyzeSlot.replaceChildren(loadingPanel('IO Schema', 'Analyzing IO...'));
    try {
      await startOperation(`/api/skills/${encoded(state.ref)}/analyze`, {}, 'POST');
      state.skill = await api(`/api/skills/${encoded(state.ref)}`);
      state.mapping = state.skill.analysis?.mapping || null;
      setNotice('');
    } catch (error) {
      setNotice(error.message, true);
    } finally {
      state.busy = null;
      paint();
    }
  };
  analyzeButton.addEventListener('click', runAnalyze);

  // ---------- 3. Bind Table ----------
  const urlInput = h('input', {
    className: 'flow-input',
    type: 'text',
    placeholder: 'https://my.feishu.cn/base/...?table=...&view=...',
    'aria-label': 'Lark Base URL',
  });
  const bindButton = actionButton('Bind', 'mapping', 'button primary');
  const bindResult = h('div', { className: 'step-result' });
  const bindStep = stepSection('bind', '3', 'Bind Table', h('div', { className: 'flow-row' }, [urlInput, bindButton]), 'Creates the missing columns in that table, orders them, and produces a Template. One table (with its view) has one Template.');
  bindStep.section.querySelector('.step-card').append(bindResult);

  const runBind = async () => {
    const url = urlInput.value.trim();
    if (!url) {
      setNotice('Enter a Lark Base URL', true);
      urlInput.focus();
      return;
    }
    state.busy = 'bind';
    paint();
    try {
      const result = await startOperation(`/api/skills/${encoded(state.ref)}/bind`, { url }, 'POST');
      const id = result.template.template_id;
      const detail = await api(`/api/templates/${encoded(id)}`);
      state.template = { ...result.template, ...detail.template, name: detail.name };
      setNotice('');
    } catch (error) {
      setNotice(error.message, true);
    } finally {
      state.busy = null;
      paint();
    }
  };
  bindButton.addEventListener('click', runBind);
  urlInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') runBind(); });

  // ---------- 4. Run ----------
  // 第一次使用只给一个 Run：不加 All Rows（全量）与 Preview（dry-run），
  // 默认就是增量——只跑没成功过、或输入/版本变过的行，可安全重复点。
  const runButton = actionButton('Run', 'run', 'button primary');
  const runStep = stepSection('run', '4', 'Run Template', h('div', { className: 'flow-row' }, runButton), 'Fill the input columns in the table, then Run - you land on the Run page for live results. Only rows that never succeeded (or changed) are processed.');

  runButton.addEventListener('click', async () => {
    if (!state.template) return;
    runButton.disabled = true;
    try {
      state.run = await api('/api/runs', {
        method: 'POST',
        body: { template_id: state.template.template_id, trigger: 'incremental' },
      });
      setNotice('');
      // Run 详情页自己接 SSE，实时显示逐行结果与日志。
      location.hash = `runs/${encoded(state.run.run_id)}`;
    } catch (error) {
      setNotice(error.message, true);
    } finally {
      runButton.disabled = false;
    }
  });

  function paint() {
    const done = {
      load: Boolean(state.ref),
      analyze: Boolean(state.mapping),
      bind: Boolean(state.template),
      run: Boolean(state.run),
    };
    const pending = {
      load: false,
      analyze: !state.ref,
      bind: !state.mapping,
      run: !state.template,
    };
    for (const [key] of STEPS) {
      const step = key === 'load' ? loadStep : key === 'analyze' ? analyzeStep : key === 'bind' ? bindStep : runStep;
      step.section.classList.toggle('is-done', done[key]);
      step.section.classList.toggle('is-pending', pending[key]);
      step.section.classList.toggle('is-active', !done[key] && !pending[key]);
      step.state.textContent = done[key] ? 'Done' : pending[key] ? 'Waiting' : 'Current';
    }

    loadResult.replaceChildren(state.ref
      ? kv([
        ['Skill Name', hashLink(state.ref, `#skills/${encoded(state.ref)}`)],
        ['Fingerprint', h('span', { className: 'mono truncate', textContent: state.skill?.hash || '—' })],
        ['Source', h('span', { className: 'truncate', textContent: state.skill?.source || '—' })],
      ])
      : h('span', { className: 'step-hint', textContent: 'No Skill loaded yet.' }));
    pathInput.disabled = Boolean(state.ref) || state.busy === 'load';
    loadButton.disabled = Boolean(state.ref) || state.busy === 'load';

    paintAnalyze();

    urlInput.disabled = !state.mapping || Boolean(state.template) || state.busy === 'bind';
    bindButton.disabled = !state.mapping || Boolean(state.template) || state.busy === 'bind';
    fill(bindResult, state.template
      ? kv([
        ['Template', hashLink(state.template.name || state.template.template_id, `#templates/${encoded(state.template.template_id)}`)],
        ['Template ID', h('span', { className: 'mono', textContent: state.template.template_id || '—' })],
        ['Lark Base URL', larkBaseLink(state.template.target)],
        ['Created', formatDate(state.template.created_at)],
      ])
      : null);

    runButton.disabled = !state.template;

  }

  paint();
  return fragment(
    h('div', { className: 'view-head' }, viewTitle('Home')),
    h('div', { className: 'flow' }, STEPS.map(([key]) => ({
      load: loadStep, analyze: analyzeStep, bind: bindStep, run: runStep,
    }[key]).section)),
  );
}

export { homeView };
