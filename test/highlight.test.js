import assert from 'node:assert';
import { test } from 'node:test';
import { escapeHtml, highlightJson } from '../src/web/lib/highlight.js';

test('JSON 高亮会转义内容并标记 token', () => {
  const html = highlightJson({ name: '<skillapp>', ok: true, count: 3, extra: null });
  assert.match(html, /json-key/);
  assert.match(html, /&lt;skillapp&gt;/);
  assert.match(html, /json-literal/);
  assert.match(html, /json-number/);
  assert.doesNotMatch(html, /<skillapp>/);
});

test('字符串入参先解析成 JSON 再高亮', () => {
  const html = highlightJson('{"count":3,"ok":true}');
  assert.match(html, /json-key/);
  assert.match(html, /json-number/);
  assert.match(html, /json-literal/);
});

test('非 JSON 字符串回退为安全文本', () => {
  const html = highlightJson('plain <text>');
  assert.match(html, /json-raw/);
  assert.match(html, /&lt;text&gt;/);
});

test('escapeHtml 覆盖基础实体', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});
