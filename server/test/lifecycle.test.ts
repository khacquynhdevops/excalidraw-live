// Runs the bundled server (runtime/server.mjs in the init skill): `npm run build` first.
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { ensureServer, statePath } from '@excalidraw-live/shared/ensureServer';
import { el, sleep } from './helpers.js';

const pids: number[] = [];
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

const serverEntry = fileURLToPath(new URL('../../skills/setup-excalidraw-live-multiagent/runtime/server.mjs', import.meta.url));
const project = () => mkdtempSync(join(tmpdir(), 'xl-proj-'));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function ensure(dir: string) {
  const s = await ensureServer(dir, { serverEntry });
  pids.push(s.pid);
  return s;
}

describe('ensureServer', () => {
  it('starts a server for the project and records it in server.json', async () => {
    const dir = project();
    const s = await ensure(dir);
    expect(s.started).toBe(true);
    const state = JSON.parse(readFileSync(statePath(dir), 'utf8'));
    expect(state).toMatchObject({ port: s.port, pid: s.pid });
    expect(typeof state.startedAt).toBe('string');
    const health = await (await fetch(`${s.url}/health`)).json();
    expect(health).toMatchObject({ ok: true, pid: s.pid, diagramsDir: join(dir, 'docs', 'diagrams') });
  });

  it('reuses the running server: two calls, one process', async () => {
    const dir = project();
    const [a, b] = await Promise.all([ensure(dir), ensure(dir)]);
    const c = await ensure(dir);
    expect(new Set([a.pid, b.pid, c.pid]).size).toBe(1);
    expect(c.started).toBe(false);
  });

  it('gives two projects their own server on different ports', async () => {
    const [a, b] = await Promise.all([ensure(project()), ensure(project())]);
    expect(a.pid).not.toBe(b.pid);
    expect(a.port).not.toBe(b.port);
  });

  it('replaces a stale server.json whose process is gone', async () => {
    const dir = project();
    mkdirSync(join(dir, '.claude', 'skills', 'setup-excalidraw-live-multiagent', 'state'), { recursive: true });
    writeFileSync(statePath(dir), JSON.stringify({ port: 1, pid: 999999, startedAt: 'x' }));
    const s = await ensure(dir);
    expect(s.started).toBe(true);
    expect(s.pid).not.toBe(999999);
  });
});

describe('server shutdown', () => {
  it('SIGTERM mid-debounce: last stroke reaches the file and server.json is removed', async () => {
    const dir = project();
    const s = await ensure(dir);
    const res = await fetch(`${s.url}/api/diagrams`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Last', kind: 'free', owner: 'po' })
    });
    const d = await res.json();

    const ws = new WebSocket(`${s.url.replace('http', 'ws')}/ws/${d.id}`);
    await new Promise((r) => ws.once('message', r)); // scene_init
    ws.send(JSON.stringify({ t: 'client_patch', clientId: 't', baseRev: 0, elements: [el('last')] }));
    await sleep(50); // applied, but the 500ms save has not fired
    process.kill(s.pid, 'SIGTERM');

    for (let i = 0; i < 50 && alive(s.pid); i++) await sleep(100);
    expect(alive(s.pid)).toBe(false);
    const ids = JSON.parse(readFileSync(join(dir, 'docs', 'diagrams', d.file), 'utf8')).elements.map((e: { id: string }) => e.id);
    expect(ids).toEqual(['last']);
    expect(existsSync(statePath(dir))).toBe(false);
  });
});
