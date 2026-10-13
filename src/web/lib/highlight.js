/** JSON 语法高亮。输出的是 innerHTML 片段，因此每一段内容都先转义。 */

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

function highlightJson(value) {
  let text;
  if (typeof value === 'string') {
    try {
      text = JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return `<span class="json-raw">${escapeHtml(value)}</span>`;
    }
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value ?? '');
    }
  }
  if (text === undefined) text = '';

  const pattern = /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let html = '';
  let last = 0;

  for (const match of text.matchAll(pattern)) {
    html += escapeHtml(text.slice(last, match.index));
    const token = match[0];
    const className = match[1] ? 'json-key' : match[2] ? 'json-string' : match[3] ? 'json-literal' : 'json-number';
    html += `<span class="${className}">${escapeHtml(token)}</span>`;
    last = match.index + token.length;
  }

  return html + escapeHtml(text.slice(last));
}

export { escapeHtml, highlightJson };
