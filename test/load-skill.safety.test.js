#!/usr/bin/env node
/**
 * load-skill.js 的安全回归：
 *   - 源目录与目标目录相同，不能先把源删掉再失败
 *   - --ref 不能借 .. 写出 .data/skills/ 目录
 *
 * 测试把脚本复制到临时仓库后跑真进程，避免碰到当前仓库的 .data/skills/。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { test } = require('node:test');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..');

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillapp-load-safety-'));
  fs.mkdirSync(path.join(root, 'src', 'cli'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'core'), { recursive: true });
  fs.mkdirSync(path.join(root, '.data', 'skills'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'src', 'cli', 'load-skill.js'), path.join(root, 'src', 'cli', 'load-skill.js'));
  fs.copyFileSync(path.join(ROOT, 'src', 'core', 'skill-hash.js'), path.join(root, 'src', 'core', 'skill-hash.js'));
  fs.copyFileSync(path.join(ROOT, 'src', 'core', 'paths.js'), path.join(root, 'src', 'core', 'paths.js'));
  return root;
}

function runLoad(root, source, ref) {
  return spawnSync(process.execPath, [path.join(root, 'src', 'cli', 'load-skill.js'), source, '--ref', ref], {
    encoding: 'utf8',
  });
}

test('源目录就是目标目录时：拒绝，且不删除源 Skill', () => {
  const root = makeRepo();
  const source = path.join(root, '.data', 'skills', 'same');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '# original\n');

  const r = runLoad(root, source, 'same');

  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8'), '# original\n');
  assert.match(r.stderr, /源目录和目标目录不能相同/);
});

test('--ref 试图路径穿越时：拒绝，且不创建目标目录', () => {
  const root = makeRepo();
  const source = path.join(root, 'source-skill');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '# source\n');

  const r = runLoad(root, source, '../outside');

  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(path.join(root, 'outside')), false);
  assert.match(r.stderr, /不合法的 ref/);
});

test('普通装载仍然可用', () => {
  const root = makeRepo();
  const source = path.join(root, 'source-skill');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '# source\n');

  const r = runLoad(root, source, 'safe');

  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(root, '.data', 'skills', 'safe', 'SKILL.md'), 'utf8'), '# source\n');
  assert.equal(fs.existsSync(path.join(root, '.data', 'skills', 'safe', 'source.json')), true);
});
