#!/usr/bin/env node
/**
 * image-generator.test.js — `.agents/skills/image-generator` 的回归
 *
 * 它是官方 `openai` CLI 的薄封装，所以这里用一支**假的 openai**（fixture 里现写一个可执行
 * 脚本）来钉住两件事：
 *   1. 我们拼给官方 CLI 的 argv 是什么（端点/密钥在前、images generate|edit、--image、-n、输出目录…）
 *   2. 我们对外承诺的契约（--out 绝对路径、-2 后缀、--json files/count、失败一行 stderr）
 *
 * 不碰真网络、不依赖机器上装没装 openai。
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const SCRIPT = path.resolve(import.meta.dirname, '..', '.agents', 'skills', 'image-generator', 'scripts', 'generate.js');
const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d', 'hex');

/** 假的 openai CLI：记下 argv，按 --output-dir/--name/-n 写出假图片，并打印 Saved image 行。 */
function writeFakeCli() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skillapp-fake-openai-')), 'fake-openai.cjs');
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
if (process.env.FAKE_OPENAI_LOG) fs.appendFileSync(process.env.FAKE_OPENAI_LOG, JSON.stringify(argv) + '\\n');
if (process.env.FAKE_OPENAI_FAIL === '1') {
  process.stderr.write('Request failed (401 Unauthorized).\\nAuthentication failed. Check your API key, organization, and project.\\n');
  process.exit(1);
}
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };
const dir = flag('--output-dir');
const name = flag('--name') || 'image';
const count = Number(flag('-n') || 1);
for (let i = 0; i < count; i += 1) {
  const out = path.join(dir, i === 0 ? name + '.png' : name + '-' + (i + 1) + '.png');
  fs.writeFileSync(out, Buffer.from('89504e470d0a1a0a0000000d', 'hex'));
  process.stdout.write('Saved image: "' + out + '"\\n');
}
`);
  fs.chmodSync(file, 0o755);
  return file;
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skillapp-imagegen-'));
}

/** 跑一次封装脚本。必须异步 spawn：里面会用 spawnSync 调 openai CLI。 */
function run(args, env = {}) {
  const cleaned = { ...process.env };
  for (const key of Object.keys(cleaned)) if (key.startsWith('SKILLAPP_IMAGE_')) delete cleaned[key];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...cleaned, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function scenario({ refs = [] } = {}) {
  const dir = tmpdir();
  const log = path.join(dir, 'openai-argv.jsonl');
  const env = {
    SKILLAPP_IMAGE_BASE_URL: 'https://relay.example.com/v1',
    SKILLAPP_IMAGE_API_KEY: 'sk-secret',
    SKILLAPP_IMAGE_MODEL: 'gpt-image-2.5-flare',
    SKILLAPP_IMAGE_OPENAI_CLI: writeFakeCli(),
    FAKE_OPENAI_LOG: log,
  };
  const out = path.join(dir, '01-cover.png');
  const refFiles = refs.map((name) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, PNG_BYTES);
    return file;
  });
  return { dir, log, env, out, refFiles, calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [] };
}

test('拼给官方 CLI 的 argv：根选项在前，尺寸/质量/输出目录都对', async () => {
  const s = scenario();
  const result = await run([
    '--prompt', '一只橘猫', '--size', '1248x1664', '--quality', 'high', '--out', s.out,
  ], { ...s.env, SKILLAPP_IMAGE_QUALITY: 'low' });

  assert.equal(result.status, 0, result.stderr);
  const [argv, ...rest] = s.calls();
  assert.deepEqual(rest, [], '只该调一次 CLI');
  // 临时目录名是随机的，比对时归一成占位符——这样断言能钉住参数的**顺序与取值**。
  const workDir = argv[argv.indexOf('--output-dir') + 1];
  assert.match(workDir, /^\/.*\.image-generator-/, '在 --out 同级建临时目录：改名同卷，也不会覆盖已有文件');
  // 根选项必须在子命令前（官方 CLI 只认这个位置），其余参数照传。
  assert.equal(
    argv.map((arg) => (arg === workDir ? '<work-dir>' : arg)).join(' '),
    '--api-key sk-secret --base-url https://relay.example.com/v1 images generate --prompt 一只橘猫'
    + ' --model gpt-image-2.5-flare --size 1248x1664 --quality high --output-dir <work-dir> --name 01-cover --inline off',
  );
  assert.equal(result.stdout.trim(), s.out, 'stdout 就是写出的绝对路径');
  assert.deepEqual(fs.readFileSync(s.out), PNG_BYTES);
  assert.equal(fs.readdirSync(s.dir).some((name) => name.startsWith('.image-generator-')), false, '临时目录要清掉');
});

test('参考图走 images edit：--image 可重复，--quality 来自环境变量', async () => {
  const s = scenario({ refs: ['a.png', 'b.png'] });
  const result = await run([
    '--prompt-file', (() => {
      const file = path.join(s.dir, 'prompt.md');
      fs.writeFileSync(file, '同一只猫的结尾页\n');
      return file;
    })(),
    '--ref', s.refFiles[0], '--ref', s.refFiles[1],
    '--out', s.out, '--json',
  ], { ...s.env, SKILLAPP_IMAGE_QUALITY: 'medium' });

  assert.equal(result.status, 0, result.stderr);
  const argv = s.calls()[0];
  const after = (flag) => argv[argv.indexOf(flag) + 1];
  assert.deepEqual(argv.slice(argv.indexOf('images'), argv.indexOf('images') + 3), ['images', 'edit', '--prompt']);
  assert.equal(after('--prompt'), '同一只猫的结尾页\n', '--prompt-file 的内容原样传下去');
  assert.equal(after('--image'), s.refFiles[0]);
  assert.equal(argv.filter((arg) => arg === '--image').length, 2, '多张参考图各自一个 --image');
  assert.equal(after('--quality'), 'medium');
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload, { files: [s.out], count: 1, model: 'gpt-image-2.5-flare', size: null, refs: 2 });
});

test('n>1：按位置改名，第 2 张加 -2 后缀', async () => {
  const s = scenario();
  const result = await run(['--prompt', 'x', '--n', '2', '--out', s.out, '--json'], s.env);
  assert.equal(result.status, 0, result.stderr);
  const argv = s.calls()[0];
  assert.deepEqual([argv[argv.indexOf('-n')], argv[argv.indexOf('-n') + 1]], ['-n', '2']);
  assert.equal(argv[argv.indexOf('--name') + 1], '01-cover');
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.files, [s.out, path.join(s.dir, '01-cover-2.png')]);
  assert.ok(payload.files.every((file) => fs.existsSync(file)));
});

test('缺配置 / openai CLI 不存在：一行 stderr + 退出码 1', async () => {
  const missing = await run(['--prompt', 'x', '--out', path.join(tmpdir(), 'a.png')], {});
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^image backend is not configured: .*SKILLAPP_IMAGE_BASE_URL/);
  assert.equal(missing.stdout, '');

  const s = scenario();
  const notFound = await run(['--prompt', 'x', '--out', s.out], { ...s.env, SKILLAPP_IMAGE_OPENAI_CLI: '/nope/openai' });
  assert.equal(notFound.status, 1);
  assert.match(notFound.stderr, /openai CLI not found: \/nope\/openai/);
});

test('openai CLI 报错：多行英文压成一行，别塞进 run.json', async () => {
  const s = scenario();
  const result = await run(['--prompt', 'x', '--out', s.out], { ...s.env, FAKE_OPENAI_FAIL: '1' });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim().split('\n').length, 1, '一行原因');
  assert.match(result.stderr, /image generation failed: Request failed \(401 Unauthorized\)\. Authentication failed\. Check your API key/);
  assert.equal(fs.existsSync(s.out), false, '失败不该留下空文件');
});

test('--dry-run：只报要执行什么，不调 CLI，也不泄露密钥', async () => {
  const s = scenario();
  const result = await run(['--prompt', '一只橘猫', '--size', 'auto', '--out', s.out, '--dry-run'], s.env);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.dry_run, true);
  assert.equal(payload.command[0], s.env.SKILLAPP_IMAGE_OPENAI_CLI);
  assert.deepEqual(payload.command.slice(1, 7), ['--api-key', '***', '--base-url', 'https://relay.example.com/v1', 'images', 'generate']);
  assert.equal(payload.files[0], s.out);
  assert.equal(payload.size, 'auto', '--size auto 也合法（交给模型自动定）');
  assert.deepEqual(s.calls(), [], 'dry-run 不能真的调 CLI');
});
