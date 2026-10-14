/**
 * template.js — Template 文件的身份、定位与归档状态
 *
 * Template 的身份是「Skill + 目标表」：同一个 Skill 映射到不同的表（或不同的视图）
 * 就是**不同的** Template，文件名带目标表的短指纹；同一张表重复映射只更新原来那一份。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TEMPLATES_DIR, TEMPLATE_SUFFIX } from './paths.js';
import { AppError } from './errors.js';
import { atomicWriteJson } from './json-file.js';

function targetKey(target = {}) {
  const parts = [target.base_token, target.table_id, target.view_id].map((part) => String(part ?? ''));
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 8);
}

/** `image-merge-1f2a3b4c.template.json` */
function templateFileName(ref, target) {
  return `${ref}-${targetKey(target)}${TEMPLATE_SUFFIX}`;
}

function templatePathFor(ref, target, dir = TEMPLATES_DIR) {
  return path.join(dir, templateFileName(ref, target));
}

function sameTarget(a, b) {
  if (!a || !b) return false;
  return a.base_token === b.base_token
    && a.table_id === b.table_id
    && (a.view_id ?? null) === (b.view_id ?? null);
}

function readTemplateFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function templateFilesIn(dir = TEMPLATES_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(TEMPLATE_SUFFIX) && !name.startsWith('.'))
    .map((name) => path.join(dir, name))
    .sort();
}

/** 同一个 Skill 在同一张表上的那份 Template。名字不参与判断，认的是 Skill 路径 + 目标表。 */
function findTemplateFor(ref, target, dir = TEMPLATES_DIR) {
  const file = templateFilesIn(dir).find((candidate) => {
    const template = readTemplateFile(candidate);
    return template?.skill?.path === `skills/${ref}` && sameTarget(template.target, target);
  });
  return file ? { file, template: readTemplateFile(file) } : null;
}

function findTemplateById(templateId, dir = TEMPLATES_DIR) {
  const file = templateFilesIn(dir).find((candidate) => readTemplateFile(candidate)?.template_id === templateId);
  return file ? { file, template: readTemplateFile(file) } : null;
}

/** 归档 = 冻结：文件不删、只是从列表里消失，且不能再跑；解冻即恢复。 */
function setTemplateArchived({ templateId, archived, dir = TEMPLATES_DIR } = {}) {
  const found = findTemplateById(templateId, dir);
  if (!found) {
    throw new AppError('TEMPLATE_NOT_FOUND', `Template not found: ${templateId}`, 'Refresh the Templates list', 404);
  }
  const next = { ...found.template };
  if (archived) next.archived_at = new Date().toISOString();
  else delete next.archived_at;
  atomicWriteJson(found.file, next);
  return { template: next, path: found.file };
}

export {
  targetKey,
  templateFileName,
  templatePathFor,
  sameTarget,
  templateFilesIn,
  findTemplateFor,
  findTemplateById,
  setTemplateArchived,
};
