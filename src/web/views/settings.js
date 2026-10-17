import { api } from '../lib/api.js';
import { kv, panel, viewTitle } from '../lib/components.js';
import { fragment, h, setNotice } from '../lib/dom.js';
import { getTheme, setTheme, THEMES } from '../lib/theme.js';

const THEME_LABELS = { dark: 'Dark', light: 'Light' };
const PAGE_SIZE_KEY = 'SKILLAPP_PAGE_SIZE';
const PAGE_SIZE_DEFAULT = 10;
const PAGE_SIZE_MAX = 200;

/** Dark / Light 分段控件：点一下即时生效、存 localStorage，不重载页面。 */
function themeControl() {
  const group = h('div', { className: 'segmented', role: 'radiogroup', 'aria-label': 'Theme' });
  for (const value of THEMES) {
    const option = h('button', {
      className: 'segmented-option',
      type: 'button',
      role: 'radio',
      'aria-checked': String(getTheme() === value),
      textContent: THEME_LABELS[value],
      onClick: () => {
        setTheme(value);
        for (const other of group.children) {
          other.setAttribute('aria-checked', String(other.dataset.theme === value));
        }
      },
    });
    option.dataset.theme = value;
    group.append(option);
  }
  return group;
}

function appearancePanel() {
  return panel('Appearance', h('div', { className: 'panel-body' }, [
    h('div', { className: 'setting-row' }, [
      h('div', { className: 'setting-label' }, [
        h('span', { className: 'setting-name', textContent: 'Theme' }),
        h('span', { className: 'setting-hint', textContent: 'Applies to this browser only.' }),
      ]),
      themeControl(),
    ]),
  ]));
}

/**
 * 每页条数：写进 `.env`（服务端每次请求读一次），列表下次取页就生效。
 * 移开焦点（或回车）就保存，值没变不发请求；保存成功不弹提示（跟 Mapping 的实时保存一致），
 * 失败或填了非法值就退回上一次的值。
 */
function paginationPanel(settings) {
  let saved = settings.editable.find((entry) => entry.key === PAGE_SIZE_KEY)?.value || String(PAGE_SIZE_DEFAULT);
  const input = h('input', {
    className: 'setting-input',
    type: 'number',
    min: '1',
    max: String(PAGE_SIZE_MAX),
    step: '1',
    value: saved,
    'aria-label': 'Page Size',
  });

  const readValue = () => {
    const value = Number.parseInt(input.value, 10);
    return Number.isFinite(value) && value >= 1 ? Math.min(value, PAGE_SIZE_MAX) : null;
  };
  const commit = async () => {
    const value = readValue();
    if (value === null || String(value) === saved) {
      input.value = saved;
      return;
    }
    try {
      await api('/api/settings', { method: 'PUT', body: { values: { [PAGE_SIZE_KEY]: String(value) } } });
      saved = String(value);
      input.value = saved;
    } catch (error) {
      setNotice(error.message, true);
      input.value = saved;
    }
  };
  input.addEventListener('blur', () => { void commit(); });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.blur();
  });

  return panel('Pagination', h('div', { className: 'panel-body' }, h('div', { className: 'setting-row' }, [
    h('div', { className: 'setting-label' }, [
      h('span', { className: 'setting-name', textContent: 'Page Size' }),
      h('span', { className: 'setting-hint', textContent: 'Rows per page in every list (1–200). Saved to .env when you leave the field.' }),
    ]),
    h('div', { className: 'setting-control' }, input),
  ])));
}

async function settingsView() {
  const settings = await api('/api/settings');
  const runtime = settings.runtime || {};
  return fragment(
    h('div', { className: 'view-head' }, [
      viewTitle('Settings'),
    ]),
    appearancePanel(),
    paginationPanel(settings),
    panel('Runtime', h('div', { className: 'panel-body' }, kv([
      ['App URL', h('span', { className: 'mono', textContent: location.origin })],
      ['Repo Root', h('span', { className: 'mono truncate', textContent: runtime.repo_root || '—' })],
      ['Node Version', h('span', { className: 'mono', textContent: runtime.node || '—' })],
    ]))),
  );
}

export { settingsView };
