#!/usr/bin/env node
/**
 * web-units.test.js — Web 层的两个静态/纯函数检查
 *
 *   1. 代码块高亮：行号渲染用的 JSON 整理、逐行高亮与转义
 *   2. import 体检：src/web 里 import 的名字，提供方必须真的导出
 *      （ESM 的 "does not provide an export named ..." 只在浏览器里炸，
 *       dataTable 就这么漏过一次，所以在这里提前抓）
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { escapeHtml, highlightText, jsonText } from '../src/web/lib/highlight.js';
import { formatDuration } from '../src/web/lib/format.js';

test('jsonText：对象与 JSON 字符串都整理成好看的文本，非 JSON 交给调用方兜底', () => {
  assert.equal(jsonText({ count: 3 }), '{\n  "count": 3\n}');
  assert.equal(jsonText('{"count":3}'), '{\n  "count": 3\n}');
  assert.equal(jsonText('plain <text>'), null);
});

test('时长格式：整分钟只写分钟，秒不补零（Runs / Operations / Run Item 共用这一份）', () => {
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(Number.NaN), '—');
  assert.equal(formatDuration(404), '404 ms', '不到一秒还是毫秒');
  assert.equal(formatDuration(1500), '1.5 s');
  assert.equal(formatDuration(60_000), '1m', '正好整分钟不写 0 秒');
  assert.equal(formatDuration(120_000), '2m');
  assert.equal(formatDuration(68_000), '1m 8s', '秒不补零');
  assert.equal(formatDuration(94_361), '1m 34s');
  assert.equal(formatDuration(3_600_000), '60m', '目前不做小时，分钟一直涨');
});

test('逐行高亮：转义内容、标记 token，且不依赖整段是合法 JSON', () => {
  const html = highlightText('  "name": "<skillapp>",');
  assert.match(html, /json-key/);
  assert.match(html, /&lt;skillapp&gt;/);
  assert.doesNotMatch(html, /<skillapp>/);

  assert.equal(highlightText('{'), '{', '没有 token 的行原样输出');
  assert.match(highlightText('  "ok": true'), /json-literal/);
  assert.match(highlightText('  "count": 3'), /json-number/);
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});

const WEB_DIR = path.resolve(import.meta.dirname, '..', 'src', 'web');

function webFiles(dir = WEB_DIR, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) webFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out.sort();
}

// 模块导出的名字：支持 export { a, b }、export function a、export const/class a。
function exportsOf(file) {
  const source = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const [, list] of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of list.split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  for (const [, name] of source.matchAll(/export\s+(?:function|const|let|class)\s+([\w$]+)/g)) names.add(name);
  return names;
}

// 静态 import 的 {名字} ← 模块路径。
function namedImports(file) {
  const source = fs.readFileSync(file, 'utf8');
  const found = [];
  for (const [, names, spec] of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    for (const part of names.split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) found.push({ name, spec });
    }
  }
  return found;
}

test('src/web 里 import 的每个名字，提供方都真的导出了', () => {
  const missing = [];
  for (const file of webFiles()) {
    for (const { name, spec } of namedImports(file)) {
      if (!spec.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), spec);
      if (!fs.existsSync(target)) {
        missing.push(`${path.relative(WEB_DIR, file)} → ${spec}（模块不存在）`);
        continue;
      }
      if (!exportsOf(target).has(name)) {
        missing.push(`${path.relative(WEB_DIR, file)} → ${path.relative(WEB_DIR, target)} 里没有导出 ${name}`);
      }
    }
  }
  assert.deepEqual(missing, [], `有 import 找不到对应导出：\n${missing.join('\n')}`);
});
