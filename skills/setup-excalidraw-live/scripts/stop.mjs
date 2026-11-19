#!/usr/bin/env node
// Stop the project's canvas server (the project in the working directory);
// setup.mjs runs it for --stop and --restart. SIGTERM makes it flush pending
// saves and remove server.json. Needs nothing but Node.
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const project = process.cwd();
// Versions before 0.1.2 kept server.json under .claude/; a server they started
// may still run and must stop too, or setup would start a second one.
const statePaths = [join(project, '.excalidraw-live', 'server.json'), join(project, '.claude', 'excalidraw-live', 'state', 'server.json')];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stopped = [];
for (const statePath of statePaths) {
  let state;
  try {
    state = JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    continue;
  }

  // Only signal the pid if it is still our server: pids get reused.
  const health = await fetch(`http://127.0.0.1:${state.port}/health`, { signal: AbortSignal.timeout(1000) })
    .then((r) => r.json(), () => null);
  if (health?.pid !== state.pid) {
    console.log(`${relative(project, statePath)} names pid ${state.pid} on port ${state.port}, but no canvas server answers there; nothing to stop`);
    continue;
  }

  process.kill(state.pid, 'SIGTERM');
  const alive = () => { try { process.kill(state.pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 100 && (alive() || existsSync(statePath)); i++) await sleep(100);
  if (alive()) {
    console.error(`canvas server (pid ${state.pid}) did not stop within 10s`);
    process.exit(1);
  }
  stopped.push(state);
}

if (!stopped.length) {
  console.log('no canvas server is running for this project');
  process.exit(0);
}

for (const state of stopped) console.log(`stopped canvas server (pid ${state.pid}, port ${state.port}); the diagrams are saved:`);
const dir = join(project, 'docs', 'diagrams');
const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.excalidraw'));
for (const f of files.sort()) {
  const m = await stat(join(dir, f));
  console.log(`  docs/diagrams/${f} · last written ${m.mtime.toLocaleString()}`);
}
