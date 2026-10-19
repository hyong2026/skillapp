/** 最小 DOM 工具箱：只负责把结构拼成真实节点。 */

function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'className') el.className = value;
    else if (key === 'textContent') el.textContent = value;
    else if (key === 'onClick') el.addEventListener('click', value);
    else if (key === 'onChange') el.addEventListener('change', value);
    else if (key === 'value') el.value = value;
    else if (key === 'checked') el.checked = value;
    else if (key === 'disabled') el.disabled = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function fragment(...children) {
  const el = document.createDocumentFragment();
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const ICON_PATHS = {
  load: ['M12 3v12', 'm7 8 5-5 5 5', 'M5 21h14'],
  analyze: ['M12 3l1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7L12 3z', 'M5 15l.8 2.2L8 18l-2.2.8L5 21l-.8-2.2L2 18l2.2-.8L5 15z'],
  mapping: ['M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1.1', 'M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1.1'],
  unload: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6', 'M10 11v5', 'M14 11v5'],
  run: ['M8 5v14l11-7z'],
  cancel: ['M18 6 6 18', 'M6 6l12 12'],
  retry: ['M21 12a9 9 0 1 1-2.64-6.36', 'M21 3v6h-6'],
  download: ['M12 3v12', 'm7 10 5 5 5-5', 'M5 21h14'],
  code: ['m8 9-4 3 4 3', 'M16 9l4 3-4 3', 'M14 5l-4 14'],
  drag: ['M9 5h.01', 'M9 12h.01', 'M9 19h.01', 'M15 5h.01', 'M15 12h.01', 'M15 19h.01'],
  check: ['m5 12 4 4L19 6'],
  close: ['M18 6 6 18', 'M6 6l12 12'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  info: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'M12 16v-5', 'M12 8h.01'],
  prev: ['m15 18-6-6 6-6'],
  next: ['m9 6 6 6-6 6'],
  chevron: ['m6 9 6 6 6-6'],
  spinner: ['M12 3a9 9 0 1 0 9 9'],
  home: ['M3 10.6 12 3.5l9 7.1', 'M5.5 9.5V20h13V9.5', 'M10 20v-5h4v5'],
  skills: [
    'M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z',
    'M12 22V12',
    'm3.3 7 8.7 5 8.7-5',
    'm7.5 4.27 9 5.15',
  ],
  templates: [
    'M4 3h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z',
    'M4 14h7a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Z',
    'M17 14h3a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Z',
  ],
  runs: ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5', 'M12 7v5l4 2'],
  operations: ['M22 12h-4l-3 9L9 3l-3 9H2'],
  messages: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  collapse: ['M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M9 3v18', 'm16 15-3-3 3-3'],
  expand: ['M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M9 3v18', 'm14 9 3 3-3 3'],
  settings: ['M20 7h-9', 'M14 17H5', 'M17 20a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M7 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'],
};

function icon(name, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);
  for (const d of ICON_PATHS[name] || []) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function actionButton(label, iconName, className = 'button') {
  return h('button', { className, type: 'button' }, [
    icon(iconName),
    h('span', { textContent: label }),
  ]);
}

// Dialogs stay icon-free: text-only buttons, no decorative header icon.
function textButton(label, className = 'button') {
  return h('button', { className, type: 'button' }, h('span', { textContent: label }));
}

function setNotice(message = '', isError = false) {
  const notice = document.getElementById('notice');
  if (!notice) return;
  notice.textContent = message;
  notice.className = `notice${message ? ' visible' : ''}${isError ? ' error' : ''}`;
}

export { h, fragment, ICON_PATHS, icon, actionButton, textButton, setNotice };
