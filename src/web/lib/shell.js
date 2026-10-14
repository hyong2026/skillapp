import { h, icon } from './dom.js';

// The shell never scrolls; `.page-body` is the only scroll container, and the
// view head lives outside it so it can never move.
function scrollContainer() {
  return document.querySelector('.page-body');
}

function viewHeadSlot() {
  return document.getElementById('viewHead');
}

// Views return [view-head, ...panels]; the head is pinned above the scroller.
function splitViewHead(content) {
  const nodes = [...content.childNodes];
  const index = nodes.findIndex((node) => node.nodeType === 1 && node.classList.contains('view-head'));
  if (index < 0) return { head: null, nodes };
  return { head: nodes[index], nodes: nodes.filter((_, i) => i !== index) };
}

function renderViewContent(content) {
  const { head, nodes } = splitViewHead(content);
  if (head) viewHeadSlot().replaceChildren(head);
  document.getElementById('app').replaceChildren(h('div', { className: 'view-body-inner' }, nodes));
}

/**
 * Narrow screens keep the menu in the header as a floating card. It is positioned
 * absolutely, so opening it never moves the header, the page or the content.
 */
function closeNavMenu() {
  const nav = document.getElementById('mainNav');
  if (!nav?.classList.contains('open')) return;
  nav.classList.remove('open');
  document.querySelector('.nav-toggle')?.setAttribute('aria-expanded', 'false');
}

function initNavMenu() {
  const topbar = document.querySelector('.topbar');
  const nav = document.getElementById('mainNav');
  if (!topbar || !nav) return;
  const toggle = h('button', {
    className: 'nav-toggle',
    type: 'button',
    'aria-controls': 'mainNav',
    'aria-expanded': 'false',
    'aria-label': 'Menu',
  }, [icon('menu', 'icon nav-toggle-open'), icon('close', 'icon nav-toggle-close')]);
  toggle.addEventListener('click', () => {
    const open = !nav.classList.contains('open');
    nav.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
  });
  nav.addEventListener('click', (event) => {
    if (event.target.closest('a')) closeNavMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeNavMenu();
  });
  document.addEventListener('click', (event) => {
    if (!topbar.contains(event.target)) closeNavMenu();
  });
  topbar.append(toggle);
}

export { scrollContainer, viewHeadSlot, splitViewHead, renderViewContent, initNavMenu, closeNavMenu };
