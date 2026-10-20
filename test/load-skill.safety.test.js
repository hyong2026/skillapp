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
import { skillHash } from '../src/core/skill-hash.js';

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
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: safe\ndescription: "一句话说明"\n---\n\n# source\n');

  const r = runLoad(root, source);

  assert.equal(r.status, 0, r.stderr);
  const dest = path.join(root, '.data', 'skills', 'safe');
  assert.match(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), /# source/);
  assert.match(fs.readFileSync(path.join(dest, 'source.json'), 'utf8'), /"description": "一句话说明"/);
});

test('装载只搬源码：依赖、字节码、venv 都不进副本，也不进指纹', () => {
  const root = makeRepo();
  const source = path.join(root, 'skimmed');
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(source, 'node_modules', 'sharp'), { recursive: true });
  fs.mkdirSync(path.join(source, '__pycache__'), { recursive: true });
  fs.mkdirSync(path.join(source, '.venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '# source\n');
  fs.writeFileSync(path.join(source, 'package.json'), '{ "dependencies": { "sharp": "^0.33.0" } }\n');
  fs.writeFileSync(path.join(source, 'scripts', 'main.js'), 'export const ok = true;\n');
  fs.writeFileSync(path.join(source, 'node_modules', 'sharp', 'index.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(source, '__pycache__', 'main.cpython-311.pyc'), 'x');
  fs.writeFileSync(path.join(source, '.venv', 'bin', 'python'), '');

  const r = runLoad(root, source);
  assert.equal(r.status, 0, r.stderr);

  const dest = path.join(root, '.data', 'skills', 'skimmed');
  assert.equal(fs.existsSync(path.join(dest, 'node_modules')), false, '依赖不跟源码走（首次使用时按声明装）');
  assert.equal(fs.existsSync(path.join(dest, '__pycache__')), false);
  assert.equal(fs.existsSync(path.join(dest, '.venv')), false);
  assert.ok(fs.existsSync(path.join(dest, 'package.json')), '声明文件属于源码，要留着');
  assert.ok(fs.existsSync(path.join(dest, 'scripts', 'main.js')));
  assert.match(fs.readFileSync(path.join(dest, 'source.json'), 'utf8'), /"origin": "path"/);

  // 指纹只看源码：事后补回依赖 / 字节码，指纹不该变
  const before = JSON.parse(fs.readFileSync(path.join(dest, 'source.json'), 'utf8')).hash;
  fs.mkdirSync(path.join(dest, '__pycache__'), { recursive: true });
  fs.writeFileSync(path.join(dest, '__pycache__', 'later.cpython-311.pyc'), 'y');
  fs.mkdirSync(path.join(dest, 'node_modules', 'sharp'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'node_modules', 'sharp', 'index.js'), 'module.exports = {};\n');
  assert.equal(skillHash(dest), before, '依赖与字节码都不进指纹');
});
