#!/usr/bin/env node
/**
 * mapping.js 的契约校验：`mapped` 标记规则。
 *
 *   - 缺省即映射，只有 `mapped: false` 才是未映射
 *   - 非必填输入、输出都可以未映射
 *   - 必填输入不能未映射（运行时读不到值，只能逐行失败）
 */

import assert from 'node:assert';
import { test } from 'node:test';
import { isMapped, validateMapping } from '../src/core/mapping.js';

const base = (overrides = {}) => ({
  skill: { entry: 'run.js' },
  cmd: 'node {skill.entry} {text} -o {outdir}',
  inputs: [{ key: 'text', label: '文本', type: 'text' }],
  outputs: [{ key: 'result', label: '结果', type: 'text', from: 'stdout.value' }],
  ...overrides,
});

test('缺省即映射，只有 mapped:false 才算未映射', () => {
  assert.equal(isMapped({}), true);
  assert.equal(isMapped({ mapped: true }), true);
  assert.equal(isMapped({ mapped: false }), false);
});

test('非必填输入与输出都可以标为未映射', () => {
  const mapping = validateMapping(base({
    inputs: [{ key: 'text', label: '文本', type: 'text', mapped: false, default: 'x' }],
    outputs: [{ key: 'result', label: '结果', type: 'text', from: 'stdout.value', mapped: false }],
  }));
  assert.equal(mapping.inputs[0].mapped, false);
  assert.equal(mapping.outputs[0].mapped, false);
});

test('必填输入不能被标为未映射', () => {
  assert.throws(() => validateMapping(base({
    inputs: [{ key: 'text', label: '文本', type: 'text', required: true, mapped: false }],
  })), /required and cannot be unmapped/);
});

test('mapped 只接受布尔值', () => {
  assert.throws(() => validateMapping(base({
    outputs: [{ key: 'result', label: '结果', type: 'text', from: 'stdout.value', mapped: 'no' }],
  })), /mapped must be a boolean/);
});
