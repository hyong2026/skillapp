#!/usr/bin/env node
//
// 静态检查：src/web 里 import 的名字，提供方模块必须真的导出。
// ESM 的 "does not provide an export named ..." 只有在浏览器里才会炸，
// 这类漏改 import 的错很容易漏到页面上（dataTable 就这么漏过一次），所以在这里提前抓。

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

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
  for (const [, name] of source.matchAll(/export\s+(?:function|const|let|class)\s+([\w$]+)/g)) {
    names.add(name);
  }
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
