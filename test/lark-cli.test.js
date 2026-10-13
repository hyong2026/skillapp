#!/usr/bin/env node
/**
 * src/core/lark.js 的输出解析回归。
 *
 * 背景：lark-cli 升级后会往 stdout 打一行横幅（`lark-cli v1.0.97 installed successfully`），
 * 早期实现把整个 stdout 丢给 JSON.parse，于是整条流水线报「returned invalid JSON」。
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { lark, parseOutput } from '../src/core/lark.js';

test('解析会跳过 JSON 前面的横幅', () => {
  const stdout = 'lark-cli v1.0.97 installed successfully\n{\n  "ok": true,\n  "data": { "fields": [] }\n}\n';
  assert.deepEqual(parseOutput(stdout), { ok: true, data: { fields: [] } });
});

test('解析会忽略 JSON 后面的杂音', () => {
  const stdout = '{"ok":true,"data":{}}\n（还有一行人看的提示）\n';
  assert.deepEqual(parseOutput(stdout), { ok: true, data: {} });
});

test('没有 JSON 时照旧报错', () => {
  assert.throws(() => parseOutput('命令执行失败：需要授权'), SyntaxError);
});

test('走真进程时也能吃下带横幅的 stdout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillapp-lark-cli-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const cli = path.join(bin, 'lark-cli');
  fs.writeFileSync(cli, [
    '#!/bin/sh',
    "echo 'lark-cli v1.0.97 installed successfully'",
    'echo \'{"ok":true,"identity":"user","data":{"fields":[{"id":"fldP"}]}}\'',
  ].join('\n') + '\n');
  fs.chmodSync(cli, 0o755);

  const realPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${realPath}`;
  try {
    const out = lark(['base', '+field-list']);
    assert.deepEqual(out.data.fields, [{ id: 'fldP' }]);
  } finally {
    process.env.PATH = realPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
