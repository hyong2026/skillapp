import { injectNavIcons, render } from './lib/router.js';
import { initNavMenu } from './lib/shell.js';
import { initSidebar } from './lib/sidebar.js';
import { initMessages } from './lib/messages.js';
import { initScrollChain } from './lib/scroll-chain.js';
import { initTheme } from './lib/theme.js';

window.addEventListener('hashchange', render);
// Safety net: drop the dragging state even if the source element is replaced.
window.addEventListener('pointerup', () => document.body.classList.remove('is-dragging-rows'));
window.addEventListener('pointercancel', () => document.body.classList.remove('is-dragging-rows'));
// 首屏遮罩：等路由把第一屏（或失败提示）摆好就淡出移除。兜底超时是防"init 里抛异常
// 导致永远没人发信号"，那种情况下遮罩会把人挡在外面。
const boot = document.getElementById('boot');
if (boot) {
  const drop = () => {
    if (!boot.isConnected || boot.classList.contains('is-done')) return;
    boot.classList.add('is-done');
    setTimeout(() => boot.remove(), 240);
  };
  document.addEventListener('viewready', drop, { once: true });
  setTimeout(drop, 10000);
}

initTheme();
injectNavIcons();
initNavMenu();
initSidebar();
initMessages();
initScrollChain();
// 没有锚点时补一个默认路由，URL 始终带 #xxx，保持统一。
if (!location.hash) location.hash = 'home';
else render();
