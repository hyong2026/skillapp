/**
 * logs.js — 日志面板的滚动跟随
 *
 * 面板每次更新都整段重画（节点重建、滚动位置归零），所以重画前后各调一次：重画前记下"本来就贴着底部"，
 * 重画后贴底的继续跟到底、其余回到原处 —— 往上翻看历史时不会被拽回底部。
 * root 就是这次重画的那一个面板（日志一行一个，只有 Live 会重画，别去数整个文档）。
 */
const BOTTOM_SLACK = 4;

/** 重画前快照：这块日志是否贴底 + 当前滚动位置。 */
function captureLogView(root) {
  const view = [];
  for (const pre of root.querySelectorAll('pre')) {
    view.push({
      atBottom: pre.scrollHeight - pre.scrollTop - pre.clientHeight <= BOTTOM_SLACK,
      scrollTop: pre.scrollTop,
    });
  }
  return view;
}

/** 重画后还原：贴底的滚到底，其余回到原处；新出现的块（没有快照）也滚到底。 */
function restoreLogView(view, root) {
  [...root.querySelectorAll('pre')].forEach((pre, index) => {
    const previous = view[index];
    pre.scrollTop = !previous || previous.atBottom ? pre.scrollHeight : previous.scrollTop;
  });
}

export { captureLogView, restoreLogView };
