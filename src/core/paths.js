import path from 'node:path';

/** 仓库根目录；测试可用 SKILLAPP_ROOT 指向临时内容根。 */
const ROOT = path.resolve(process.env.SKILLAPP_ROOT || path.join(import.meta.dirname, '..', '..'));

/** 内容层根目录：装载的 Skill、Template、Run 和中间产物都在这里。 */
const DATA_DIR = path.resolve(process.env.SKILLAPP_DATA_DIR || path.join(ROOT, '.data'));

/** 源代码根目录：src/。 */
const SRC_DIR = path.resolve(import.meta.dirname, '..');

const SKILLS_DIR = path.join(DATA_DIR, 'skills');
const TEMPLATES_DIR = path.join(DATA_DIR, 'templates');
const RUNS_DIR = path.join(DATA_DIR, 'runs');
const OPERATIONS_DIR = path.join(DATA_DIR, 'operations');
const MAPPINGS_DIR = path.join(DATA_DIR, 'mappings');
const WEB_DIR = path.join(SRC_DIR, 'web');

/** 内容层两个 JSON 产物的后缀：Template 与 Mapping。 */
const TEMPLATE_SUFFIX = '.template.json';
const MAPPING_SUFFIX = '.mapping.json';

export {
  ROOT,
  DATA_DIR,
  SKILLS_DIR,
  TEMPLATES_DIR,
  RUNS_DIR,
  OPERATIONS_DIR,
  MAPPINGS_DIR,
  WEB_DIR,
  TEMPLATE_SUFFIX,
  MAPPING_SUFFIX,
};
