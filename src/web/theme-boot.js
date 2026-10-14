/**
 * theme-boot.js — 首屏防闪（在样式表之前同步执行）
 *
 * 服务端的 CSP 是 `script-src 'self'`，内联脚本会被挡掉，所以单独放一个文件。
 * 读 localStorage 把主题落到 <html data-theme>，默认 dark；运行时的切换在 lib/theme.js。
 */
(function () {
  // 存到什么就写什么：未知取值没有对应的 CSS 变量组，自然落回默认的深色。
  var theme = 'dark';
  try {
    theme = localStorage.getItem('skillapp.theme') || 'dark';
  } catch (e) {}
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === 'light' ? 'light' : 'dark';
})();
