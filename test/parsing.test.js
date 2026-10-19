#!/usr/bin/env node
/**
 * parsing.test.js — 三处「读文本」的解析回归
 *
 *   1. `.env`      注释 / 引号 / export，且不覆盖已有环境变量（load-env.js）
 *   2. lark-cli    stdout 里夹横幅或杂音时仍能取出 JSON（lark.js）
 *   3. SKILL.md    frontmatter 里取 description，含块标量（skill-meta.js）
 *   4. cmd 分词与拼装 引号内的空白算同一个 argv；引号里的 {key...} 展开成文本列表
 *   6. 运行前核对  cmd 语法错在开跑前就报出来，不等某一行跑起来
 *   5. codex 事件流 prompt 型 Skill 的 live.log（live-log.js）
 *
 * 前两处都踩过坑：lark-cli 升级后往 stdout 打了一行横幅，早期实现把整段丢给
 * JSON.parse，于是整条流水线报「returned invalid JSON」。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { lark, parseOutput } from '../src/core/lark.js';
import { loadEnv, parseEnv } from '../src/core/load-env.js';
import { createCodexEvents } from '../src/core/live-log.js';
import { frontmatterValue } from '../src/core/skill-meta.js';
import { skillHash } from '../src/core/skill-hash.js';
import { buildArgv, templateProblems, tokenize, withCodexEvents } from '../src/core/execute-template.js';

test('.env：注释、引号、export 都能解析，且不覆盖已有环境变量', () => {
  const parsed = parseEnv([
    '# comment',
    'A=one',
    'export B="two words"',
    "C='three'",
    'D="line1\\nline2"',
    '',
  ].join('\n'));
  assert.deepEqual(parsed, { A: 'one', B: 'two words', C: 'three', D: 'line1\nline2' });

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skillapp-env-')), '.env');
  fs.writeFileSync(file, 'SKILLAPP_TEST_ENV=file\n');
  process.env.SKILLAPP_TEST_ENV = 'shell';
  try {
    const loaded = loadEnv(file);
    assert.equal(loaded.SKILLAPP_TEST_ENV, 'file');
    assert.equal(process.env.SKILLAPP_TEST_ENV, 'shell', '已存在的环境变量优先');
  } finally {
    delete process.env.SKILLAPP_TEST_ENV;
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('lark-cli 输出：跳过 JSON 前后的横幅与杂音，没有 JSON 时照旧报错', () => {
  assert.deepEqual(
    parseOutput('lark-cli v1.0.97 installed successfully\n{\n  "ok": true,\n  "data": { "fields": [] }\n}\n'),
    { ok: true, data: { fields: [] } },
  );
  assert.deepEqual(parseOutput('{"ok":true,"data":{}}\n（还有一行人看的提示）\n'), { ok: true, data: {} });
  assert.throws(() => parseOutput('命令执行失败：需要授权'), SyntaxError);
});

test('lark-cli 真进程：带横幅的 stdout 也能吃下', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillapp-lark-cli-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const cli = path.join(bin, 'lark-cli');
  fs.writeFileSync(cli, [
    '#!/bin/sh',
    "echo 'lark-cli v1.0.97 installed successfully'",
    'echo \'{"ok":true,"identity":"user","data":{"fields":[{"id":"fldP"}]}}\'',
  ].join('\n') + '\n');
  fs.chmodSync(cli, 0o755);

  const realPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${realPath}`;
  try {
    assert.deepEqual(lark(['base', '+field-list']).data.fields, [{ id: 'fldP' }]);
  } finally {
    process.env.PATH = realPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('frontmatter：普通值、引号、块标量都能读出来', () => {
  assert.equal(frontmatterValue('---\ndescription: 一句话\n---\n', 'description'), '一句话');
  assert.equal(frontmatterValue('---\ndescription: "带 冒号: 的值"\n---\n', 'description'), '带 冒号: 的值');
  assert.equal(frontmatterValue("---\ndescription: '单引号'\n---\n", 'description'), '单引号');
  assert.equal(frontmatterValue('---\ndescription: |\n  第一行\n  第二行\n---\n', 'description'), '第一行\n第二行');
  assert.equal(frontmatterValue('---\ndescription: >\n  第一行\n  第二行\n---\n', 'description'), '第一行 第二行');
});

test('frontmatter：缺字段返回 null，且只认顶层字段', () => {
  assert.equal(frontmatterValue('# 没有 frontmatter\n', 'description'), null);
  assert.equal(frontmatterValue('---\nname: x\n---\n', 'description'), null);
  assert.equal(frontmatterValue('---\ndescription:\n---\n', 'description'), null);
  assert.equal(frontmatterValue('---\nmetadata:\n  description: 子字段\nname: x\n---\n', 'description'), null);
});

test('cmd 分词：引号内的空白算同一个 argv，成对参数仍写成单个 token', () => {
  // prompt 型 Skill：整段自然语言指令必须是一个 argv，否则 codex exec 会报 unexpected argument
  assert.deepEqual(
    tokenize('codex exec --skip-git-repo-check -C {outdir} "读取并遵循{skill.entry}，内容={content}；留空或写 auto"'),
    ['codex', 'exec', '--skip-git-repo-check', '-C', '{outdir}', '读取并遵循{skill.entry}，内容={content}；留空或写 auto'],
  );
  // 单引号同样有效
  assert.deepEqual(tokenize("node -e 'a b'"), ['node', '-e', 'a b']);
  // 成对参数（{} 内部空白）与普通 token 的行为不变
  assert.deepEqual(tokenize('node {skill.entry} {--format format} -o {outdir}'), ['node', '{skill.entry}', '{--format format}', '-o', '{outdir}']);
});

test('cmd 拼装：引号里的 {key...} 展开成文本列表，可选值留空就是空串', () => {
  const vars = {
    skill: { entry: '/s/entry.js' },
    outdir: '/tmp/out',
    content: '三条笔记',
    refs: ['/tmp/a.png', '/tmp/b.png'],
    notes: undefined,
  };
  assert.deepEqual(
    buildArgv('node {skill.entry} "内容={content}；参考图={refs...}；备注={notes}"', vars),
    ['node', '/s/entry.js', '内容=三条笔记；参考图=/tmp/a.png /tmp/b.png；备注='],
  );
  // 文本里的 {key} 拿到数组就是逗号连接；一个都没有时不炸，渲染成空串
  assert.deepEqual(buildArgv('x "参考图={refs}"', vars), ['x', '参考图=/tmp/a.png, /tmp/b.png']);
  assert.deepEqual(buildArgv('x "参考图={refs...}"', { ...vars, refs: [] }), ['x', '参考图=']);
  // 位置参数的三种写法不受影响
  assert.deepEqual(buildArgv('node {skill.entry} {refs...} -o {outdir} {--fmt content}', vars),
    ['node', '/s/entry.js', '/tmp/a.png', '/tmp/b.png', '-o', '/tmp/out', '--fmt', '三条笔记']);
});

test('cmd 拼装：位置参数写错才报错（未定义 / 数组没带 ...）', () => {
  const vars = { refs: ['/tmp/a.png'], text: undefined };
  assert.throws(() => buildArgv('node {text}', vars), /\{text\} in cmd is undefined/);
  assert.throws(() => buildArgv('node {refs}', vars), /write \{refs\.\.\.\} to expand it/);
  assert.throws(() => buildArgv('node {text...}', vars), /not an array/);
  // 引号里的可选值留空不算错——这是 prompt 型 Skill 的常态
  assert.deepEqual(buildArgv('node "备注={text}"', vars), ['node', '备注=']);
});

test('运行前核对：cmd 语法错、变量错都在开跑前说清楚', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillapp-preflight-'));
  const skillDir = path.join(root, '.data', 'skills', 'ref');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# stub\n');
  const base = {
    skill: { path: 'skills/ref', hash: skillHash(skillDir), entry: 'SKILL.md' },
    target: { primary_field_id: 'fldP' },
    mapping: { cmd: '', inputs: [{ key: 'text', field_id: 'fldIn', type: 'text' }], outputs: [] },
  };
  const problemsFor = (cmd) => templateProblems({ ...base, mapping: { ...base.mapping, cmd } }, path.join(root, '.data'));

  assert.deepEqual(problemsFor('node {skill.entry} "{text}"'), [], '正常的 prompt 指令不该有问题');
  assert.match(problemsFor('node {skill.entry} "{--format}"').join('\n'), /malformed placeholder: \{--format\}/);
  assert.match(problemsFor('node {skill.entry} "{typo}"').join('\n'), /unknown variables:\n  - typo/);
  assert.match(problemsFor('node {skill.entry} {missing}').join('\n'), /Input is not mapped but cmd needs it:\n  - missing/);
  // 归档 / Skill 指纹不符同样在本地就拦下
  assert.match(templateProblems({ ...base, archived_at: '2026-01-01' }, path.join(root, '.data')).join('\n'), /Template is archived/);
  assert.match(templateProblems({ ...base, skill: { ...base.skill, hash: 'sha256:nope' } }, path.join(root, '.data')).join('\n'), /Skill hash mismatch/);
});

test('codex 事件流：只留 msg / cmd / error，答案取最后一条 agent 消息', () => {
  const events = createCodexEvents();
  const jsonl = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"先读 SKILL.md"}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \'cat SKILL.md\'","aggregated_output":"很长的一大段","exit_code":0}}',
    '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"读完了，开始生成"}}',
    '{"type":"error","message":"no model to draw with"}',
    '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"{\\"count\\":2}"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1}}',
  ].join('\n') + '\n';

  // 分片喂：切分点落在行中间（子进程的输出没有行边界保证）。
  let out = '';
  for (let i = 0; i < jsonl.length; i += 40) out += events.push(jsonl.slice(i, i + 40));
  out += events.flush();

  assert.equal(out, [
    "[cmd] /bin/zsh -lc 'cat SKILL.md'",
    '[msg] 读完了，开始生成',
    '[error] no model to draw with',
    '[msg] {"count":2}',
    '',
  ].join('\n'));
  assert.equal(events.finalMessage(), '{"count":2}');
  assert.equal(events.lastError(), 'no model to draw with');
});

test('codex 事件流：命令原样进 live.log，行内不截断', () => {
  const events = createCodexEvents();
  const command = `/bin/zsh -lc 'sqlite3 ~/.codex/logs_2.sqlite "select ts,level,target from logs where feedback_log_body like '%image_gen%' order by id desc limit 5"'`;
  const out = events.push(`${JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command } })}\n`);
  assert.equal(out, `[cmd] ${command}\n`, '排查问题时最碍事的就是行尾的 "..."');
  assert.ok(!out.includes('...'), '不该出现省略号');
});

test('codex 事件流：不是 JSON 的行原样透传，半行留到 flush', () => {
  const events = createCodexEvents();
  assert.equal(events.push('claude says hi\n还没写完的一行'), 'claude says hi\n');
  assert.equal(events.flush(), '还没写完的一行\n'); // 结尾没换行的那半行不能丢
  assert.equal(events.finalMessage(), null);
});

test('prompt 型 cmd 补 --json / --color never，已写的不重复加', () => {
  assert.deepEqual(
    withCodexEvents(['codex', 'exec', '-C', '/tmp', '读取并遵循 SKILL.md']),
    ['codex', 'exec', '--json', '--color', 'never', '-C', '/tmp', '读取并遵循 SKILL.md'],
  );
  assert.deepEqual(
    withCodexEvents(['codex', 'exec', '--json', '--color', 'always', '-C', '/tmp']),
    ['codex', 'exec', '--json', '--color', 'always', '-C', '/tmp'],
  );
  // 脚本型 Skill 的命令不动
  assert.deepEqual(withCodexEvents(['node', 'scripts/main.js', '--json']), ['node', 'scripts/main.js', '--json']);
});
