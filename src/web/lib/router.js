import { stopRunStream } from './api.js';
import { head } from './components.js';
import { actionButton, h, ICON_PATHS, icon, setNotice } from './dom.js';
import { closeNavMenu, renderViewContent, scrollContainer, viewHeadSlot } from './shell.js';
import { operationView, operationsView } from '../views/operations.js';
import { runItemView } from '../views/run-item.js';
import { runsView, runView } from '../views/runs.js';
import { settingsView } from '../views/settings.js';
import { skillsView, skillView } from '../views/skills.js';
import { templatesView, templateView } from '../views/templates.js';

const app = document.getElementById('app');
let renderSequence = 0;

/** Hash 路由表：每个主菜单一个 list，详情页按需带 detail / item。 */
const VIEWS = {
  skills: { list: skillsView, detail: skillView },
  templates: { list: templatesView, detail: templateView },
  runs: { list: runsView, detail: runView, item: runItemView },
  operations: { list: operationsView, detail: operationView },
  settings: { list: settingsView },
};

function viewFor(route, parts) {
  const views = VIEWS[route];
  if (!views) return null;
  if (route === 'runs' && parts[1] && parts[2]) return () => views.item(parts[1], parts[2]);
  if (parts[1] && views.detail) return () => views.detail(parts[1]);
  return () => views.list();
}

function loadingView() {
  return h('div', { className: 'skeleton-page', 'aria-hidden': 'true' }, [
    h('div', { className: 'skeleton skeleton-title' }),
    h('div', { className: 'skeleton skeleton-subtitle' }),
    h('div', { className: 'skeleton skeleton-panel' }),
  ]);
}

function errorView(error) {
  const retry = actionButton('Retry', 'retry', 'button primary');
  retry.addEventListener('click', render);
  return h('div', { className: 'error-box' }, [
    h('strong', { textContent: 'Failed to load' }),
    h('p', { textContent: error.message }),
    h('div', { className: 'error-actions' }, retry),
  ]);
}

function setActive(route) {
  for (const link of document.querySelectorAll('[data-route]')) {
    const active = link.dataset.route === route;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function injectNavIcons() {
  for (const link of document.querySelectorAll('.nav a[data-route]')) {
    const name = ICON_PATHS[link.dataset.route] ? link.dataset.route : null;
    if (!name || link.querySelector('.icon')) continue;
    link.prepend(icon(name, 'icon nav-icon'));
  }
}

async function render({ preserveScroll = false } = {}) {
  stopRunStream();
  const sequence = ++renderSequence;
  const currentScroller = scrollContainer();
  const previousScroll = preserveScroll && currentScroller ? currentScroller.scrollTop : null;
  const rawHash = (location.hash || '#skills').slice(1);
  let parts;
  try {
    parts = rawHash.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    parts = ['skills'];
  }
  const route = parts[0] === 'home' || parts[0] === 'status' || !parts[0] ? 'skills' : parts[0];
  closeNavMenu();
  setActive(route);
  setNotice('');
  viewHeadSlot().replaceChildren();
  app.setAttribute('aria-busy', 'true');
  if (!preserveScroll) app.replaceChildren(h('div', { className: 'view-body-inner' }, loadingView()));

  try {
    const load = viewFor(route, parts);
    const content = load ? await load() : head('Not found', 'Select a page from the navigation.');
    if (sequence !== renderSequence) return;
    app.removeAttribute('aria-busy');
    // The run view renders itself (it repaints on stream events) and returns null.
    if (content) renderViewContent(content);
  } catch (error) {
    if (sequence !== renderSequence) return;
    app.removeAttribute('aria-busy');
    // 页面级失败就直接页面里报（error-box 带 Retry），不再额外弹一条同文案的 toast。
    app.replaceChildren(h('div', { className: 'view-body-inner' }, errorView(error)));
  } finally {
    if (previousScroll !== null && sequence === renderSequence) {
      const nextScroller = scrollContainer();
      if (nextScroller) nextScroller.scrollTop = previousScroll;
    }
  }
}

export { render, injectNavIcons };
