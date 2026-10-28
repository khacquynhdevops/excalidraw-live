// Node only (not exported from the package index, which the browser uses).
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// One canvas server per project. While it runs it records itself in
// <projectDir>/.claude/skills/setup-excalidraw-live-multiagent/state/server.json.
export interface ServerState {
  port: number;
  pid: number;
  startedAt: string;
}

export interface RunningServer {
  url: string;
  port: number;
  pid: number;
  // true when this call spawned it
  started: boolean;
}

export interface EnsureOptions {
  // Server entry; defaults to server.mjs next to this file in the skill's runtime/.
  serverEntry?: string;
  timeoutMs?: number;
}

// Runtime state stays inside the setup skill, so the only thing the tool adds
// outside .claude/ is the drawings. `npx skills update` replaces the skill
// folder, state included: stop the server first.
const STATE_DIR = join('.claude', 'skills', 'setup-excalidraw-live-multiagent', 'state');
const LOCK_STALE_MS = 15_000;

export const stateDir = (projectDir: string) => join(projectDir, STATE_DIR);
export const statePath = (projectDir: string) => join(stateDir(projectDir), 'server.json');
export const diagramsDir = (projectDir: string) => join(projectDir, 'docs', 'diagrams');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The server named in server.json, if it answers /health as that same pid.
export async function findServer(projectDir: string): Promise<RunningServer | null> {
  let state: ServerState;
  try {
    state = JSON.parse(await readFile(statePath(projectDir), 'utf8'));
  } catch {
    return null;
  }
  const url = `http://127.0.0.1:${state.port}`;
  try {
    const health = await (await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })).json();
    if (health.ok && health.pid === state.pid) return { url, port: state.port, pid: state.pid, started: false };
  } catch {
    // not answering
  }
  return null;
}

// Return the project's canvas server, starting it (detached, so it outlives
// the calling session) when none is alive. Concurrent callers are serialised
// by a lock file, so a project never gets two servers.
export async function ensureServer(projectDir: string, opts: EnsureOptions = {}): Promise<RunningServer> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  const lock = join(projectDir, STATE_DIR, 'spawn.lock');
  await mkdir(join(projectDir, STATE_DIR), { recursive: true });

  while (Date.now() < deadline) {
    const live = await findServer(projectDir);
    if (live) return live;

    let fh;
    try {
      fh = await open(lock, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Someone else is starting it; a lock left by a crashed caller expires.
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > LOCK_STALE_MS) await unlink(lock).catch(() => {});
      await sleep(100);
      continue;
    }

    try {
      await fh.close();
      const again = await findServer(projectDir);
      if (again) return again;
      const pid = await spawnServer(projectDir, opts.serverEntry);
      while (Date.now() < deadline) {
        const live = await findServer(projectDir);
        if (live?.pid === pid) return { ...live, started: true };
        await sleep(100);
      }
      throw new Error(`canvas server did not start in time; see ${join(projectDir, STATE_DIR, 'server.log')}`);
    } finally {
      await unlink(lock).catch(() => {});
    }
  }
  throw new Error('timed out waiting for the canvas server');
}

async function spawnServer(projectDir: string, entry?: string): Promise<number> {
  const script = entry ?? fileURLToPath(new URL('./server.mjs', import.meta.url));
  const log = await open(join(projectDir, STATE_DIR, 'server.log'), 'a');
  const env: NodeJS.ProcessEnv = { ...process.env, PROJECT_DIR: projectDir, DIAGRAMS_DIR: diagramsDir(projectDir) };
  delete env.PORT; // pick a free port
  const child = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', log.fd, log.fd], env });
  child.unref();
  await log.close();
  return child.pid!;
}
