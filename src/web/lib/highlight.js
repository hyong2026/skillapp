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

/** 取「好看的 JSON 文本」；传进来的字符串不是 JSON 时返回 null（调用方决定怎么兜底）。 */
function jsonText(value) {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return null;
    }
  }
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return null;
  }
}

/** 按 JSON 词法给任意文本上色——不需要每行都是合法 JSON（逐行高亮要用它）。 */
function highlightText(text) {
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

export { escapeHtml, highlightText, jsonText };
