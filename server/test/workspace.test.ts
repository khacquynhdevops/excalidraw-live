import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../src/workspace.js';
import { el, sleep } from './helpers.js';

let dir: string;
beforeEach(() => { dir = join(mkdtempSync(join(tmpdir(), 'xl-ws-')), 'diagrams'); });

const index = () => JSON.parse(readFileSync(join(dir, 'diagrams.json'), 'utf8'));

describe('Workspace', () => {
  it('starts empty when the folder does not exist yet', async () => {
    const ws = await Workspace.load({ dir });
    expect(ws.list()).toEqual([]);
  });

  it('creates a diagram: index entry, stable id, empty scene file', async () => {
    const ws = await Workspace.load({ dir });
    const d = await ws.create({ name: 'Checkout – sequence', kind: 'sequence', owner: 'dev', audience: ['po'] });
    expect(d).toMatchObject({ name: 'Checkout – sequence', kind: 'sequence', owner: 'dev', audience: ['po'], file: 'checkout-sequence.excalidraw' });
    expect(d.id).toMatch(/^d_[a-z0-9]{6}$/);
    expect(index()).toEqual([d]);
    expect(JSON.parse(readFileSync(join(dir, d.file), 'utf8'))).toMatchObject({ type: 'excalidraw', elements: [] });
  });

  it('gives each diagram its own file even when names collide', async () => {
    const ws = await Workspace.load({ dir });
    const a = await ws.create({ name: 'Overview', kind: 'overview', owner: 'po' });
    const b = await ws.create({ name: 'overview', kind: 'overview', owner: 'po' });
    expect(a.file).toBe('overview.excalidraw');
    expect(b.file).toBe('overview-2.excalidraw');
    expect(a.id).not.toBe(b.id);
  });

  it('gives each diagram its own file when two are created at the same time', async () => {
    const ws = await Workspace.load({ dir });
    const [a, b] = await Promise.all([
      ws.create({ name: 'Shop', kind: 'free', owner: 'po' }),
      ws.create({ name: 'Shop', kind: 'free', owner: 'dev' })
    ]);
    expect([a.file, b.file].sort()).toEqual(['shop-2.excalidraw', 'shop.excalidraw']);
    expect(index()).toHaveLength(2);
  });

  it('opens a diagram again once its broken file is fixed', async () => {
    const ws = await Workspace.load({ dir });
    const d = await ws.create({ name: 'Shop', kind: 'free', owner: 'po' });
    writeFileSync(join(dir, d.file), '{oops');
    await expect(ws.store(d.id)).rejects.toThrow();
    writeFileSync(join(dir, d.file), JSON.stringify({ type: 'excalidraw', elements: [el('a')] }));
    expect((await ws.store(d.id)).get('a')).toBeDefined();
    await ws.close();
  });

  it('deletes a diagram: index entry, drawing and change log', async () => {
    const ws = await Workspace.load({ dir });
    const keep = await ws.create({ name: 'Keep', kind: 'free', owner: 'po' });
    const d = await ws.create({ name: 'Gone', kind: 'free', owner: 'po' });
    writeFileSync(join(dir, `${d.file}.log.jsonl`), '{}\n');
    await ws.store(d.id);
    await ws.remove(d.id);
    expect(ws.list()).toEqual([keep]);
    expect(index()).toEqual([keep]);
    expect(existsSync(join(dir, d.file))).toBe(false);
    expect(existsSync(join(dir, `${d.file}.log.jsonl`))).toBe(false);
    expect(existsSync(join(dir, keep.file))).toBe(true);
    await expect(ws.remove(d.id)).rejects.toThrow();
    await ws.close();
    expect((await Workspace.load({ dir })).list()).toEqual([keep]);
  });

  it('keeps every change in the index when writes overlap', async () => {
    const ws = await Workspace.load({ dir });
    const a = await ws.create({ name: 'A', kind: 'free', owner: 'po' });
    const [b] = await Promise.all([
      ws.create({ name: 'B', kind: 'free', owner: 'po' }),
      ws.rename(a.id, 'A2')
    ]);
    const reloaded = (await Workspace.load({ dir })).list();
    expect(reloaded.map((d) => d.name).sort()).toEqual(['A2', 'B']);
    expect(reloaded.find((d) => d.id === b.id)).toBeDefined();
  });

  it('does not write a deleted diagram back from a late change', async () => {
    const ws = await Workspace.load({ dir, debounceMs: 100 });
    const d = await ws.create({ name: 'Gone', kind: 'free', owner: 'po' });
    const store = await ws.store(d.id);
    store.upsert([el('a')]);
    await ws.remove(d.id);
    store.upsert([el('b')]);
    store.addFiles({ f: { id: 'f' } });
    await sleep(300);
    expect(existsSync(join(dir, d.file))).toBe(false);
    expect(existsSync(join(dir, `${d.file}.log.jsonl`))).toBe(false);
  });

  it('refuses refines that points at an unknown diagram', async () => {
    const ws = await Workspace.load({ dir });
    await expect(ws.create({ name: 'X', kind: 'free', owner: 'po', refines: 'd_nope00#x' })).rejects.toThrow(/refines/);
    const parent = await ws.create({ name: 'P', kind: 'free', owner: 'po' });
    await expect(ws.create({ name: 'C', kind: 'free', owner: 'po', refines: `${parent.id}#x` })).resolves.toMatchObject({ refines: `${parent.id}#x` });
  });

  it('refuses an unknown kind or a missing name/owner', async () => {
    const ws = await Workspace.load({ dir });
    await expect(ws.create({ name: 'x', kind: 'nope' as never, owner: 'po' })).rejects.toThrow(/kind/);
    await expect(ws.create({ name: ' ', kind: 'free', owner: 'po' })).rejects.toThrow(/name/);
    await expect(ws.create({ name: 'x', kind: 'free', owner: '' })).rejects.toThrow(/owner/);
  });

  it('renames without changing id or file, and survives a reload', async () => {
    const ws = await Workspace.load({ dir });
    const d = await ws.create({ name: 'Old', kind: 'free', owner: 'po' });
    await ws.rename(d.id, 'New');
    const again = await Workspace.load({ dir });
    expect(again.get(d.id)).toEqual({ ...d, name: 'New' });
  });

  it('keeps one store per diagram, each writing only its own file', async () => {
    const ws = await Workspace.load({ dir, debounceMs: 0 });
    const a = await ws.create({ name: 'A', kind: 'free', owner: 'po' });
    const b = await ws.create({ name: 'B', kind: 'free', owner: 'po' });
    const sa = await ws.store(a.id);
    expect(await ws.store(a.id)).toBe(sa);
    sa.upsert([el('onlyA')]);
    await ws.close();
    const ids = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8')).elements.map((e: { id: string }) => e.id);
    expect(ids(a.file)).toEqual(['onlyA']);
    expect(ids(b.file)).toEqual([]);
  });

  it('has no store for an unknown id', async () => {
    const ws = await Workspace.load({ dir });
    await expect(ws.store('d_nope00')).rejects.toThrow(/unknown diagram/);
    expect(existsSync(join(dir, 'undefined'))).toBe(false);
  });
});

describe('session binding and writer lease', () => {
  async function setup() {
    const ws = await Workspace.load({ dir });
    const po = await ws.create({ name: 'Journey', kind: 'journey', owner: 'po', audience: ['dev'] });
    const dev = await ws.create({ name: 'Containers', kind: 'c4-container', owner: 'dev' });
    return { ws, po, dev };
  }

  it('the owner role gets the writer lease', async () => {
    const { ws, po } = await setup();
    expect(ws.bind('s1', po.id, 'po')).toMatchObject({ mode: 'writer' });
    expect(() => ws.assertWrite('s1', po.id)).not.toThrow();
  });

  it('other roles are read-only', async () => {
    const { ws, po } = await setup();
    expect(ws.bind('s2', po.id, 'dev')).toMatchObject({ mode: 'reader' });
    expect(() => ws.assertWrite('s2', po.id)).toThrow(/read-only/);
  });

  it('another role writes when it asks to edit, while no one else holds the lease', async () => {
    const { ws, po } = await setup();
    expect(ws.bind('s2', po.id, 'dev', true)).toMatchObject({ mode: 'writer' });
    expect(() => ws.assertWrite('s2', po.id)).not.toThrow();
    expect(ws.bind('s1', po.id, 'po')).toMatchObject({ mode: 'reader', writer: 's2' });
  });

  it('only one session holds the lease; it passes on when released', async () => {
    const { ws, po } = await setup();
    ws.bind('s1', po.id, 'po');
    expect(ws.bind('s2', po.id, 'po')).toMatchObject({ mode: 'reader', writer: 's1' });
    ws.release('s1');
    expect(ws.bind('s2', po.id, 'po')).toMatchObject({ mode: 'writer' });
  });

  it('names the role holding the lease and how long it has been idle', async () => {
    let now = 0;
    const ws = await Workspace.load({ dir, now: () => now });
    const po = await ws.create({ name: 'Journey', kind: 'journey', owner: 'po' });
    ws.bind('s1', po.id, 'po');
    now = 90_000;
    expect(ws.bind('s2', po.id, 'po')).toMatchObject({ mode: 'reader', writer: 's1', writerRole: 'po', writerIdleSeconds: 90 });
  });

  it('takes the lease over from a session left open, which then reads', async () => {
    const { ws, po } = await setup();
    ws.bind('s1', po.id, 'po');
    expect(ws.bind('s2', po.id, 'po', false, true)).toMatchObject({ mode: 'writer' });
    expect(() => ws.assertWrite('s1', po.id)).toThrow(/read-only/);
    expect(ws.bind('s3', po.id, 'dev', false, true)).toMatchObject({ mode: 'reader', writer: 's2' });
  });

  it('refuses writes to a diagram the session is not bound to', async () => {
    const { ws, po, dev } = await setup();
    ws.bind('s1', po.id, 'po');
    expect(() => ws.assertWrite('s1', dev.id)).toThrow(/bound to/);
    expect(() => ws.assertWrite('nobody', po.id)).toThrow(/not bound/);
  });

  it('binding to another diagram gives up the old lease', async () => {
    const { ws, po, dev } = await setup();
    ws.bind('s1', po.id, 'po');
    ws.bind('s1', dev.id, 'dev');
    expect(ws.bind('s2', po.id, 'po')).toMatchObject({ mode: 'writer' });
  });

  it('refuses binding to an unknown diagram', async () => {
    const { ws } = await setup();
    expect(() => ws.bind('s1', 'd_nope00', 'po')).toThrow(/unknown diagram/);
  });
});
