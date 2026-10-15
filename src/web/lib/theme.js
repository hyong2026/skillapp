/**
 * theme.js — 主题（Dark / Light）
 *
 * 每浏览器的 UI 偏好，存 localStorage，不进服务端配置。
 * 默认 Dark：CSS 的 :root 本身就是深色值，light 只是覆盖同名变量。
 * 首屏由 theme-boot.js 先落 data-theme，避免浅色偏好闪一下深色；
 * 这里负责后续切换、持久化，以及同步 color-scheme / theme-color。
 */

const STORAGE_KEY = 'skillapp.theme';
const THEMES = ['dark', 'light'];
const DEFAULT_THEME = 'dark';
const THEME_COLOR = { dark: '#0b1220', light: '#f8fafc' };
// 标签页图标也跟着主题走：深色版是现在这份 logo，浅色版换成浅底那张。
const THEME_ICON = { dark: '/logo.svg', light: '/logo-light.svg' };

function getTheme() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return THEMES.includes(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function applyTheme(theme) {
  const next = THEMES.includes(theme) ? theme : DEFAULT_THEME;
  const root = document.documentElement;
  root.dataset.theme = next;
  root.style.colorScheme = next;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[next]);
  const icon = document.querySelector('link[rel="icon"]');
  if (icon) icon.setAttribute('href', THEME_ICON[next]);
  return next;
}

function setTheme(theme) {
  const next = applyTheme(theme);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // 隐私模式等写不了就只改当前会话，不报错。
  }
  return next;
}

function initTheme() {
  return applyTheme(getTheme());
}

export {
  getTheme,
  setTheme,
  initTheme,
  THEMES,
};
