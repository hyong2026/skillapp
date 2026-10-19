/**
 * sidebar.js — 左侧栏折叠
 *
 * 折叠后侧栏只留一列图标（悬停出 tooltip），顶部 logo 悬停原地换成展开按钮，
 * 底部是常驻的 Messages 图标（浮层见 messages.js）。
 * 状态只存本浏览器（`skillapp.sidebar`）；首屏由 theme-boot.js 先落到
 * `<html data-sidebar>`，免得先宽后窄地闪一下。窄屏（≤720px）是顶栏 + ☰ 那套，这里不掺和。
 */

import { h, icon } from './dom.js';

const KEY = 'skillapp.sidebar';
const NARROW = '(max-width: 720px)';

const isCollapsed = () => document.documentElement.dataset.sidebar === 'collapsed';

function setCollapsed(collapsed) {
  if (collapsed === isCollapsed()) return;
  document.documentElement.dataset.sidebar = collapsed ? 'collapsed' : 'expanded';
  try {
    localStorage.setItem(KEY, collapsed ? 'collapsed' : 'expanded');
  } catch {
    // 隐私模式下写不了就算了，本次访问仍然生效。
  }
  // 折叠态的 Messages 是浮层，展开时要收起来（messages.js 听这个事件）。
  document.dispatchEvent(new CustomEvent('sidebarchange', { detail: { collapsed } }));
}

function isTyping(target) {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
    || target.tagName === 'SELECT' || target.isContentEditable;
}

/**
 * 导航项的文字包一层 span（折叠态要整块藏掉，CSS 藏不了裸文本节点），
 * 顺手把全名留给 tooltip —— 折叠态只剩图标，全名就靠它。
 */
function labelNav() {
  for (const link of document.querySelectorAll('.nav a')) {
    if (link.querySelector('.nav-label')) continue;
    const label = link.textContent.trim();
    for (const node of [...link.childNodes]) if (node.nodeType === Node.TEXT_NODE) node.remove();
    link.append(h('span', { className: 'nav-label', textContent: label }));
    link.dataset.tip = label;
  }
}

function initSidebar() {
  const topbar = document.querySelector('.topbar');
  const brand = topbar?.querySelector('.brand');
  if (!topbar || !brand) return;

  labelNav();

  const toggle = h('button', {
    className: 'sidebar-toggle',
    type: 'button',
    'data-tip': 'Collapse',
    'aria-label': 'Collapse sidebar',
  }, icon('collapse', 'icon'));
  toggle.addEventListener('click', () => setCollapsed(!isCollapsed()));
  brand.append(toggle);

  const paintToggle = () => {
    const collapsed = isCollapsed();
    toggle.replaceChildren(icon(collapsed ? 'expand' : 'collapse', 'icon'));
    toggle.dataset.tip = collapsed ? 'Expand' : 'Collapse';
    toggle.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  };
  paintToggle();
  document.addEventListener('sidebarchange', paintToggle);

  // ← 折叠、→ 展开。输入框里、弹框里、窄屏下都不抢键；真要动状态才吞掉这次按键。
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (window.matchMedia(NARROW).matches) return;
    if (document.querySelector('dialog[open]')) return;
    if (isTyping(event.target)) return;
    if (event.key === 'ArrowLeft' && !isCollapsed()) setCollapsed(true);
    else if (event.key === 'ArrowRight' && isCollapsed()) setCollapsed(false);
    else return;
    event.preventDefault();
  });
}

export { initSidebar };
