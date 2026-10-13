import { api } from '../lib/api.js';
import { empty, kv, panel, viewTitle } from '../lib/components.js';
import { fragment, h } from '../lib/dom.js';

async function settingsView() {
  const settings = await api('/api/settings');
  const runtime = settings.runtime || {};
  return fragment(
    h('div', { className: 'view-head' }, [
      viewTitle('Settings'),
    ]),
    panel('Runtime', h('div', { className: 'panel-body' }, kv([
      ['App URL', h('span', { className: 'mono', textContent: location.origin })],
      ['Repo Root', h('span', { className: 'mono truncate', textContent: runtime.repo_root || '—' })],
      ['Node Version', h('span', { className: 'mono', textContent: runtime.node || '—' })],
    ]))),
    panel('Configuration', h('div', { className: 'panel-body' }, empty('No settings yet — more will land here.'))),
  );
}

export { settingsView };
