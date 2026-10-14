/**
 * skill-meta.js — 从 SKILL.md 的 YAML frontmatter 里取元数据
 *
 * 不引依赖：只认顶层 `key: value`，支持单/双引号，以及 `|` / `>` 块标量。
 * 目前只用 description——它是 Skill 自己写的一句话说明，拿来放进 Skills 详情页。
 */

import fs from 'node:fs';
import path from 'node:path';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

function unquote(value) {
  const text = value.trim();
  const quoted = text.length >= 2
    && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")));
  return quoted ? text.slice(1, -1).replace(/\\(["\\'])/g, '$1').trim() : text;
}

/** 取 frontmatter 里的一个顶层字段；没有 frontmatter 或没有该字段就返回 null。 */
function frontmatterValue(markdown, key) {
  const block = FRONTMATTER.exec(String(markdown || ''))?.[1];
  if (!block) return null;

  const lines = block.split(/\r?\n/);
  const pattern = new RegExp(`^${key}\\s*:\\s*(.*)$`);
  for (let i = 0; i < lines.length; i += 1) {
    const match = pattern.exec(lines[i]);
    if (!match) continue;

    const inline = match[1].trim();
    if (inline && !/^[|>][-+]?$/.test(inline)) return unquote(inline) || null;

    // 块标量：把后面缩进更深的行收进来（`>` 折成一行，`|` 保留换行）
    const rest = [];
    for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j += 1) rest.push(lines[j].trim());
    if (!rest.length) return null;
    return inline.startsWith('>') ? rest.join(' ') : rest.join('\n');
  }
  return null;
}

/** 读已装载 Skill 的 SKILL.md；读不到就返回 null。 */
function readSkillDescription(skillDir) {
  try {
    const markdown = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    return frontmatterValue(markdown, 'description');
  } catch {
    return null;
  }
}

export { frontmatterValue, readSkillDescription };
