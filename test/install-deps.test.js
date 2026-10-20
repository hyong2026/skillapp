#!/usr/bin/env node
/**
 * install-deps.test.js — 「该装什么 / 装没装 / venv 怎么注入」
 *
 * 只测判定与快路径：不真的跑 npm / pip（测试不依赖网络，也不在测试机上装东西）。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { dependencyPlan, hasInstalled, venvEnv, ensureDependencies } from '../src/core/install-deps.js';

function tempSkill(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillapp-deps-'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('声明文件决定装什么；没有声明就不装（prompt 型 Skill 的常态）', () => {
  assert.equal(dependencyPlan(tempSkill()), null);
  assert.deepEqual(dependencyPlan(tempSkill({ 'package.json': '{}' })), { manager: 'npm', args: ['install'] });
  assert.deepEqual(
    dependencyPlan(tempSkill({ 'package.json': '{}', 'package-lock.json': '{}' })),
    { manager: 'npm', args: ['ci'] },
    '有 lockfile 就用 npm ci（可复现）',
  );
  assert.deepEqual(dependencyPlan(tempSkill({ 'requirements.txt': 'requests\n' })), { manager: 'pip', args: ['-r', 'requirements.txt'] });
  assert.deepEqual(dependencyPlan(tempSkill({ 'pyproject.toml': '[project]\nname = "x"\n' })), { manager: 'pip', args: ['.'] });
});

test('装没装只看文件系统：npm 看 node_modules，pip 看 .venv', () => {
  const npm = tempSkill({ 'package.json': '{}' });
  assert.equal(hasInstalled(npm, 'npm'), false);
  fs.mkdirSync(path.join(npm, 'node_modules'));
  assert.equal(hasInstalled(npm, 'npm'), true);

  const py = tempSkill({ 'requirements.txt': 'x\n' });
  assert.equal(hasInstalled(py, 'pip'), false);
  fs.mkdirSync(path.join(py, '.venv', 'bin'), { recursive: true });
  assert.equal(hasInstalled(py, 'pip'), true);
});

test('venv 注入：没有 venv 就不动环境；有就把自己的 bin 前置到 PATH', () => {
  const dir = tempSkill();
  assert.deepEqual(venvEnv(path.join(dir, '.venv')), {}, '没装 Python 依赖时不该改 PATH');
  fs.mkdirSync(path.join(dir, '.venv', 'bin'), { recursive: true });
  const env = venvEnv(path.join(dir, '.venv'));
  assert.equal(env.VIRTUAL_ENV, path.join(dir, '.venv'));
  assert.ok(env.PATH.startsWith(`${path.join(dir, '.venv', 'bin')}${path.delimiter}`), `PATH 应前置 venv：${env.PATH}`);
});

test('ensureDependencies：没声明 → none；装过 → 直接过（不跑安装器）', async () => {
  assert.deepEqual(await ensureDependencies(tempSkill()), { state: 'none', manager: null });

  const skill = tempSkill({ 'package.json': '{}', 'source.json': '{"hash":"x","origin":"upload"}' });
  fs.mkdirSync(path.join(skill, 'node_modules'));
  assert.deepEqual(await ensureDependencies(skill), { state: 'ok', manager: 'npm' });
});

test('ensureDependencies：装过时不会覆盖 source.json 里已有的字段', async () => {
  const skill = tempSkill({ 'package.json': '{}', 'source.json': '{"hash":"x","origin":"upload"}' });
  fs.mkdirSync(path.join(skill, 'node_modules'));
  await ensureDependencies(skill);
  const record = JSON.parse(fs.readFileSync(path.join(skill, 'source.json'), 'utf8'));
  assert.equal(record.origin, 'upload');
  assert.equal(record.hash, 'x');
});
