#!/usr/bin/env node
/**
 * parsing.test.js — 三处「读文本」的解析回归
 *
 *   1. `.env`      注释 / 引号 / export，且不覆盖已有环境变量（load-env.js）
 *   2. lark-cli    stdout 里夹横幅或杂音时仍能取出 JSON（lark.js）
 *   3. SKILL.md    frontmatter 里取 description，含块标量（skill-meta.js）
 *
 * 前两处都踩过坑：lark-cli 升级后往 stdout 打了一行横幅，早期实现把整段丢给
 * JSON.parse，于是整条流水线报「returned invalid JSON」。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { lark, parseOutput } from '../src/core/lark.js';
import { loadEnv, parseEnv } from '../src/core/load-env.js';
import { frontmatterValue } from '../src/core/skill-meta.js';

test('.env：注释、引号、export 都能解析，且不覆盖已有环境变量', () => {
  const parsed = parseEnv([
    '# comment',
    'A=one',
    'export B="two words"',
    "C='three'",
    'D="line1\\nline2"',
    '',
  ].join('\n'));
  assert.deepEqual(parsed, { A: 'one', B: 'two words', C: 'three', D: 'line1\nline2' });

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skillapp-env-')), '.env');
  fs.writeFileSync(file, 'SKILLAPP_TEST_ENV=file\n');
  process.env.SKILLAPP_TEST_ENV = 'shell';
  try {
    const loaded = loadEnv(file);
    assert.equal(loaded.SKILLAPP_TEST_ENV, 'file');
    assert.equal(process.env.SKILLAPP_TEST_ENV, 'shell', '已存在的环境变量优先');
  } finally {
    delete process.env.SKILLAPP_TEST_ENV;
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('lark-cli 输出：跳过 JSON 前后的横幅与杂音，没有 JSON 时照旧报错', () => {
  assert.deepEqual(
    parseOutput('lark-cli v1.0.97 installed successfully\n{\n  "ok": true,\n  "data": { "fields": [] }\n}\n'),
    { ok: true, data: { fields: [] } },
  );
  assert.deepEqual(parseOutput('{"ok":true,"data":{}}\n（还有一行人看的提示）\n'), { ok: true, data: {} });
  assert.throws(() => parseOutput('命令执行失败：需要授权'), SyntaxError);
});

test('lark-cli 真进程：带横幅的 stdout 也能吃下', () => {
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
    assert.deepEqual(lark(['base', '+field-list']).data.fields, [{ id: 'fldP' }]);
  } finally {
    process.env.PATH = realPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('frontmatter：普通值、引号、块标量都能读出来', () => {
  assert.equal(frontmatterValue('---\ndescription: 一句话\n---\n', 'description'), '一句话');
  assert.equal(frontmatterValue('---\ndescription: "带 冒号: 的值"\n---\n', 'description'), '带 冒号: 的值');
  assert.equal(frontmatterValue("---\ndescription: '单引号'\n---\n", 'description'), '单引号');
  assert.equal(frontmatterValue('---\ndescription: |\n  第一行\n  第二行\n---\n', 'description'), '第一行\n第二行');
  assert.equal(frontmatterValue('---\ndescription: >\n  第一行\n  第二行\n---\n', 'description'), '第一行 第二行');
});

test('frontmatter：缺字段返回 null，且只认顶层字段', () => {
  assert.equal(frontmatterValue('# 没有 frontmatter\n', 'description'), null);
  assert.equal(frontmatterValue('---\nname: x\n---\n', 'description'), null);
  assert.equal(frontmatterValue('---\ndescription:\n---\n', 'description'), null);
  assert.equal(frontmatterValue('---\nmetadata:\n  description: 子字段\nname: x\n---\n', 'description'), null);
});
