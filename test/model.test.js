#!/usr/bin/env node
/**
 * model.test.js — Mapping 与 Template 两个数据模型的规则
 *
 *   Mapping   ：`mapped` 标记规则（缺省即映射；必填输入不能未映射）
 *   Template  ：身份 = Skill + 目标表（base + table + view），按目标定位，归档 / 解冻
 *
 * 全落在 os.tmpdir() 下的临时目录，不碰真表、不起子进程。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isMapped, validateMapping } from '../src/core/mapping.js';
import {
  findTemplateById,
  findTemplateFor,
  sameTarget,
  setTemplateArchived,
  targetKey,
  templateFileName,
} from '../src/core/template.js';

const base = (overrides = {}) => ({
  skill: { entry: 'run.js' },
  cmd: 'node {skill.entry} {text} -o {outdir}',
  inputs: [{ key: 'text', label: '文本', type: 'text' }],
  outputs: [{ key: 'result', label: '结果', type: 'text', from: 'stdout.value' }],
  ...overrides,
});

const A = { base_token: 'bas1', table_id: 'tbl1', view_id: 'vew1' };
const B = { base_token: 'bas1', table_id: 'tbl2', view_id: 'vew1' };
const A_OTHER_VIEW = { base_token: 'bas1', table_id: 'tbl1', view_id: 'vew2' };

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'skillapp-template-'));
const writeTemplate = (dir, name, template) => fs.writeFileSync(path.join(dir, name), JSON.stringify(template, null, 2));

test('Mapping：缺省即映射，只有 mapped:false 才算未映射', () => {
  assert.equal(isMapped({}), true);
  assert.equal(isMapped({ mapped: true }), true);
  assert.equal(isMapped({ mapped: false }), false);
});

test('Mapping：非必填输入与输出都可以未映射，必填输入不行，mapped 只收布尔值', () => {
  const mapping = validateMapping(base({
    inputs: [{ key: 'text', label: '文本', type: 'text', mapped: false, default: 'x' }],
    outputs: [{ key: 'result', label: '结果', type: 'text', from: 'stdout.value', mapped: false }],
  }));
  assert.equal(mapping.inputs[0].mapped, false);
  assert.equal(mapping.outputs[0].mapped, false);

  assert.throws(() => validateMapping(base({
    inputs: [{ key: 'text', label: '文本', type: 'text', required: true, mapped: false }],
  })), /required and cannot be unmapped/);
  assert.throws(() => validateMapping(base({
    outputs: [{ key: 'result', label: '结果', type: 'text', from: 'stdout.value', mapped: 'no' }],
  })), /mapped must be a boolean/);
});

test('Mapping：有默认值的输入不会被当成必填（空格由默认值兜住）', () => {
  const mapping = validateMapping(base({
    inputs: [
      { key: 'style', label: '风格', type: 'select', required: true, default: 'auto', options: ['auto', 'cute'] },
      { key: 'content', label: '内容', type: 'text', required: true },
      { key: 'flag', label: '开关', type: 'checkbox', required: true, default: false },
    ],
  }));
  assert.equal(mapping.inputs[0].required, false, 'default=auto ⇒ 不是必填');
  assert.equal(mapping.inputs[0].default, 'auto', 'default 本身要留着');
  assert.equal(mapping.inputs[1].required, true, '没默认值的必填保持必填');
  assert.equal(mapping.inputs[2].required, false, 'default=false 也算有默认值');
});

test('Template 身份：文件名带目标指纹，视图也算目标', () => {
  assert.match(templateFileName('image-merge', A), /^image-merge-[0-9a-f]{8}\.template\.json$/);
  assert.equal(targetKey(A).length, 8);
  assert.equal(templateFileName('image-merge', A), templateFileName('image-merge', { ...A }));
  assert.notEqual(templateFileName('image-merge', A), templateFileName('image-merge', B));
  assert.notEqual(templateFileName('image-merge', A), templateFileName('image-merge', A_OTHER_VIEW));

  assert.equal(sameTarget(A, { ...A }), true);
  assert.equal(sameTarget(A, B), false);
  assert.equal(sameTarget(A, A_OTHER_VIEW), false);
  assert.equal(sameTarget(A, null), false);
});

test('按目标定位 Template：老命名也认，目标或 Skill 不同则不命中', () => {
  const dir = tempDir();
  writeTemplate(dir, 'image-merge.template.json', {
    template_id: 'tpl-1',
    skill: { path: 'skills/image-merge' },
    target: A,
  });

  assert.equal(findTemplateFor('image-merge', A, dir)?.template.template_id, 'tpl-1');
  assert.equal(findTemplateFor('image-merge', B, dir), null, '另一张表不该命中');
  assert.equal(findTemplateFor('other-skill', A, dir), null, '另一个 Skill 不该命中');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('归档写入 archived_at、解冻删掉它，文件始终在', () => {
  const dir = tempDir();
  const file = path.join(dir, templateFileName('image-merge', A));
  writeTemplate(dir, path.basename(file), {
    template_id: 'tpl-1',
    skill: { path: 'skills/image-merge' },
    target: A,
  });

  const archived = setTemplateArchived({ templateId: 'tpl-1', archived: true, dir });
  assert.ok(archived.template.archived_at, '要写上归档时间');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).archived_at, archived.template.archived_at);
  assert.equal(findTemplateById('tpl-1', dir).template.archived_at, archived.template.archived_at);

  const restored = setTemplateArchived({ templateId: 'tpl-1', archived: false, dir });
  assert.equal(restored.template.archived_at, undefined, '解冻后不该留字段');
  assert.equal(fs.existsSync(file), true, '归档与解冻都不删文件');

  assert.throws(() => setTemplateArchived({ templateId: 'missing', archived: true, dir }), /Template not found/);
  fs.rmSync(dir, { recursive: true, force: true });
});
