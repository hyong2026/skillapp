/**
 * install-deps.js — Skill 的依赖安装（Node / Python）
 *
 * 依赖一律装进 **Skill 自己的目录**（`node_modules` / `.venv`）：Node 的 ESM `import` 不吃
 * `NODE_PATH`，只有入口祖先链上的 `node_modules` 才算数 —— 想"每个 Skill 互不干扰"就只能这么放；
 * Python 同理给它一个自己的 venv，运行时由执行器把 venv 的 bin 前置到 `PATH`（见 venvEnv）。
 *
 * 只认声明文件：Node 要 `package.json`，Python 要 `requirements.txt` 或 `pyproject.toml`。
 * 没有声明就什么都不装（prompt 型 Skill 本来也没有依赖），也不去猜。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readJson, atomicWriteJson } from './json-file.js';
import { AppError } from './errors.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function installTimeoutMs() {
  const value = Number.parseInt(process.env.SKILLAPP_INSTALL_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

/** 声明文件 → 该装什么。没有声明就是 null（不装，也不算错）。 */
function dependencyPlan(skillDir) {
  const exists = (name) => fs.existsSync(path.join(skillDir, name));
  if (exists('package.json')) {
    const locked = exists('package-lock.json') || exists('npm-shrinkwrap.json');
    return { manager: 'npm', args: locked ? ['ci'] : ['install'] };
  }
  if (exists('requirements.txt')) return { manager: 'pip', args: ['-r', 'requirements.txt'] };
  if (exists('pyproject.toml')) return { manager: 'pip', args: ['.'] };
  return null;
}

/** 装没装：npm 看 `node_modules`，pip 看 `.venv`（文件系统是唯一真相，不另记状态）。 */
function hasInstalled(skillDir, manager) {
  return manager === 'npm'
    ? fs.existsSync(path.join(skillDir, 'node_modules'))
    : fs.existsSync(path.join(skillDir, '.venv', 'bin'));
}

/** Python Skill 的 venv：把 bin 前置到 PATH，`python3` 就落在它自己的解释器上。 */
function venvEnv(venvDir) {
  if (!venvDir || !fs.existsSync(path.join(venvDir, 'bin'))) return {};
  return {
    VIRTUAL_ENV: venvDir,
    PATH: `${path.join(venvDir, 'bin')}${path.delimiter}${process.env.PATH || ''}`,
  };
}

function runStep(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk) => { output = (output + chunk.toString('utf8')).slice(-8000); };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, output: `${output}\n${error.message}`.trim(), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output: output.trim(), timedOut });
    });
  });
}

/** npm 一律 `--ignore-scripts`：postinstall 就是执行第三方代码。 */
function installSteps(skillDir, plan) {
  if (plan.manager === 'npm') {
    const registry = process.env.SKILLAPP_NPM_REGISTRY ? [`--registry=${process.env.SKILLAPP_NPM_REGISTRY}`] : [];
    return [['npm', [...plan.args, '--ignore-scripts', '--no-audit', '--no-fund', ...registry]]];
  }
  const python = path.join(skillDir, '.venv', 'bin', 'python');
  const index = process.env.SKILLAPP_PIP_INDEX_URL ? ['-i', process.env.SKILLAPP_PIP_INDEX_URL] : [];
  return [
    ['python3', ['-m', 'venv', '.venv']],
    [python, ['-m', 'pip', 'install', '--disable-pip-version-check', ...plan.args, ...index]],
  ];
}

/** 装依赖；失败抛 `DEPS_INSTALL_FAILED`，带上最后几行输出（排查就靠它）。 */
async function installDependencies(skillDir, { timeoutMs = installTimeoutMs(), onLog = () => {} } = {}) {
  const plan = dependencyPlan(skillDir);
  if (!plan) return { state: 'none', manager: null };
  for (const [command, args] of installSteps(skillDir, plan)) {
    onLog(`${command} ${args.join(' ')}`);
    const result = await runStep(command, args, { cwd: skillDir, timeoutMs });
    if (result.code === 0) continue;
    const tail = String(result.output || '').split('\n').filter(Boolean).slice(-5).join('\n');
    const why = result.timedOut ? `timed out after ${timeoutMs}ms` : `exited with ${result.code ?? 'no code'}`;
    throw new AppError(
      'DEPS_INSTALL_FAILED',
      `Dependency install failed (${plan.manager}, ${why}):\n${tail || '(no output)'}`,
      'Check the network / registry, or the Skill’s dependency declarations, then retry',
      502,
    );
  }
  return { state: 'ok', manager: plan.manager };
}

/** 把依赖状态记进 source.json：给人看，不参与判定（判定只看文件系统）。 */
function recordDeps(skillDir, deps) {
  const file = path.join(skillDir, 'source.json');
  if (!fs.existsSync(file)) return;
  atomicWriteJson(file, { ...readJson(file), deps: { ...deps, checked_at: new Date().toISOString() } });
}

/** 首次使用时确保依赖在位：装过直接过（快路径），没装就装，装失败记下原因再抛。 */
async function ensureDependencies(skillDir, options = {}) {
  const plan = dependencyPlan(skillDir);
  if (!plan) return { state: 'none', manager: null };
  if (hasInstalled(skillDir, plan.manager)) return { state: 'ok', manager: plan.manager };
  try {
    const done = await installDependencies(skillDir, options);
    recordDeps(skillDir, done);
    return done;
  } catch (error) {
    recordDeps(skillDir, { state: 'failed', manager: plan.manager, error: error.message });
    throw error;
  }
}

export { dependencyPlan, hasInstalled, venvEnv, installDependencies, ensureDependencies };
