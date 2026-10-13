import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseEnv, loadEnv } from '../src/core/load-env.js';

test('.env 解析支持注释、引号和 export', () => {
  const parsed = parseEnv([
    '# comment',
    'A=one',
    'export B="two words"',
    "C='three'",
    'D="line1\\nline2"',
    '',
  ].join('\n'));
  assert.deepEqual(parsed, { A: 'one', B: 'two words', C: 'three', D: 'line1\nline2' });
});

test('.env 加载不会覆盖已有环境变量', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skillapp-env-')), '.env');
  fs.writeFileSync(file, 'SKILLAPP_TEST_ENV=file\n');
  process.env.SKILLAPP_TEST_ENV = 'shell';
  try {
    const loaded = loadEnv(file);
    assert.equal(loaded.SKILLAPP_TEST_ENV, 'file');
    assert.equal(process.env.SKILLAPP_TEST_ENV, 'shell');
  } finally {
    delete process.env.SKILLAPP_TEST_ENV;
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});
