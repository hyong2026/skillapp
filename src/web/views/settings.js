import { api } from '../lib/api.js';
import { kv, panel, viewTitle } from '../lib/components.js';
import { fragment, h } from '../lib/dom.js';
import { getTheme, setTheme, THEMES } from '../lib/theme.js';

const THEME_LABELS = { dark: 'Dark', light: 'Light' };

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

async function settingsView() {
  const settings = await api('/api/settings');
  const runtime = settings.runtime || {};
  return fragment(
    h('div', { className: 'view-head' }, [
      viewTitle('Settings'),
    ]),
    appearancePanel(),
    panel('Runtime', h('div', { className: 'panel-body' }, kv([
      ['App URL', h('span', { className: 'mono', textContent: location.origin })],
      ['Repo Root', h('span', { className: 'mono truncate', textContent: runtime.repo_root || '—' })],
      ['Node Version', h('span', { className: 'mono', textContent: runtime.node || '—' })],
    ]))),
  );
}

export { settingsView };
