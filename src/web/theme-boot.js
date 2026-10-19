/**
 * theme-boot.js — 首屏防闪（在样式表之前同步执行）
 *
 * 服务端的 CSP 是 `script-src 'self'`，内联脚本会被挡掉，所以单独放一个文件。
 * 读 localStorage 把主题落到 <html data-theme>（默认 dark）、把侧栏折叠状态落到
 * <html data-sidebar>（默认 expanded）；运行时的切换在 lib/theme.js 与 lib/sidebar.js。
 */
(function () {
  // 存到什么就写什么：未知取值没有对应的 CSS 变量组，自然落回默认的深色。
  var theme = 'dark';
  var sidebar = 'expanded';
  try {
    theme = localStorage.getItem('skillapp.theme') || 'dark';
    sidebar = localStorage.getItem('skillapp.sidebar') === 'collapsed' ? 'collapsed' : 'expanded';
  } catch (e) {}
  var root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.sidebar = sidebar;
  root.style.colorScheme = theme === 'light' ? 'light' : 'dark';
})();
