#!/usr/bin/env node
/**
 * skill-meta.js 的单元测试：从 SKILL.md frontmatter 里取 description。
 */

import assert from 'node:assert';
import { test } from 'node:test';
import { frontmatterValue } from '../src/core/skill-meta.js';

test('普通值、单双引号都能读出来', () => {
  assert.equal(frontmatterValue('---\ndescription: 一句话\n---\n', 'description'), '一句话');
  assert.equal(frontmatterValue('---\ndescription: "带 冒号: 的值"\n---\n', 'description'), '带 冒号: 的值');
  assert.equal(frontmatterValue("---\ndescription: '单引号'\n---\n", 'description'), '单引号');
});

test('块标量：| 保留换行，> 折成一行', () => {
  assert.equal(frontmatterValue('---\ndescription: |\n  第一行\n  第二行\n---\n', 'description'), '第一行\n第二行');
  assert.equal(frontmatterValue('---\ndescription: >\n  第一行\n  第二行\n---\n', 'description'), '第一行 第二行');
});

test('没有 frontmatter、没有该字段、字段为空都返回 null', () => {
  assert.equal(frontmatterValue('# 没有 frontmatter\n', 'description'), null);
  assert.equal(frontmatterValue('---\nname: x\n---\n', 'description'), null);
  assert.equal(frontmatterValue('---\ndescription:\n---\n', 'description'), null);
});

test('只认顶层字段：缩进的同名子字段不算', () => {
  const markdown = '---\nmetadata:\n  description: 子字段\nname: x\n---\n';
  assert.equal(frontmatterValue(markdown, 'description'), null);
});
