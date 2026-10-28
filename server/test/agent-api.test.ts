import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { DiagramEntry } from '@excalidraw-live/shared';
import type { SceneStore } from '../src/store.js';
import { Workspace } from '../src/workspace.js';
import { startServer, type CanvasServer } from '../src/http.js';
import { el, sleep } from './helpers.js';

let root: string;
let workspace: Workspace;
let diagram: DiagramEntry;
let store: SceneStore;
let server: CanvasServer;
let base: string;

const open = (dir: string) => Workspace.load({ dir: join(dir, 'diagrams'), debounceMs: 0, cursorsPath: join(dir, 'state', 'cursors.json') });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'xl-agent-'));
  workspace = await open(root);
  diagram = await workspace.create({ name: 'Main', kind: 'flow', owner: 'po' });
  store = await workspace.store(diagram.id);
  server = await startServer({ workspace, port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(server.http.address() as AddressInfo).port}`;
});
afterEach(async () => { await server.close(); });

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
const bind = (session: string, as: string) => call('POST', '/api/sessions', { session, diagramId: diagram.id, as });
const status = (as: string) => call('GET', `/api/diagrams/${diagram.id}/status?as=${as}`).then((r) => r.body);
const changes = (body: Record<string, unknown>) => call('POST', `/api/diagrams/${diagram.id}/changes`, body).then((r) => r.body);

describe('sessions', () => {
  it('gives the writer lease only to the owner role', async () => {
    expect((await bind(`mcp-${process.pid}`, 'po')).body).toMatchObject({ mode: 'writer', rev: 0 });
    expect((await bind('mcp-other', 'swe')).body).toMatchObject({ mode: 'reader' });
    expect(() => workspace.assertWrite('mcp-other', diagram.id)).toThrow(/read-only/);
  });

  it('takes the lease back from a session whose process has died', async () => {
    await bind('mcp-999999999', 'po');
    expect((await bind(`mcp-${process.pid}`, 'po')).body).toMatchObject({ mode: 'writer' });
  });

  it('releases the lease when the session ends', async () => {
    await bind(`mcp-${process.pid}`, 'po');
    expect((await call('DELETE', `/api/sessions/mcp-${process.pid}`)).status).toBe(200);
    expect((await bind(`mcp-${process.pid + 1}`, 'po')).body).toMatchObject({ mode: 'writer' });
  });
});

describe('unread changes', () => {
  it('counts changes since the last read and clears them once read', async () => {
    await bind(`mcp-${process.pid}`, 'po');
    expect(await status('po')).toEqual({ unread: 0, fromRev: 0, toRev: 0, name: 'Main' });

    store.upsert([el('a')]);
    store.upsert([el('b', { x: 200 })]);
    store.upsert([el('a', { version: 2, x: 40 })]);
    expect(await status('po')).toEqual({ unread: 2, fromRev: 0, toRev: 3, name: 'Main' });

    const read = await changes({ as: 'po' });
    expect(read).toMatchObject({ since: 0, rev: 3, truncated: false, reset: false });
    expect(read.report).toMatch(/^rev 0→3: 2 elements changed \(human 2\)/);
    expect(await status('po')).toMatchObject({ unread: 0, fromRev: 3, toRev: 3 });
  });

  it("does not count the owner's own agent writes as unread, but readers see them", async () => {
    await bind(`mcp-${process.pid}`, 'po');
    await bind('mcp-other', 'swe');
    store.upsert([el('a')], 'agent');
    expect((await status('po')).unread).toBe(0);
    expect((await status('swe')).unread).toBe(1);
  });

  it('leaves the cursor alone when `since` is given, and filters by origin', async () => {
    await bind(`mcp-${process.pid}`, 'po');
    store.upsert([el('a')]);
    store.upsert([el('b')], 'agent');
    const agentOnly = await changes({ as: 'po', since: 0, origin: 'agent' });
    expect(agentOnly.report.split('\n')).toEqual(['rev 0→2: 1 element changed (agent 1)', '+ rectangle [b] @(0,0) 100x50 · agent']);
    expect((await status('po')).unread).toBe(1);
  });

  it('keeps read cursors across a restart', async () => {
    await bind(`mcp-${process.pid}`, 'po');
    store.upsert([el('a')]);
    await changes({ as: 'po' });
    store.upsert([el('b')]);
    await server.close();

    workspace = await open(root);
    server = await startServer({ workspace, port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(server.http.address() as AddressInfo).port}`;
    expect(await status('po')).toMatchObject({ unread: 1, fromRev: 1, toRev: 2 });
  });

  it('returns the live scene without tombstones', async () => {
    store.upsert([el('a'), el('b', { isDeleted: true })]);
    const { body } = await call('GET', `/api/diagrams/${diagram.id}/scene`);
    expect(body.rev).toBe(1);
    expect(body.elements.map((e: { id: string }) => e.id)).toEqual(['a']);
  });
});

describe('wait for changes', () => {
  const wait = (body: Record<string, unknown>) => call('POST', `/api/diagrams/${diagram.id}/wait`, { as: 'po', ...body }).then((r) => r.body);

  function browser(idle = true) {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/${diagram.id}`);
    const presence = (p: { idle: boolean; editingId?: string | null }) =>
      ws.send(JSON.stringify({ t: 'presence', clientId: 'tab', selectedIds: [], editingId: null, ...p }));
    return new Promise<{ ws: WebSocket; presence: typeof presence }>((resolve) =>
      ws.on('open', () => { presence({ idle }); resolve({ ws, presence }); }));
  }

  it('says so when no browser has the board open', async () => {
    expect(await wait({ timeoutSeconds: 1 })).toMatchObject({ status: 'no_browser' });
  });

  it('times out when nothing changes', async () => {
    await browser();
    expect(await wait({ timeoutSeconds: 1 })).toMatchObject({ status: 'timeout', rev: 0 });
  });

  it('returns once the person stops drawing, and moves the cursor', async () => {
    await bind(`mcp-${process.pid}`, 'po');
    const tab = await browser();
    const pending = wait({ idleSeconds: 1, timeoutSeconds: 10 });
    await sleep(100);
    tab.presence({ idle: false });
    store.upsert([el('a')]);
    await sleep(300);
    store.upsert([el('a', { version: 2, x: 30 })]);
    const lastEdit = Date.now();
    await sleep(300);
    tab.presence({ idle: true });

    const result = await pending;
    expect(result).toMatchObject({ status: 'changes', rev: 2 });
    expect(result.report).toMatch(/^rev 0→2: 1 element changed/);
    expect(Date.now() - lastEdit).toBeGreaterThanOrEqual(1000);
    expect((await status('po')).unread).toBe(0);
  });

  it('ignores changes from other origins', async () => {
    await browser();
    const pending = wait({ timeoutSeconds: 1 });
    store.upsert([el('a')], 'agent');
    expect(await pending).toMatchObject({ status: 'timeout' });
  });
});

describe('agent writes over HTTP', () => {
  const apply = (body: Record<string, unknown>) => call('POST', `/api/diagrams/${diagram.id}/apply`, body);

  it('applies for the writer and sends the change to open browsers', async () => {
    await bind(`mcp-${process.pid}`, 'po');
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/${diagram.id}`);
    const msgs: { t: string; origin?: string; elements?: { id: string }[] }[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
    await new Promise((r) => ws.on('open', r));

    const r = await apply({ session: `mcp-${process.pid}`, ops: [{ op: 'create', type: 'rectangle', id: 'n' }] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ rev: 1, applied: [{ id: 'n' }], conflicts: [] });
    await sleep(100);
    const patch = msgs.find((m) => m.t === 'scene_patch');
    expect(patch?.origin).toBe('agent');
    expect(patch?.elements?.map((e) => e.id)).toContain('n');
    ws.close();
  });

  it('refuses a read-only session and leaves the board alone', async () => {
    await bind(`mcp-${process.pid}`, 'po');
    await bind('mcp-other', 'swe');
    const r = await apply({ session: 'mcp-other', ops: [{ op: 'create', type: 'rectangle' }] });
    expect(r).toEqual({ status: 400, body: { error: `${diagram.id} is read-only for this session` } });
    expect(store.revision).toBe(0);
  });

  it('reports a conflict with an element selected in a browser', async () => {
    await bind(`mcp-${process.pid}`, 'po');
    store.upsert([el('a')]);
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/${diagram.id}`);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ t: 'presence', clientId: 'tab', selectedIds: ['a'], editingId: null, idle: true }));
    await sleep(100);
    const r = await apply({ session: `mcp-${process.pid}`, ops: [{ op: 'delete', id: 'a' }] });
    expect(r.body.conflicts).toEqual([{ op: 0, id: 'a', reason: 'selected' }]);
    ws.close();
  });

  it('accepts a proposal for the writer, and refuses a read-only session', async () => {
    await bind(`mcp-${process.pid}`, 'po');
    await bind('mcp-other', 'swe');
    const made = await apply({ session: `mcp-${process.pid}`, ops: [{ op: 'create', type: 'rectangle', id: 'p' }] });
    const accept = (body: Record<string, unknown>) => call('POST', `/api/diagrams/${diagram.id}/accept`, body);

    expect(await accept({ session: 'mcp-other', frameId: made.body.frameId })).toEqual({ status: 400, body: { error: `${diagram.id} is read-only for this session` } });
    const r = await accept({ session: `mcp-${process.pid}`, frameId: made.body.frameId });
    expect(r).toEqual({ status: 200, body: { rev: 3, accepted: ['p'], conflicts: [], frameDeleted: true } });
    expect(store.get('p')).toMatchObject({ frameId: null, strokeColor: '#2f9e44' });
    expect((await accept({ session: `mcp-${process.pid}`, frameId: 'nope' })).body).toEqual({ error: '[nope] is not a frame on this board' });
  });
});
