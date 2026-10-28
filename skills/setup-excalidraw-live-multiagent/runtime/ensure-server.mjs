import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// shared/src/ensureServer.ts
import { spawn } from "node:child_process";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
var STATE_DIR = join(".claude", "skills", "setup-excalidraw-live-multiagent", "state");
var LOCK_STALE_MS = 15e3;
var stateDir = (projectDir) => join(projectDir, STATE_DIR);
var statePath = (projectDir) => join(stateDir(projectDir), "server.json");
var diagramsDir = (projectDir) => join(projectDir, "docs", "diagrams");
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function findServer(projectDir) {
  let state;
  try {
    state = JSON.parse(await readFile(statePath(projectDir), "utf8"));
  } catch {
    return null;
  }
  const url = `http://127.0.0.1:${state.port}`;
  try {
    const health = await (await fetch(`${url}/health`, { signal: AbortSignal.timeout(1e3) })).json();
    if (health.ok && health.pid === state.pid) return { url, port: state.port, pid: state.pid, started: false };
  } catch {
  }
  return null;
}
async function ensureServer(projectDir, opts = {}) {
  const deadline = Date.now() + (opts.timeoutMs ?? 15e3);
  const lock = join(projectDir, STATE_DIR, "spawn.lock");
  await mkdir(join(projectDir, STATE_DIR), { recursive: true });
  while (Date.now() < deadline) {
    const live = await findServer(projectDir);
    if (live) return live;
    let fh;
    try {
      fh = await open(lock, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > LOCK_STALE_MS) await unlink(lock).catch(() => {
      });
      await sleep(100);
      continue;
    }
    try {
      await fh.close();
      const again = await findServer(projectDir);
      if (again) return again;
      const pid = await spawnServer(projectDir, opts.serverEntry);
      while (Date.now() < deadline) {
        const live2 = await findServer(projectDir);
        if (live2?.pid === pid) return { ...live2, started: true };
        await sleep(100);
      }
      throw new Error(`canvas server did not start in time; see ${join(projectDir, STATE_DIR, "server.log")}`);
    } finally {
      await unlink(lock).catch(() => {
      });
    }
  }
  throw new Error("timed out waiting for the canvas server");
}
async function spawnServer(projectDir, entry) {
  const script = entry ?? fileURLToPath(new URL("./server.mjs", import.meta.url));
  const log = await open(join(projectDir, STATE_DIR, "server.log"), "a");
  const env = { ...process.env, PROJECT_DIR: projectDir, DIAGRAMS_DIR: diagramsDir(projectDir) };
  delete env.PORT;
  const child = spawn(process.execPath, [script], { detached: true, stdio: ["ignore", log.fd, log.fd], env });
  child.unref();
  await log.close();
  return child.pid;
}
export {
  diagramsDir,
  ensureServer,
  findServer,
  stateDir,
  statePath
};
