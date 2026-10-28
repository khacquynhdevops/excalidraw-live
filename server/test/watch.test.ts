import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SceneEl } from '@excalidraw-live/shared';
import { SceneStore } from '../src/store.js';
import { mergeFromFile } from '../src/watch.js';
import { Workspace } from '../src/workspace.js';
import { el, sleep } from './helpers.js';

const store = (els: SceneEl[]) => {
  const s = new SceneStore({ path: join(mkdtempSync(join(tmpdir(), 'xl-watch-')), 'a.excalidraw'), debounceMs: 60_000 });
  s.upsert(els);
  return s;
};

describe('mergeFromFile', () => {
  it('takes new elements and higher versions as they are', () => {
    const s = store([el('a', { version: 3 })]);
    const accepted = mergeFromFile(s, [el('a', { version: 4, x: 9 }), el('b')]);
    expect(accepted.map((e) => [e.id, e.version])).toEqual([['a', 4], ['b', 1]]);
    expect(s.get('a')!.x).toBe(9);
  });

  it('treats a hand edit at the same version as newer and bumps the version', () => {
    const s = store([el('t', { type: 'text', text: 'old', version: 5, versionNonce: 10 })]);
    const [e] = mergeFromFile(s, [el('t', { type: 'text', text: 'new', version: 5, versionNonce: 10 })]);
    expect(e).toMatchObject({ text: 'new', version: 6 });
    expect(e.versionNonce).not.toBe(10);
    expect(s.get('t')).toBe(e);
  });

  it('ignores unchanged and older copies (the store has unsaved edits)', () => {
    const s = store([el('a', { version: 2 }), el('b', { version: 7, x: 70 })]);
    expect(mergeFromFile(s, [el('a', { version: 2, updated: s.get('a')!.updated }), el('b', { version: 6, x: 60 })])).toEqual([]);
    expect(s.get('b')!.x).toBe(70);
  });

  it('never deletes an element just because the file lacks it', () => {
    const s = store([el('a'), el('b')]);
    mergeFromFile(s, [el('a', { version: 2 })]);
    expect(s.get('b')!.isDeleted).toBe(false);
  });

  it('accepts a delete written as isDeleted', () => {
    const s = store([el('a', { version: 2 })]);
    const [e] = mergeFromFile(s, [el('a', { version: 2, isDeleted: true, updated: s.get('a')!.updated })]);
    expect(e).toMatchObject({ isDeleted: true, version: 3 });
  });
});

describe('watching a diagram file', () => {
  let ws: Workspace;
  afterEach(async () => { await ws?.close(); });

  async function setup() {
    const dir = join(mkdtempSync(join(tmpdir(), 'xl-watch-')), 'diagrams');
    ws = await Workspace.load({ dir, debounceMs: 0 });
    const d = await ws.create({ name: 'Main', kind: 'free', owner: 'po' });
    const s = await ws.store(d.id);
    const events: { id: string; elements: SceneEl[] }[] = [];
    ws.onFileChange((id, _rev, elements) => events.push({ id, elements }));
    await sleep(300); // let the watcher settle
    return { d, s, path: join(dir, d.file), events };
  }

  const waitFor = async (cond: () => boolean) => {
    for (let i = 0; i < 40 && !cond(); i++) await sleep(50);
  };

  it('merges an outside edit with origin file and saves it back once, without a write loop', async () => {
    const { d, s, path, events } = await setup();
    s.upsert([el('t', { type: 'text', text: 'old' })]);
    await s.idle();
    await sleep(400); // our own write must not come back as a change
    expect(events).toEqual([]);

    const doc = JSON.parse(readFileSync(path, 'utf8'));
    doc.elements[0].text = 'edited by hand';
    writeFileSync(path, JSON.stringify(doc));

    await waitFor(() => events.length > 0);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(d.id);
    expect(events[0].elements[0]).toMatchObject({ text: 'edited by hand', version: 2 });
    expect(s.get('t')!.text).toBe('edited by hand');

    await s.idle();
    await sleep(600);
    expect(events).toHaveLength(1); // the save-back did not trigger another merge
    expect(JSON.parse(readFileSync(path, 'utf8')).elements[0]).toMatchObject({ text: 'edited by hand', version: 2 });
  });

  it('ignores a file that is not valid JSON', async () => {
    const { s, path, events } = await setup();
    s.upsert([el('a')]);
    await s.idle();
    writeFileSync(path, '{ not json');
    await sleep(600);
    expect(events).toEqual([]);
    expect(s.get('a')).toBeDefined();
  });
});
