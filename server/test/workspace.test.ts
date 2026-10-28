import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../src/workspace.js';
import { el } from './helpers.js';

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
    const d = await ws.create({ name: 'Checkout – sequence', kind: 'sequence', owner: 'swe', audience: ['po'] });
    expect(d).toMatchObject({ name: 'Checkout – sequence', kind: 'sequence', owner: 'swe', audience: ['po'], file: 'checkout-sequence.excalidraw' });
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
    const po = await ws.create({ name: 'Journey', kind: 'journey', owner: 'po', audience: ['swe'] });
    const swe = await ws.create({ name: 'Containers', kind: 'c4-container', owner: 'swe' });
    return { ws, po, swe };
  }

  it('the owner role gets the writer lease', async () => {
    const { ws, po } = await setup();
    expect(ws.bind('s1', po.id, 'po')).toMatchObject({ mode: 'writer' });
    expect(() => ws.assertWrite('s1', po.id)).not.toThrow();
  });

  it('other roles are read-only', async () => {
    const { ws, po } = await setup();
    expect(ws.bind('s2', po.id, 'swe')).toMatchObject({ mode: 'reader' });
    expect(() => ws.assertWrite('s2', po.id)).toThrow(/read-only/);
  });

  it('only one session holds the lease; it passes on when released', async () => {
    const { ws, po } = await setup();
    ws.bind('s1', po.id, 'po');
    expect(ws.bind('s2', po.id, 'po')).toMatchObject({ mode: 'reader', writer: 's1' });
    ws.release('s1');
    expect(ws.bind('s2', po.id, 'po')).toMatchObject({ mode: 'writer' });
  });

  it('refuses writes to a diagram the session is not bound to', async () => {
    const { ws, po, swe } = await setup();
    ws.bind('s1', po.id, 'po');
    expect(() => ws.assertWrite('s1', swe.id)).toThrow(/bound to/);
    expect(() => ws.assertWrite('nobody', po.id)).toThrow(/not bound/);
  });

  it('binding to another diagram gives up the old lease', async () => {
    const { ws, po, swe } = await setup();
    ws.bind('s1', po.id, 'po');
    ws.bind('s1', swe.id, 'swe');
    expect(ws.bind('s2', po.id, 'po')).toMatchObject({ mode: 'writer' });
  });

  it('refuses binding to an unknown diagram', async () => {
    const { ws } = await setup();
    expect(() => ws.bind('s1', 'd_nope00', 'po')).toThrow(/unknown diagram/);
  });
});
