'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const {
  escapeHtml,
  renderMarkdown,
  highlightJson,
} = require('../src/web/markdown');

test('Markdown 默认转义原始 HTML', () => {
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('Markdown 支持标题、列表、链接和表格', () => {
  const html = renderMarkdown([
    '# 标题',
    '',
    '- 第一项',
    '- [文档](https://example.com)',
    '',
    '| 名称 | 值 |',
    '| --- | --- |',
    '| 状态 | 成功 |',
  ].join('\n'));
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<ul><li>第一项<\/li>/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /<table>/);
  assert.match(html, /<th scope="col">名称<\/th>/);
});

test('Markdown 拒绝危险链接协议', () => {
  const html = renderMarkdown('[点我](javascript:alert(1))');
  assert.match(html, /href="#"/);
  assert.doesNotMatch(html, /javascript:/i);
});

test('Markdown 代码块支持 JSON 语法高亮', () => {
  const html = renderMarkdown('```json\n{"name":"skillapp","ok":true,"count":3}\n```');
  assert.match(html, /json-key/);
  assert.match(html, /json-string/);
  assert.match(html, /json-literal/);
  assert.match(html, /json-number/);
});

test('JSON 高亮会转义内容并标记 token', () => {
  const html = highlightJson({ name: '<skillapp>', ok: true, count: 3, extra: null });
  assert.match(html, /json-key/);
  assert.match(html, /&lt;skillapp&gt;/);
  assert.match(html, /json-literal/);
  assert.match(html, /json-number/);
  assert.doesNotMatch(html, /<skillapp>/);
});

test('非 JSON 字符串回退为安全文本', () => {
  const html = highlightJson('plain <text>');
  assert.match(html, /json-raw/);
  assert.match(html, /&lt;text&gt;/);
});

test('escapeHtml 覆盖基础实体', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});
