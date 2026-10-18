#!/usr/bin/env node
/**
 * generate.js — SkillApp 的通用生图入口
 *
 * 它是一层**薄封装**：把参数拼成官方 `openai` CLI 的命令，交给它去发请求。
 * 生图这件事不自研 HTTP 客户端了 —— 端点/密钥/模型由环境变量决定，请求细节交给 CLI：
 *
 *   SKILLAPP_IMAGE_BASE_URL   中转站 / OpenAI 兼容端点（必填），例如 https://api.example.com/v1
 *   SKILLAPP_IMAGE_API_KEY    Bearer 密钥（必填）
 *   SKILLAPP_IMAGE_MODEL      模型 ID（必填，除非命令行给 --model），例如 gpt-image-2.5-flare
 *   SKILLAPP_IMAGE_SIZE       默认尺寸（可选），例如 1248x1664
 *   SKILLAPP_IMAGE_QUALITY    默认质量（可选），low / medium / high
 *   SKILLAPP_IMAGE_TIMEOUT_MS 单张图超时（可选，默认 180000）
 *   SKILLAPP_IMAGE_OPENAI_CLI openai 可执行文件（可选，默认从 PATH 找 `openai`）
 *
 * 契约：成功时把写出的**绝对路径**打到 stdout（每行一个；--json 时是一行 JSON，
 * 形如 {"files":[...],"count":N,...}，正好可以当 prompt 型 Skill 的"最后一行答案"）。
 * 失败时 stderr 一行原因 + 退出码 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 180_000;

function usage() {
  return [
    'Usage: node generate.js --prompt <text> | --prompt-file <path> --out <path>',
    '       [--ref <path>]... [--size WxH] [--quality low|medium|high] [--n N]',
    '       [--model <id>] [--json] [--dry-run]',
    '',
    'Env: SKILLAPP_IMAGE_BASE_URL, SKILLAPP_IMAGE_API_KEY, SKILLAPP_IMAGE_MODEL,',
    '     SKILLAPP_IMAGE_SIZE, SKILLAPP_IMAGE_QUALITY, SKILLAPP_IMAGE_TIMEOUT_MS,',
    '     SKILLAPP_IMAGE_OPENAI_CLI',
  ].join('\n');
}

function parseArgv(argv) {
  const out = { refs: [], n: 1, json: false, dryRun: false, help: false, prompt: null, promptFile: null, out: null, size: null, quality: null, model: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === '--prompt') out.prompt = next();
    else if (arg === '--prompt-file') out.promptFile = next();
    else if (arg === '--out') out.out = next();
    else if (arg === '--ref') out.refs.push(next());
    else if (arg === '--size') out.size = next();
    else if (arg === '--quality') out.quality = next();
    else if (arg === '--n') out.n = Number.parseInt(next(), 10);
    else if (arg === '--model') out.model = next();
    else if (arg === '--json') out.json = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '-h' || arg === '--help') out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

/** 缺失的配置一次性说清楚——这类错误只该出现在第一次试跑。 */
function config(options) {
  const baseUrl = (process.env.SKILLAPP_IMAGE_BASE_URL || '').trim();
  const apiKey = (process.env.SKILLAPP_IMAGE_API_KEY || '').trim();
  const model = (options.model || process.env.SKILLAPP_IMAGE_MODEL || '').trim();
  const missing = [];
  if (!baseUrl) missing.push('SKILLAPP_IMAGE_BASE_URL');
  if (!apiKey) missing.push('SKILLAPP_IMAGE_API_KEY');
  if (!model) missing.push('SKILLAPP_IMAGE_MODEL');
  if (missing.length) {
    throw new Error(`image backend is not configured: set ${missing.join(' / ')} in .env (or pass --model)`);
  }
  const timeout = Number.parseInt(process.env.SKILLAPP_IMAGE_TIMEOUT_MS ?? '', 10);
  return {
    cli: (process.env.SKILLAPP_IMAGE_OPENAI_CLI || '').trim() || 'openai',
    baseUrl,
    apiKey,
    model,
    size: options.size || (process.env.SKILLAPP_IMAGE_SIZE || '').trim() || null,
    quality: options.quality || (process.env.SKILLAPP_IMAGE_QUALITY || '').trim() || null,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  };
}

/**
 * 拼官方 openai CLI 的命令行。
 * 有参考图走 `images edit`（--image 可重复），否则 `images generate`；
 * 端点与密钥一律显式传，免得被 CLI 自己的配置或 shell 里的 OPENAI_* 抢走。
 *
 * 注意 `--api-key` / `--base-url` 是**根选项，必须写在子命令前**——写到后面它会报
 * "An option is not recognized"。
 */
function openaiArgv(cfg, options, prompt, workDir, name) {
  const argv = [
    '--api-key', cfg.apiKey,
    '--base-url', cfg.baseUrl,
    'images', options.refs.length ? 'edit' : 'generate',
    '--prompt', String(prompt),
    '--model', cfg.model,
  ];
  for (const ref of options.refs) argv.push('--image', ref);
  if (cfg.size) argv.push('--size', cfg.size);
  if (cfg.quality) argv.push('--quality', cfg.quality);
  if (options.n > 1) argv.push('-n', String(options.n));
  argv.push('--output-dir', workDir, '--name', name, '--inline', 'off');
  return argv;
}

/** 按位置改名：第 1 张就是 --out，之后加 -2 / -3。CLI 自己怎么命名都不影响我们。 */
function targetPath(out, index) {
  if (index === 0) return out;
  const ext = path.extname(out);
  return `${path.join(path.dirname(out), path.basename(out, ext))}-${index + 1}${ext}`;
}

/** CLI 的报错是多行的英文段落；压成一行，别把缩进和换行塞进 run.json。 */
function failureDetail(result) {
  const text = `${result.stderr || ''}\n${result.stdout || ''}`;
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.join(' ').slice(0, 500) || 'no output';
}

function runOpenai(cfg, argv) {
  const result = spawnSync(cfg.cli, argv, { encoding: 'utf8', timeout: cfg.timeoutMs, env: process.env });
  if (result.error?.code === 'ENOENT') {
    throw new Error(`openai CLI not found: ${cfg.cli} (install it, or point SKILLAPP_IMAGE_OPENAI_CLI at the binary)`);
  }
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(`image generation timed out after ${cfg.timeoutMs}ms`);
  }
  if (result.error) throw new Error(`image generation failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`image generation failed: ${failureDetail(result)}`);
}

async function main() {
  const options = parseArgv(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const prompt = options.promptFile ? fs.readFileSync(options.promptFile, 'utf8') : options.prompt;
  if (!prompt || !String(prompt).trim()) throw new Error('a prompt is required: --prompt <text> or --prompt-file <path>');
  if (!options.out) throw new Error('--out <path> is required');
  if (!Number.isInteger(options.n) || options.n < 1) throw new Error('--n must be a positive integer');
  if (options.size && !/^(\d+x\d+|auto)$/i.test(options.size)) throw new Error('--size must look like 1024x1536 (or auto)');
  for (const ref of options.refs) {
    if (!fs.existsSync(ref)) throw new Error(`reference image not found: ${ref}`);
  }

  const cfg = config(options);
  const outPath = path.resolve(options.out);

  if (options.dryRun) {
    // 只报"要发什么"，不执行 CLI（也就不会花钱），用来核对配置。
    const shown = openaiArgv(cfg, options, prompt, '<tmp>', path.basename(outPath, path.extname(outPath)));
    const masked = shown.map((arg, i) => (shown[i - 1] === '--api-key' ? '***' : arg));
    process.stdout.write(`${JSON.stringify({
      dry_run: true,
      command: [cfg.cli, ...masked],
      files: Array.from({ length: options.n }, (_, i) => targetPath(outPath, i)),
      model: cfg.model,
      size: cfg.size,
      quality: cfg.quality,
      refs: options.refs,
      prompt_chars: String(prompt).length,
    })}\n`);
    return;
  }

  // 工作在 out 同级的临时目录里：同卷改名，CLI 也不会覆盖已有文件。
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const workDir = fs.mkdtempSync(path.join(path.dirname(outPath), '.image-generator-'));
  let files = [];
  try {
    runOpenai(cfg, openaiArgv(cfg, options, prompt, workDir, path.basename(outPath, path.extname(outPath))));
    const produced = fs.readdirSync(workDir).filter((name) => !name.startsWith('.')).sort();
    if (!produced.length) throw new Error('image generation reported success but wrote no file');
    files = produced.map((name, index) => {
      const target = targetPath(outPath, index);
      fs.renameSync(path.join(workDir, name), target);
      // CLI 落盘是 0600；产物要给别人（和 Web UI）读，跟其它 Skill 的产物保持一致。
      fs.chmodSync(target, 0o644);
      return target;
    });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ files, count: files.length, model: cfg.model, size: cfg.size, refs: options.refs.length })}\n`);
    return;
  }
  process.stdout.write(`${files.join('\n')}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exit(1);
});
