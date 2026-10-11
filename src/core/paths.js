'use strict';

const path = require('path');

/** 仓库根目录；测试可用 SKILLAPP_ROOT 指向临时内容根。 */
const ROOT = path.resolve(process.env.SKILLAPP_ROOT || path.join(__dirname, '..', '..'));

/** 内容层根目录：装载的 Skill、Template、Run 和中间产物都在这里。 */
const DATA_DIR = path.resolve(process.env.SKILLAPP_DATA_DIR || path.join(ROOT, '.data'));

/** 源代码根目录：src/。 */
const SRC_DIR = path.resolve(__dirname, '..');

module.exports = {
  ROOT,
  DATA_DIR,
  SRC_DIR,

  SKILLS_DIR: path.join(DATA_DIR, 'skills'),
  TEMPLATES_DIR: path.join(DATA_DIR, 'templates'),
  RUNS_DIR: path.join(DATA_DIR, 'runs'),
  TMP_DIR: path.join(DATA_DIR, 'tmp'),

  WEB_DIR: path.join(SRC_DIR, 'web'),
};
