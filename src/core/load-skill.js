import fs from 'node:fs';
import path from 'node:path';
import { skillFileHashes, skillHash } from './skill-hash.js';
import { readSkillDescription } from './skill-meta.js';
import { SKILLS_DIR } from './paths.js';
import { AppError } from './errors.js';
import { assertRef } from './ref.js';

// 只搬源码：依赖由 install-deps.js 在首次使用时装到 Skill 自己目录里（Node 的 ESM import
// 不吃 NODE_PATH，想"每个 Skill 互不干扰"就只能装在本地）。
const SKIP = new Set(['.DS_Store', '.git', 'node_modules', '__pycache__', '.venv', 'venv']);

function isWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function loadSkill(input = {}) {
  if (!input.sourcePath) {
    throw new AppError('SOURCE_REQUIRED', 'Skill root directory is required', 'Enter the absolute path to a Skill root');
  }

  const source = path.resolve(String(input.sourcePath));
  const ref = assertRef(path.basename(source));
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    throw new AppError('SOURCE_NOT_FOUND', `Skill root directory not found: ${source}`, 'Check the path and retry', 404);
  }
  if (!fs.existsSync(path.join(source, 'SKILL.md'))) {
    throw new AppError('INVALID_SKILL', `Not a valid Skill directory: ${source}`, 'The directory must contain SKILL.md');
  }

  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  const skillsDir = fs.realpathSync(SKILLS_DIR);
  const src = fs.realpathSync(source);
  const dest = path.resolve(skillsDir, ref);
  if (path.dirname(dest) !== skillsDir) throw new AppError('INVALID_SKILL_REF', `Invalid ref: ${ref}`, 'Use a simple ref');
  if (src === dest) throw new AppError('SOURCE_EQUALS_DEST', 'Source and destination are the same directory', 'Choose a different source');
  if (isWithin(src, dest) || isWithin(dest, src)) {
    throw new AppError('SOURCE_OVERLAPS_DEST', 'Source and destination overlap', 'Choose a source outside the loaded Skill directory');
  }

  const tmp = fs.mkdtempSync(path.join(skillsDir, `.${ref}.tmp-`));
  const backup = path.join(skillsDir, `.${ref}.bak-${process.pid}-${Date.now()}`);
  let movedOld = false;

  try {
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      fs.cpSync(path.join(src, entry.name), path.join(tmp, entry.name), { recursive: true });
    }

    const hash = skillHash(tmp);
    const files = fs.readdirSync(tmp).length;
    fs.writeFileSync(path.join(tmp, 'source.json'), JSON.stringify({
      // 只记来源类型：`path` = 服务端按主机路径复制（CLI 与运维入口），`upload` = 浏览器上传。
      // 不记来源路径 —— 上传来的路径在用户机器上，对云端毫无意义；按路径装载的那条，
      // 调用方本来就知道自己给的路径。
      origin: input.origin === 'upload' ? 'upload' : 'path',
      hash,
      // 逐文件清单：指纹对不上时靠它说出是哪个文件变了（见 skill-hash.js 的 diffSkillFiles）。
      files: skillFileHashes(tmp),
      description: readSkillDescription(tmp),
      loaded_at: new Date().toISOString(),
    }, null, 2) + '\n');

    if (fs.existsSync(dest)) {
      fs.renameSync(dest, backup);
      movedOld = true;
    }
    fs.renameSync(tmp, dest);
    if (movedOld) fs.rmSync(backup, { recursive: true, force: true });
    return { ref, source: src, hash, files };
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (movedOld && !fs.existsSync(dest) && fs.existsSync(backup)) fs.renameSync(backup, dest);
    throw err;
  }
}

export { isWithin, loadSkill };
