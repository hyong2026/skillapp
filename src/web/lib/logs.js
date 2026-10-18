/**
 * logs.js — Live Logs 的滚动跟随
 *
 * 日志块每次更新都是整段重画（节点重建、滚动位置回到顶部）。所以在重画前后各调一次：
 * 之前记录"哪一块本来就贴着底部"，之后贴底的继续跟到底，其余回到原来的位置 ——
 * 用户往上翻看历史时，新输出不会把他拽回底部。
 */
const BOTTOM_SLACK = 4;

/** 日志块的稳定标识：`<h3>` 里的标题（例如 `rec1 · stderr`）。 */
function logLabel(pre) {
  return pre.closest('.live-log')?.querySelector('h3')?.textContent || '';
}

/** 重画前快照：每块是否贴底 + 当前滚动位置。 */
function captureLogView() {
  const view = new Map();
  for (const pre of document.querySelectorAll('.live-log pre')) {
    view.set(logLabel(pre), {
      atBottom: pre.scrollHeight - pre.scrollTop - pre.clientHeight <= BOTTOM_SLACK,
      scrollTop: pre.scrollTop,
    });
  }
  return view;
}

/** 重画后还原：贴底的滚到底，其余回到原处；新出现的块（没有快照）也滚到底。 */
function restoreLogView(view) {
  for (const pre of document.querySelectorAll('.live-log pre')) {
    const previous = view.get(logLabel(pre));
    pre.scrollTop = !previous || previous.atBottom ? pre.scrollHeight : previous.scrollTop;
  }
}

export { captureLogView, restoreLogView };
