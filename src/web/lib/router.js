import { stopRunStream } from './api.js';
import { resetPagedState } from './components.js';
import { openAlertDialog } from './dialogs.js';
import { h, ICON_PATHS, icon, setNotice } from './dom.js';
import { closeNavMenu, renderViewContent, viewHeadSlot } from './shell.js';
import { homeView } from '../views/home.js';
import { operationView, operationsView } from '../views/operations.js';
import { runItemView } from '../views/run-item.js';
import { runsView, runView } from '../views/runs.js';
import { settingsView } from '../views/settings.js';
import { skillsView, skillView } from '../views/skills.js';
import { templatesView, templateView } from '../views/templates.js';

const app = document.getElementById('app');
let renderSequence = 0;
let currentModule = null;

/** Hash 路由表：每个主菜单一个 list，详情页按需带 detail / item。 */
const VIEWS = {
  home: { list: homeView },
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

/** 详情路由的上一级：`#runs/<id>/<record>` → `#runs/<id>`，列表路由回 Home。 */
function parentHash(parts) {
  return parts.length > 1 ? parts.slice(0, -1).map(encodeURIComponent).join('/') : 'home';
}

/**
 * 页面级失败（未知路由 / 详情读不出来）：先把顶部清空（别留着上一页的标题和按钮），
 * 再用弹框说清楚，关掉后回到上一级。不再给 Retry —— 东西真没了的时候重试没有意义。
 */
/** 首屏遮罩收尾的信号：这一屏（或失败提示）已经摆好了，可以把它收掉。 */
function viewReady() {
  document.dispatchEvent(new CustomEvent('viewready'));
}

async function failRoute({ title, message, parent = 'home' }) {
  viewReady();
  viewHeadSlot().replaceChildren();
  app.replaceChildren(h('div', { className: 'view-body-inner' }));
  const openedAt = location.hash;
  await openAlertDialog({ title, message });
  // 弹框开着的时候如果用户自己跳走了，就别再抢方向。
  if (location.hash === openedAt) location.hash = parent;
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

async function render() {
  stopRunStream();
  const sequence = ++renderSequence;
  const rawHash = (location.hash || '').slice(1);
  let parts;
  try {
    parts = rawHash.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    parts = [];
  }
  // 无锚点就是 Home（`#home` 与旧的 `#status` 也落到它）。
  const route = !parts[0] || parts[0] === 'status' ? 'home' : parts[0];
  // 翻页状态只在模块内有效：换模块就清空（模块内列表与详情之间保留），回来从第 1 页开始。
  if (route !== currentModule) {
    resetPagedState();
    currentModule = route;
  }
  closeNavMenu();
  setActive(route);
  setNotice('');
  // 加载期间保留上一屏：不画骨架屏，新内容就绪后一次性替换（避免闪一下空白）。
  app.setAttribute('aria-busy', 'true');

  try {
    const load = viewFor(route, parts);
    if (!load) {
      await failRoute({ title: 'Page not found', message: 'Select a page from the navigation.' });
      return;
    }
    const content = await load();
    if (sequence !== renderSequence) return;
    app.removeAttribute('aria-busy');
    // The run view renders itself (it repaints on stream events) and returns null.
    if (content) renderViewContent(content);
    viewReady();
  } catch (error) {
    if (sequence !== renderSequence) return;
    app.removeAttribute('aria-busy');
    await failRoute({ title: 'Failed to load', message: error.message, parent: parentHash(parts) });
  }
}

export { render, injectNavIcons };
