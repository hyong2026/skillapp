#!/usr/bin/env node
/**
 * resume.test.js — 失败行的"断点续跑"
 *
 * Retry = 再跑一次增量。已经**成功**的行本来就不会被选中；这里管的是另一半：
 * 上一次 **Skill 已经跑完**、只是回写阶段失败的行（列类型不对、授权过期、表达式写错…），
 * 重试时不该再把贵的 Skill 跑一遍——复用它的产物，只补回写。
 *
 * 判定与搬运都是纯函数，这里直接盯它们：什么时候能续、搬了什么、stdout 里的路径改写到哪。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resumePoint, reuseOutputs } from '../src/core/execute-template.js';

const OUTPUT = { key: 'cards', type: 'attachment', from: 'stdout.files[]' };

/** 造一份"上一次的 Run"：runs/<runId>/<recordId>/{results.json,artifacts/card-1.png} */
function previousRun({ runId = '20260101-000001-aaaa', recordId = 'rec1', stdout = null, files = ['artifacts/card-1.png'], hasStdout = true } = {}) {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillapp-resume-'));
  const recordDir = path.join(runsDir, runId, recordId);
  fs.mkdirSync(path.join(recordDir, 'artifacts'), { recursive: true });
  const paths = files.map((rel) => path.join(recordDir, rel));
  for (const file of paths) fs.writeFileSync(file, 'png-bytes');
  if (hasStdout) {
    fs.writeFileSync(path.join(recordDir, 'results.json'), JSON.stringify(stdout ?? { files: paths, count: 1 }, null, 2));
  }
  return { runsDir, runId, recordId, recordDir, paths };
}

function context(prev, overrides = {}) {
  return {
    dryRun: false,
    trigger: 'incremental',
    execHash: 'sha256:exec',
    outputs: [OUTPUT],
    history: new Map([[prev.recordId, {
      status: 'failed',
      input_hash: 'sha256:input',
      work_hash: 'sha256:work',
      exec_hash: 'sha256:exec',
      run_id: prev.runId,
    }]]),
    ...overrides,
  };
}

const canResume = (ctx, prev) => resumePoint(ctx, prev.recordId, 'sha256:input', prev.runsDir);

test('Skill 已跑完、输入与 exec 版本没变、产物还在 → 可以续跑', () => {
  const prev = previousRun();
  const point = canResume(context(prev), prev);
  assert.ok(point, '这种情况就该续跑，别再跑一遍 Skill');
  assert.equal(point.runId, prev.runId);
  assert.equal(point.prevRecordDir, prev.recordDir);
  assert.deepEqual(point.stdout.files, prev.paths);
});

test('续跑的条件：任一条不成立都不续（宁可贵一次，也别把对不上的产物写进表）', () => {
  const prev = previousRun();
  const last = context(prev).history.get(prev.recordId);
  const withoutStdout = previousRun({ hasStdout: false });
  const gone = previousRun();
  fs.rmSync(gone.paths[0]);

  const cases = [
    ['上次是成功的', context(prev, { history: new Map([[prev.recordId, { ...last, status: 'succeeded' }]]) }), prev],
    ['输入变了', context(prev, { history: new Map([[prev.recordId, { ...last, input_hash: 'sha256:other' }]]) }), prev],
    ['换了 cmd / Skill（exec 版本变）', context(prev, { execHash: 'sha256:other' }), prev],
    ['上次没跑到解析 stdout（exec 中途失败）', context(withoutStdout), withoutStdout],
    ['产物被删了', context(gone), gone],
    ['全量（All Rows）跑：无条件重跑', context(prev, { trigger: 'all' }), prev],
    ['试跑（dry-run）不产生记录', context(prev, { dryRun: true }), prev],
    ['历史里没有这条记录', context(prev, { history: new Map() }), prev],
  ];
  for (const [name, ctx, target] of cases) {
    assert.equal(canResume(ctx, target), null, `${name}：不该续跑`);
  }
});

test('reuseOutputs：产物搬到新行目录（硬链接优先），stdout 路径改写、并且落盘', () => {
  const prev = previousRun();
  const ctx = context(prev);
  const point = canResume(ctx, prev);
  const recordDir = path.join(prev.runsDir, 'next-run', prev.recordId);

  const { stdout, reused } = reuseOutputs(ctx, point, recordDir);
  assert.equal(reused, 1);
  const moved = path.join(recordDir, 'artifacts', 'card-1.png');
  assert.ok(fs.existsSync(moved), '产物要出现在这次 Run 的行目录里');
  assert.equal(fs.readFileSync(moved, 'utf8'), 'png-bytes');
  if (fs.statSync(moved).ino === fs.statSync(prev.paths[0]).ino) {
    assert.ok(true, '同一卷上直接硬链接，不占额外空间');
  }
  assert.deepEqual(stdout.files, [moved], 'stdout 里的路径要指向这次 Run 的位置');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(recordDir, 'results.json'), 'utf8')).files, [moved],
    '新 Run 也留一份 results.json，以后还能继续续跑');
  assert.equal(fs.existsSync(prev.paths[0]), true, '上一次的产物不能动');
});

test('reuseOutputs：行目录之外的文件（例如 /tmp 中间产物）不改写、也不搬', () => {
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skillapp-resume-out-')), 'tmp.png');
  fs.writeFileSync(outside, 'png-bytes');
  const prev = previousRun({ files: [], stdout: { files: [outside], count: 1 } });
  const ctx = context(prev);
  const point = canResume(ctx, prev);
  assert.ok(point, '外部文件还在，就该续跑');
  const recordDir = path.join(prev.runsDir, 'next-run', prev.recordId);
  const { stdout, reused } = reuseOutputs(ctx, point, recordDir);
  assert.equal(reused, 0, '不在行目录里的文件不搬');
  assert.deepEqual(stdout.files, [outside], '路径原样保留');
});
