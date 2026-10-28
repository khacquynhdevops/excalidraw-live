import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { ClientMsg, ServerMsg } from '@excalidraw-live/shared';
import type { DiagramEntry } from '@excalidraw-live/shared';
import type { SceneStore } from '../src/store.js';
import { Workspace } from '../src/workspace.js';
import { startServer, type CanvasServer } from '../src/http.js';
import { el, sleep } from './helpers.js';

// A test client that queues every server message.
class Client {
  ws: WebSocket;
  inbox: ServerMsg[] = [];
  private waiters: (() => void)[] = [];
  constructor(url: string, readonly id: string, origin?: string) {
    this.ws = new WebSocket(url, origin ? { origin } : {});
    this.ws.on('message', (d) => {
      this.inbox.push(JSON.parse(String(d)));
      this.waiters.splice(0).forEach((w) => w());
    });
  }
  async next(t: ServerMsg['t']): Promise<ServerMsg> {
    for (;;) {
      const i = this.inbox.findIndex((m) => m.t === t);
      if (i >= 0) return this.inbox.splice(i, 1)[0];
      await new Promise<void>((r, j) => {
        this.waiters.push(r);
        setTimeout(() => j(new Error(`timeout waiting for ${t}`)), 2000);
      });
    }
  }
  send(msg: Omit<Extract<ClientMsg, { t: 'client_patch' }>, 'clientId' | 't' | 'baseRev'>) {
    this.ws.send(JSON.stringify({ t: 'client_patch', clientId: this.id, baseRev: 0, ...msg }));
  }
}

let workspace: Workspace;
let diagram: DiagramEntry;
let store: SceneStore;
let server: CanvasServer;
let base: string;
let url: string;
let path: string;

beforeEach(async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'xl-ws-')), 'diagrams');
  workspace = await Workspace.load({ dir, debounceMs: 0 });
  diagram = await workspace.create({ name: 'Main', kind: 'free', owner: 'po' });
  store = await workspace.store(diagram.id);
  path = join(dir, diagram.file);
  server = await startServer({ workspace, port: 0, host: '127.0.0.1' });
  base = `127.0.0.1:${(server.http.address() as AddressInfo).port}`;
  url = `ws://${base}/ws/${diagram.id}`;
});
afterEach(async () => { await server.close(); });

describe('canvas WebSocket', () => {
  it('sends the current scene on connect', async () => {
    store.upsert([el('a')]);
    const c = new Client(url, 'c');
    const init = await c.next('scene_init');
    expect(init).toMatchObject({ rev: 1, elements: [{ id: 'a' }] });
  });

  it('two clients drawing at once both keep their elements', async () => {
    const a = new Client(url, 'A');
    const b = new Client(url, 'B');
    await a.next('scene_init');
    await b.next('scene_init');

    a.send({ elements: [el('fromA')] });
    b.send({ elements: [el('fromB')] });

    expect(await b.next('scene_patch')).toMatchObject({ origin: 'human', elements: [{ id: 'fromA' }] });
    expect(await a.next('scene_patch')).toMatchObject({ origin: 'human', elements: [{ id: 'fromB' }] });

    // A patch from A that does not mention fromB must not delete it.
    a.send({ elements: [el('fromA', { version: 2, x: 99 })] });
    await b.next('scene_patch');
    expect(store.get('fromB')?.isDeleted).toBe(false);

    await store.idle();
    const ids = JSON.parse(readFileSync(path, 'utf8')).elements.map((e: { id: string }) => e.id).sort();
    expect(ids).toEqual(['fromA', 'fromB']);
  });

  it('does not echo a patch back to its sender', async () => {
    const a = new Client(url, 'A');
    const b = new Client(url, 'B');
    await a.next('scene_init');
    await b.next('scene_init');
    a.send({ elements: [el('x')] });
    await b.next('scene_patch');
    expect(a.inbox).toEqual([]);
  });

  it('tells the sender which elements lost, with the server copy', async () => {
    store.upsert([el('x', { version: 9, x: 1 })]);
    const a = new Client(url, 'A');
    await a.next('scene_init');
    a.send({ elements: [el('x', { version: 3, x: 2 })] });
    expect(await a.next('patch_rejected')).toMatchObject({ elements: [{ id: 'x', version: 9, x: 1 }] });
  });

  it('relays new files and drops ones over 2MB', async () => {
    const a = new Client(url, 'A');
    const b = new Client(url, 'B');
    await a.next('scene_init');
    await b.next('scene_init');
    const small = { id: 's', mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA' };
    const big = { id: 'b', mimeType: 'image/png', dataURL: 'data:image/png;base64,' + 'A'.repeat(3_000_000) };
    a.send({ elements: [el('img', { type: 'image', fileId: 's' })], files: { s: small, b: big } });
    const msg = await b.next('scene_patch');
    expect(msg.t === 'scene_patch' && Object.keys(msg.files ?? {})).toEqual(['s']);
    expect(Object.keys(store.getFiles())).toEqual(['s']);
  });

  it('records presence per client', async () => {
    const a = new Client(url, 'A');
    await a.next('scene_init');
    a.ws.send(JSON.stringify({ t: 'presence', clientId: 'A', editingId: 't1', selectedIds: ['t1'], idle: false }));
    await new Promise((r) => setTimeout(r, 50));
    expect(server.presence(diagram.id)?.get('A')).toEqual({ editingId: 't1', selectedIds: ['t1'], idle: false });
  });

  it('refuses connections from other web origins', async () => {
    const evil = new Client(url, 'E', 'https://evil.example');
    await expect(new Promise((r, j) => { evil.ws.on('open', r); evil.ws.on('error', j); })).rejects.toThrow();
  });

  it('keeps diagrams in separate rooms and files', async () => {
    const other = await workspace.create({ name: 'Other', kind: 'free', owner: 'po' });
    const a = new Client(url, 'A');
    const b = new Client(`ws://${base}/ws/${other.id}`, 'B');
    await a.next('scene_init');
    await b.next('scene_init');
    a.send({ elements: [el('inMain')] });
    b.send({ elements: [el('inOther')] });
    await sleep(100);
    expect(a.inbox).toEqual([]);
    expect(b.inbox).toEqual([]);
    await workspace.close();
    const ids = (f: string) => JSON.parse(readFileSync(join(path, '..', f), 'utf8')).elements.map((e: { id: string }) => e.id);
    expect(ids(diagram.file)).toEqual(['inMain']);
    expect(ids(other.file)).toEqual(['inOther']);
  });

  it('sends an outside edit of the file to every client with origin file', async () => {
    store.upsert([el('t', { type: 'text', text: 'old' })]);
    await store.idle();
    const a = new Client(url, 'a');
    await a.next('scene_init');
    await sleep(300);
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    doc.elements[0].text = 'from jq';
    writeFileSync(path, JSON.stringify(doc));
    const msg = await a.next('scene_patch');
    expect(msg).toMatchObject({ origin: 'file', elements: [{ id: 't', text: 'from jq', version: 2 }] });
    a.ws.close();
  });

  it('refuses a socket for an unknown diagram', async () => {
    const c = new Client(`ws://${base}/ws/d_nope00`, 'C');
    await expect(new Promise((r, j) => { c.ws.on('open', r); c.ws.on('error', j); })).rejects.toThrow();
  });

  it('refuses a socket whose path is not valid percent-encoding, and keeps running', async () => {
    const c = new Client(`ws://${base}/ws/%E0`, 'C');
    await expect(new Promise((r, j) => { c.ws.on('open', r); c.ws.on('error', j); })).rejects.toThrow();
    expect((await fetch(`http://${base}/health`)).status).toBe(200);
  });

  it('ignores malformed messages and keeps serving the room', async () => {
    const a = new Client(url, 'A');
    await a.next('scene_init');
    for (const bad of ['null', '42', '{"t":"client_patch","clientId":"A"}',
      JSON.stringify({ t: 'client_patch', clientId: 'A', elements: [], files: { f: {} } })]) a.ws.send(bad);
    a.send({ elements: [el('ok')] });
    await sleep(100);
    expect(store.get('ok')).toBeDefined();
    a.ws.close();
  });
});

describe('static files', () => {
  it('answers 400 to a path that is not valid percent-encoding, and keeps running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xl-static-'));
    writeFileSync(join(dir, 'index.html'), 'hi');
    const ws = await Workspace.load({ dir: join(dir, 'diagrams'), debounceMs: 0 });
    const s = await startServer({ workspace: ws, port: 0, host: '127.0.0.1', staticDir: dir });
    const at = `http://127.0.0.1:${(s.http.address() as AddressInfo).port}`;
    expect((await fetch(`${at}/%E0`)).status).toBe(400);
    expect(await (await fetch(`${at}/`)).text()).toBe('hi');
    await s.close();
  });
});

describe('diagrams API', () => {
  const api = (p: string, init: RequestInit = {}) => fetch(`http://${base}${p}`, {
    ...init, headers: { 'content-type': 'application/json', ...init.headers }
  });

  it('lists and gets diagrams', async () => {
    expect(await (await api('/api/diagrams')).json()).toEqual([diagram]);
    expect(await (await api(`/api/diagrams/${diagram.id}`)).json()).toEqual(diagram);
    expect((await api('/api/diagrams/d_nope00')).status).toBe(404);
  });

  it('creates and renames', async () => {
    const res = await api('/api/diagrams', { method: 'POST', body: JSON.stringify({ name: 'Flow', kind: 'flow', owner: 'dev', audience: ['po'] }) });
    expect(res.status).toBe(201);
    const d = await res.json();
    expect(workspace.get(d.id)).toEqual(d);

    const ren = await api(`/api/diagrams/${d.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Flow v2' }) });
    expect(await ren.json()).toMatchObject({ id: d.id, name: 'Flow v2' });
  });

  it('answers 400 on bad input', async () => {
    const res = await api('/api/diagrams', { method: 'POST', body: JSON.stringify({ name: 'x', kind: 'nope', owner: 'po' }) });
    expect(res.status).toBe(400);
    expect((await api('/api/diagrams', { method: 'POST', body: '{oops' })).status).toBe(400);
  });

  it('refuses writes from other web origins', async () => {
    const res = await api('/api/diagrams', { method: 'POST', headers: { origin: 'https://evil.example' }, body: JSON.stringify({ name: 'x', kind: 'free', owner: 'po' }) });
    expect(res.status).toBe(403);
    expect(workspace.list()).toHaveLength(1);
  });
});
