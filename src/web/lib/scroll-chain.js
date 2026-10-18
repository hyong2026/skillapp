/**
 * scroll-chain.js — 代码块滚到头之后，把剩下的滚动交给页面
 *
 * 代码块是滚动容器，样式给它上了 `overscroll-behavior: none`（macOS 内层滚动容器滚到头会回弹），
 * 副作用是**滚轮在代码块上被整个吃掉**——连"根本没有滚动条"的代码块也一样。这里接住那口气：
 * 没得滚 / 已到边界（顶、底）→ 转给页面；中间状态 → 不插手，让它自己滚。
 */
const PAGE_SCROLLER = () => document.querySelector('.page-body') || document.scrollingElement;

/** 滚轮的单位可能是像素 / 行 / 页，换算成像素再交给页面。 */
function deltaPixels(event) {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * window.innerHeight;
  return event.deltaY;
}

function initScrollChain() {
  document.addEventListener('wheel', (event) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || !event.deltaY) return;
    const target = event.target instanceof Element ? event.target : null;
    const block = target?.closest('pre');
    if (!block) return;

    const max = block.scrollHeight - block.clientHeight;
    if (max > 1) {
      const atTop = block.scrollTop <= 0;
      const atBottom = block.scrollTop >= max - 1;
      if (!(event.deltaY < 0 ? atTop : atBottom)) return; // 还没到边界：它自己滚
    }

    event.preventDefault();
    PAGE_SCROLLER()?.scrollBy(event.deltaX || 0, deltaPixels(event));
  }, { passive: false });
}

export { initScrollChain };
