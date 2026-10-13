#!/usr/bin/env node
import { loadEnv } from '../core/load-env.js';

loadEnv();

// .env 必须先于路径配置生效，所以业务模块用动态 import 加载。
const { createServer } = await import('./app.js');
const { DATA_DIR } = await import('../core/paths.js');

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

const USAGE = `用法: node src/server/index.js [选项]

选项:
  --host <host>      监听地址，默认 127.0.0.1
  --port <port>      监听端口，默认 4173
  --token <token>    Basic Auth 密码；也可用 SKILLAPP_WEB_TOKEN
  --root <path>      内容根目录，默认 .data/
  --insecure         非本机监听且未设置 token 时允许启动
  -h, --help         显示本帮助`;

function parseArgv(argv) {
  const out = {
    host: '127.0.0.1',
    port: 4173,
    token: process.env.SKILLAPP_WEB_TOKEN || null,
    root: DATA_DIR,
    insecure: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--host') out.host = argv[++i];
    else if (arg === '--port') out.port = Number(argv[++i]);
    else if (arg === '--token') out.token = argv[++i];
    else if (arg === '--root') out.root = argv[++i];
    else if (arg === '--insecure') out.insecure = true;
    else if (arg === '-h' || arg === '--help') out.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  return out;
}

function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) {
    throw new Error(`端口不合法: ${args.port}`);
  }
  if (!LOOPBACK.has(args.host) && !args.token && !args.insecure) {
    throw new Error('非本机监听需要 --token，或显式加 --insecure');
  }

  const server = createServer({ root: args.root, token: args.token });
  server.on('error', (err) => {
    console.error(`❌ Web 服务启动失败: ${err.message}`);
    process.exitCode = 1;
  });
  server.listen(args.port, args.host, () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : args.port;
    console.log(`SkillApp Web 已启动（初始化与执行控制台）`);
    console.log(`  地址: http://${args.host}:${port}`);
    console.log(`  鉴权: ${args.token ? '已开启' : '未开启'}`);
  });

  const close = () => {
    server.taskRunner?.shutdown();
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}

try {
  main();
} catch (err) {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
}
