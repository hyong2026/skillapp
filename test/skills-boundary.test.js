#!/usr/bin/env node
/**
 * skills-boundary.test.js — 装载进来的 Skill 用哪套模块系统
 *
 * 仓库根声明了 `"type": "module"`（给 src/、test/、内置 Skill 脚本用），而 `.data/skills/`
 * 装的是**第三方 Skill 代码**：它们大多是 `require()` 的 CommonJS 脚本，不该被仓库的声明连坐。
 * Node 只认**最近的** package.json，所以 `.data/skills/package.json`（不声明 type）把查找截断在
 * 这里——这份文件跟着仓库走，没有运行时补写。
 */
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const BOUNDARY_REL = path.join('.data', 'skills', 'package.json');

test('这边界真的管用：上层声明 type:module 时，CJS 的 Skill 仍然跑得起来', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillapp-skills-boundary-'));
  fs.writeFileSync(path.join(root, 'package.json'), '{ "type": "module" }\n'); // 模拟仓库根
  const entry = path.join(root, '.data', 'skills', 'cjs-skill', 'scripts', 'main.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, "const fs = require('node:fs');\nconsole.log('cjs-skill-ok', typeof fs.readFileSync);\n");

  const broken = spawnSync(process.execPath, [entry], { encoding: 'utf8' });
  assert.notEqual(broken.status, 0, '没有边界文件时，CJS 的 Skill 会被当成 ESM 直接崩——这正是要防的');
  assert.match(broken.stderr, /require is not defined in ES module scope/);

  // 边界就放在 skills/ 这一层：第三方代码在它下面，查找到这里就停
  fs.writeFileSync(path.join(root, '.data', 'skills', 'package.json'), '{}\n');
  const fixed = spawnSync(process.execPath, [entry], { encoding: 'utf8' });
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.match(fixed.stdout, /cjs-skill-ok function/);
});

test('仓库里这份边界文件在位、能进 Git、且不替 Skill 决定模块系统', () => {
  const file = path.join(REPO, BOUNDARY_REL);
  assert.ok(fs.existsSync(file), `${BOUNDARY_REL} 要跟着仓库走（.gitignore 里有例外）`);

  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', BOUNDARY_REL], { cwd: REPO, encoding: 'utf8' });
  assert.equal(tracked.status, 0, '它必须在 Git 里：内容目录被清掉后，得能随仓库恢复');

  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal('type' in parsed, false, '声明了 type 就等于替第三方 Skill 决定模块系统');

  // 真实内容层里就有 CJS 的 Skill（image-split 用 require('sharp')、没有自带 package.json）
  const skill = path.join(REPO, '.data', 'skills', 'image-split', 'scripts', 'main.js');
  if (fs.existsSync(skill)) {
    const run = spawnSync(process.execPath, [skill, '--help'], { encoding: 'utf8' });
    assert.equal(run.status, 0, `已装载的 CJS Skill 必须还能跑：${run.stderr}`);
  }
});
