import { injectNavIcons, render } from './lib/router.js';
import { initNavMenu } from './lib/shell.js';
import { initMessages } from './lib/messages.js';
import { initTheme } from './lib/theme.js';

window.addEventListener('hashchange', render);
// Safety net: drop the dragging state even if the source element is replaced.
window.addEventListener('pointerup', () => document.body.classList.remove('is-dragging-rows'));
window.addEventListener('pointercancel', () => document.body.classList.remove('is-dragging-rows'));
initTheme();
injectNavIcons();
initNavMenu();
initMessages();
// 没有锚点时补一个默认路由，URL 始终带 #xxx，保持统一。
if (!location.hash) location.hash = 'home';
else render();
