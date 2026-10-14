import { injectNavIcons, render } from './lib/router.js';
import { initNavMenu } from './lib/shell.js';
import { initMessages } from './lib/messages.js';

window.addEventListener('hashchange', render);
// Safety net: drop the dragging state even if the source element is replaced.
window.addEventListener('pointerup', () => document.body.classList.remove('is-dragging-rows'));
window.addEventListener('pointercancel', () => document.body.classList.remove('is-dragging-rows'));
injectNavIcons();
initNavMenu();
initMessages();
if (!location.hash) location.hash = 'skills';
else render();
