import assert from 'node:assert';
import { test } from 'node:test';
import { escapeHtml, highlightText, jsonText } from '../src/web/lib/highlight.js';

test('jsonText 把对象与 JSON 字符串都整理成好看的文本', () => {
  assert.equal(jsonText({ count: 3 }), '{\n  "count": 3\n}');
  assert.equal(jsonText('{"count":3}'), '{\n  "count": 3\n}');
  assert.equal(jsonText('plain <text>'), null, '不是 JSON 就交给调用方兜底');
});

test('逐行高亮会转义内容并标记 token', () => {
  const html = highlightText('  "name": "<skillapp>",');
  assert.match(html, /json-key/);
  assert.match(html, /&lt;skillapp&gt;/);
  assert.doesNotMatch(html, /<skillapp>/);
});

test('结构行与字面量也能上色（逐行高亮不依赖整段是合法 JSON）', () => {
  assert.equal(highlightText('{'), '{', '没有 token 的行原样输出');
  assert.match(highlightText('  "ok": true'), /json-literal/);
  assert.match(highlightText('  "count": 3'), /json-number/);
});

test('escapeHtml 覆盖基础实体', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});
