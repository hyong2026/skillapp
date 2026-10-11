'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SkillAppMarkdown = api;
})(typeof window !== 'undefined' ? window : globalThis, function createRenderer() {
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

  function safeUrl(value) {
    const url = String(value || '').trim();
    if (/^(https?:\/\/|mailto:|\/|#)/i.test(url)) return url;
    return '#';
  }

  function renderInline(value) {
    const source = String(value ?? '');
    const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)|(\[[^\]]+\]\([^)]+\))/g;
    let html = '';
    let last = 0;

    for (const match of source.matchAll(pattern)) {
      html += escapeHtml(source.slice(last, match.index));
      const token = match[0];
      if (token.startsWith('`')) {
        html += `<code>${escapeHtml(token.slice(1, -1))}</code>`;
      } else if (token.startsWith('**')) {
        html += `<strong>${escapeHtml(token.slice(2, -2))}</strong>`;
      } else if (token.startsWith('__')) {
        html += `<strong>${escapeHtml(token.slice(2, -2))}</strong>`;
      } else if (token.startsWith('*')) {
        html += `<em>${escapeHtml(token.slice(1, -1))}</em>`;
      } else if (token.startsWith('_')) {
        html += `<em>${escapeHtml(token.slice(1, -1))}</em>`;
      } else {
        const link = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/.exec(token);
        if (!link) {
          html += escapeHtml(token);
        } else {
          const href = safeUrl(link[2]);
          const external = /^https?:/i.test(href);
          html += `<a href="${escapeHtml(href)}"${external ? ' target="_blank" rel="noreferrer"' : ''}>${renderInline(link[1])}</a>`;
        }
      }
      last = match.index + token.length;
    }

    return html + escapeHtml(source.slice(last));
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

  function splitTableRow(line) {
    let value = String(line).trim();
    if (value.startsWith('|')) value = value.slice(1);
    if (value.endsWith('|')) value = value.slice(0, -1);
    return value.split('|').map((cell) => cell.trim());
  }

  function isTableSeparator(line) {
    const cells = splitTableRow(line);
    return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  }

  function isTableStart(lines, index) {
    return index + 1 < lines.length
      && String(lines[index]).includes('|')
      && isTableSeparator(lines[index + 1]);
  }

  function isBlockStart(lines, index) {
    const line = String(lines[index] ?? '');
    return /^\s*$/.test(line)
      || /^#{1,6}\s+/.test(line)
      || /^```/.test(line)
      || /^\s*>\s?/.test(line)
      || /^\s*[-*+]\s+/.test(line)
      || /^\s*\d+[.)]\s+/.test(line)
      || /^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)
      || isTableStart(lines, index);
  }

  function renderList(lines, start, ordered) {
    const tag = ordered ? 'ol' : 'ul';
    const pattern = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
    const items = [];
    let index = start;

    while (index < lines.length) {
      const match = pattern.exec(lines[index]);
      if (!match) break;
      items.push(`<li>${renderInline(match[1])}</li>`);
      index += 1;
    }

    return { html: `<${tag}>${items.join('')}</${tag}>`, next: index };
  }

  function renderTable(lines, start) {
    if (!isTableStart(lines, start)) return null;
    const headers = splitTableRow(lines[start]);
    const rows = [];
    let index = start + 2;

    while (index < lines.length && !/^\s*$/.test(lines[index]) && String(lines[index]).includes('|')) {
      rows.push(splitTableRow(lines[index]));
      index += 1;
    }

    const head = `<thead><tr>${headers.map((cell) => `<th scope="col">${renderInline(cell)}</th>`).join('')}</tr></thead>`;
    const body = rows.length
      ? `<tbody>${rows.map((row) => `<tr>${headers.map((_, i) => `<td>${renderInline(row[i] || '')}</td>`).join('')}</tr>`).join('')}</tbody>`
      : '';
    return {
      html: `<div class="table-wrap markdown-table"><table>${head}${body}</table></div>`,
      next: index,
    };
  }

  function renderMarkdown(value) {
    const source = String(value ?? '').replace(/\r\n?/g, '\n');
    const lines = source.split('\n');
    const blocks = [];
    let index = 0;

    while (index < lines.length) {
      const line = lines[index];

      if (/^\s*$/.test(line)) {
        index += 1;
        continue;
      }

      const fence = /^```\s*([\w-]+)?\s*$/.exec(line);
      if (fence) {
        const language = (fence[1] || '').toLowerCase();
        const code = [];
        index += 1;
        while (index < lines.length && !/^```\s*$/.test(lines[index])) {
          code.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        const highlighted = language === 'json' || language === 'jsonc'
          ? highlightJson(code.join('\n'))
          : escapeHtml(code.join('\n'));
        blocks.push(`<pre class="md-code"><code>${highlighted}</code></pre>`);
        continue;
      }

      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        const level = heading[1].length;
        blocks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
        index += 1;
        continue;
      }

      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        blocks.push('<hr>');
        index += 1;
        continue;
      }

      const quote = /^\s*>\s?(.*)$/.exec(line);
      if (quote) {
        const content = [];
        while (index < lines.length) {
          const match = /^\s*>\s?(.*)$/.exec(lines[index]);
          if (!match) break;
          content.push(match[1]);
          index += 1;
        }
        blocks.push(`<blockquote>${renderMarkdown(content.join('\n'))}</blockquote>`);
        continue;
      }

      if (/^\s*[-*+]\s+/.test(line)) {
        const list = renderList(lines, index, false);
        blocks.push(list.html);
        index = list.next;
        continue;
      }

      if (/^\s*\d+[.)]\s+/.test(line)) {
        const list = renderList(lines, index, true);
        blocks.push(list.html);
        index = list.next;
        continue;
      }

      const table = renderTable(lines, index);
      if (table) {
        blocks.push(table.html);
        index = table.next;
        continue;
      }

      const paragraph = [];
      while (index < lines.length && !isBlockStart(lines, index)) {
        paragraph.push(lines[index].trim());
        index += 1;
      }
      if (paragraph.length) blocks.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
      else index += 1;
    }

    return blocks.join('\n');
  }

  return { escapeHtml, safeUrl, renderInline, renderMarkdown, highlightJson };
});
