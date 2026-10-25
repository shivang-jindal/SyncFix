#!/usr/bin/env node
/**
 * Development launcher: runs the API, the worker and the Vite dev server
 * together with prefixed, colour-free output. Ctrl+C stops all of them.
 *
 * The embedded PGlite database is a single-writer engine: it locks its data
 * directory, so a separate worker process cannot open the same database the
 * API already has. In that mode the worker runs *inside* the API process
 * (`WORKER_IN_API=true`). With a real PostgreSQL `DATABASE_URL`, the worker
 * runs as its own process, which is how production is deployed.
 *
 * Usage: npm run dev
 */

import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** Reads DATABASE_URL from the environment or the repository `.env`. */
function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const candidate of [resolve(root, '.env'), resolve(root, 'server', '.env')]) {
    if (!existsSync(candidate)) continue;
    for (const rawLine of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = /^DATABASE_URL\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const value = match[1].trim().replace(/^["']|["']$/g, '');
      if (value) return value;
    }
  }
  return '';
}

const embeddedDatabase = databaseUrl() === '';

const tasks = [
  {
    name: 'api   ',
    color: '\u001b[36m',
    args: ['run', 'dev:server'],
    env: embeddedDatabase ? { WORKER_IN_API: 'true' } : {},
  },
  ...(embeddedDatabase
    ? []
    : [{ name: 'worker', color: '\u001b[35m', args: ['run', 'dev:worker'], env: {} }]),
  { name: 'web   ', color: '\u001b[32m', args: ['run', 'dev:client'], env: {} },
];

const children = [];
let shuttingDown = false;

function prefixStream(stream, name, color) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      process.stdout.write(`${color}${name}${'\u001b[0m'} | ${line}\n`);
    }
  });
}

for (const task of tasks) {
  const child = spawn(npm, task.args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...task.env },
    shell: true,
  });
  prefixStream(child.stdout, task.name, task.color);
  prefixStream(child.stderr, task.name, task.color);
  child.on('exit', (code) => {
    if (shuttingDown) return;
    process.stderr.write(`${task.color}${task.name}${'\u001b[0m'} exited with code ${code}. Stopping everything.\n`);
    shutdown(code ?? 1);
  });
  children.push(child);
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  setTimeout(() => process.exit(code), 500).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

process.stdout.write(
  [
    'SyncFix development stack starting.',
    '  web   http://localhost:5173',
    '  api   http://localhost:4000/api/v1/health/ready',
    embeddedDatabase
      ? '  worker  runs inside the API process (embedded PGlite is single-writer)'
      : '  worker  separate process (external PostgreSQL)',
    '',
  ].join('\n'),
);
