#!/usr/bin/env node
import { spawn } from 'node:child_process';
import process from 'node:process';

const mode = process.argv[2] ?? 'start';
if (mode !== 'dev' && mode !== 'start') {
  console.error('用法: node scripts/run-all.mjs <dev|start>');
  process.exit(1);
}

const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const services =
  mode === 'dev'
    ? [
        { name: 'web', args: ['-C', 'apps/web', 'dev'] },
        { name: 'mirror-service', args: ['-C', 'apps/mirror-service', 'dev'] },
      ]
    : [
        { name: 'web', args: ['-C', 'apps/web', 'start'] },
        { name: 'mirror-service', args: ['-C', 'apps/mirror-service', 'start'] },
      ];

const children = [];
let isShuttingDown = false;

function shutdown(signal, exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }

  setTimeout(() => process.exit(exitCode), 500).unref();
}

for (const service of services) {
  const child = spawn(pnpmBin, service.args, {
    stdio: 'inherit',
    env: process.env,
  });

  children.push(child);

  child.on('exit', (code, signal) => {
    if (isShuttingDown) return;
    const exitCode = typeof code === 'number' ? code : 1;
    console.error(`[run-all] ${service.name} 已退出 (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
    shutdown('SIGTERM', exitCode);
  });
}

process.on('SIGINT', () => shutdown('SIGINT', 0));
process.on('SIGTERM', () => shutdown('SIGTERM', 0));
