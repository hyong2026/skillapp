#!/usr/bin/env node
/**
 * load-skill.js 的安全回归：
 *   - 源目录与目标目录相同，不能先把源删掉再失败
 *   - ref 由目录名推导，不合法时拒绝
 *
 * 测试用临时内容根跑真进程，避免碰到当前仓库的 .data/skills/。
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillapp-load-safety-'));
  fs.mkdirSync(path.join(root, '.data', 'skills'), { recursive: true });
  return root;
}

function runLoad(root, source) {
  return spawnSync(process.execPath, [path.join(ROOT, 'src', 'cli', 'load-skill.js'), source], {
    encoding: 'utf8',
    env: { ...process.env, SKILLAPP_ROOT: root, SKILLAPP_DATA_DIR: path.join(root, '.data') },
  });
}

test('源目录就是目标目录时：拒绝，且不删除源 Skill', () => {
  const root = makeRepo();
  const source = path.join(root, '.data', 'skills', 'same');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '# original\n');

  const r = runLoad(root, source);

  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8'), '# original\n');
  assert.match(r.stderr, /same directory|不能相同/);
});

test('目录名不能作为合法 ref 时：拒绝装载', () => {
  const root = makeRepo();
  const source = path.join(root, 'bad name');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '# source\n');

  const r = runLoad(root, source);

  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(path.join(root, '.data', 'skills', 'bad name')), false);
  assert.match(r.stderr, /ref is invalid|不合法的 ref/);
});

test('普通装载仍然可用', () => {
  const root = makeRepo();
  const source = path.join(root, 'safe');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '# source\n');

  const r = runLoad(root, source);

  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(root, '.data', 'skills', 'safe', 'SKILL.md'), 'utf8'), '# source\n');
  assert.equal(fs.existsSync(path.join(root, '.data', 'skills', 'safe', 'source.json')), true);
});
