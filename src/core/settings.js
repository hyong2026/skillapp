import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.js';
import { parseEnv } from './load-env.js';
import { AppError } from './errors.js';

/**
 * 可改的白名单：只放「每次调用时读取」的 Analyze 配置，改完即时生效，不需要重启。
 * 需要重启才生效的项（token / 内容目录 / 根目录 / lark 模块）只读展示，不开放编辑。
 */
const EDITABLE = [
  { key: 'SKILLAPP_ANALYZE_COMMAND', label: '分析命令', hint: '默认 codex', placeholder: 'codex' },
  { key: 'SKILLAPP_ANALYZE_MODEL', label: '分析模型', hint: '留空则用命令自带默认模型', placeholder: '(默认)' },
  { key: 'SKILLAPP_ANALYZE_REASONING_EFFORT', label: '推理强度', hint: 'low / medium / high', placeholder: 'low' },
  { key: 'SKILLAPP_ANALYZE_TIMEOUT_MS', label: '分析超时 (ms)', hint: '默认 900000', placeholder: '900000' },
];

const READONLY = [
  { key: 'SKILLAPP_WEB_TOKEN', label: '访问令牌', secret: true, hint: '设置后控制台需要鉴权，改动需重启' },
  { key: 'SKILLAPP_DATA_DIR', label: '内容目录', hint: 'Skill / Template / Run 的存放位置，改动需重启' },
  { key: 'SKILLAPP_ROOT', label: '内容根', hint: '默认仓库根，改动需重启' },
  { key: 'SKILLAPP_LARK_MODULE', label: 'lark 实现模块', hint: '默认走 lark-cli，改动需重启' },
];

const EDITABLE_KEYS = new Set(EDITABLE.map((entry) => entry.key));

function envFilePath() {
  // 每次调用时解析：SKILLAPP_ROOT 是内容根覆盖（测试/多实例用），.env 跟着它走。
  return path.join(process.env.SKILLAPP_ROOT || ROOT, '.env');
}

function fileEnv() {
  const file = envFilePath();
  if (!fs.existsSync(file)) return {};
  return parseEnv(fs.readFileSync(file, 'utf8'));
}

function quoteEnvValue(value) {
  const text = String(value);
  return /[\s#"'\\]/.test(text)
    ? `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : text;
}

/** 就地改写 `.env`：保留注释与行序，只替换命中的行；值为 null 时删除该行。 */
function writeEnvFile(file, updates) {
  const pending = new Map(Object.entries(updates));
  const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const kept = [];
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = match?.[1];
    if (!key || !pending.has(key)) {
      if (line !== '' || kept.length) kept.push(line);
      continue;
    }
    const value = pending.get(key);
    pending.delete(key);
    if (value !== null) kept.push(`${key}=${quoteEnvValue(value)}`);
  }
  for (const [key, value] of pending) {
    if (value !== null) kept.push(`${key}=${quoteEnvValue(value)}`);
  }
  const body = `${kept.join('\n').replace(/\n+$/, '')}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

function readSettings(runtime = {}) {
  const fromFile = fileEnv();
  const editable = EDITABLE.map((entry) => {
    const fileValue = fromFile[entry.key];
    const value = process.env[entry.key] ?? fileValue ?? '';
    return {
      ...entry,
      value,
      source: fileValue !== undefined ? '.env' : process.env[entry.key] !== undefined ? 'environment' : null,
    };
  });
  const readonly = READONLY.map((entry) => {
    const value = process.env[entry.key] ?? fromFile[entry.key] ?? null;
    return {
      key: entry.key,
      label: entry.label,
      hint: entry.hint,
      secret: Boolean(entry.secret),
      set: Boolean(value && String(value).trim()),
      value: entry.secret ? null : value,
    };
  });
  return { env_file: envFilePath(), runtime, editable, readonly };
}

function saveSettings(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new AppError('INVALID_SETTINGS', 'Settings payload must be an object', 'Send { values: { KEY: "value" } }', 400);
  }
  const updates = {};
  for (const [key, rawValue] of Object.entries(patch)) {
    if (!EDITABLE_KEYS.has(key)) {
      throw new AppError('INVALID_SETTINGS', `${key} is not editable`, `Editable keys: ${[...EDITABLE_KEYS].join(', ')}`, 400);
    }
    const value = rawValue === null || rawValue === undefined ? '' : String(rawValue).trim();
    updates[key] = value === '' ? null : value;
  }
  if (!Object.keys(updates).length) return readSettings();

  writeEnvFile(envFilePath(), updates);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
  return readSettings();
}

export { EDITABLE, READONLY, envFilePath, readSettings, saveSettings };
