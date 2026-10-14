#!/usr/bin/env node
/**
 * template.js 的单元测试：Template 的身份（Skill + 目标表）、按目标定位、归档状态。
 * 全落在 os.tmpdir() 下的临时目录，不碰真表、不起子进程。
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  findTemplateById,
  findTemplateFor,
  sameTarget,
  setTemplateArchived,
  targetKey,
  templateFileName,
} from '../src/core/template.js';

const A = { base_token: 'bas1', table_id: 'tbl1', view_id: 'vew1' };
const B = { base_token: 'bas1', table_id: 'tbl2', view_id: 'vew1' };
const A_OTHER_VIEW = { base_token: 'bas1', table_id: 'tbl1', view_id: 'vew2' };

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'skillapp-template-'));

const writeTemplate = (dir, name, template) =>
  fs.writeFileSync(path.join(dir, name), JSON.stringify(template, null, 2));

test('文件名 = <ref>-<目标指纹>.template.json，目标不同文件名就不同', () => {
  assert.match(templateFileName('image-merge', A), /^image-merge-[0-9a-f]{8}\.template\.json$/);
  assert.equal(targetKey(A).length, 8);
  assert.equal(templateFileName('image-merge', A), templateFileName('image-merge', { ...A }));
  assert.notEqual(templateFileName('image-merge', A), templateFileName('image-merge', B));
  assert.notEqual(templateFileName('image-merge', A), templateFileName('image-merge', A_OTHER_VIEW), '换个视图也是另一份');
});

test('sameTarget 只认 base + table + view 三元组', () => {
  assert.equal(sameTarget(A, { ...A }), true);
  assert.equal(sameTarget(A, B), false);
  assert.equal(sameTarget(A, A_OTHER_VIEW), false);
  assert.equal(sameTarget(A, null), false);
});

test('按目标找 Template：老命名也认，目标不同则不命中', () => {
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
