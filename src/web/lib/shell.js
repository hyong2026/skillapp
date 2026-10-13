import { h } from './dom.js';

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

export { scrollContainer, viewHeadSlot, splitViewHead, renderViewContent };
