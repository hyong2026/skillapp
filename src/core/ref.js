import { AppError } from './errors.js';

/** Skill ref 白名单：装载后的目录名，也是 Template / Mapping / Run 的引用键。 */
const SAFE_REF = /^[A-Za-z0-9._-]+$/;

function assertRef(ref) {
  const value = String(ref || '').trim();
  if (!SAFE_REF.test(value) || value === '.' || value === '..') {
    throw new AppError('INVALID_SKILL_REF', 'Skill ref is invalid', 'Use letters, numbers, dots, underscores, and hyphens');
  }
  return value;
}

export { assertRef };
