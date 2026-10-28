import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SceneStore } from '../src/store.js';
import { serializeScene, hashContent } from '../src/file-io.js';
import { el, sleep } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;
let path: string;
beforeEach(() => { path = join(mkdtempSync(join(tmpdir(), 'xl-store-')), 'scene.excalidraw'); });

const fileElements = () => JSON.parse(readFileSync(path, 'utf8')).elements as { id: string }[];

describe('SceneStore', () => {
  it('bumps revision on every upsert', () => {
    const store = new SceneStore({ path });
    expect(store.revision).toBe(0);
    store.upsert([el('a')]);
    store.upsert([el('b'), el('c')]);
    expect(store.revision).toBe(2);
    expect(store.get('b')?.id).toBe('b');
  });

  it('debounces saves into one write after the quiet period', async () => {
    const store = new SceneStore({ path, debounceMs: 50 });
    store.upsert([el('a')]);
    await sleep(20);
    store.upsert([el('b')]);
    await sleep(20);
    expect(existsSync(path)).toBe(false);
    await store.idle();
    expect(fileElements().map((e) => e.id).sort()).toEqual(['a', 'b']);
  });

  it('keeps tombstones in memory and in the file', async () => {
    const store = new SceneStore({ path, debounceMs: 0 });
    store.upsert([el('a'), el('b', { isDeleted: true })]);
    await store.flush();
    expect(store.get('b')?.isDeleted).toBe(true);
    expect(fileElements().map((e) => e.id).sort()).toEqual(['a', 'b']);
  });

  it('prunes tombstones older than 24h when saving', async () => {
    let now = 10 * DAY;
    const store = new SceneStore({ path, debounceMs: 0, now: () => now });
    store.upsert([
      el('old', { isDeleted: true, updated: now - DAY - 1 }),
      el('fresh', { isDeleted: true, updated: now - 1000 }),
      el('live', { updated: now - 2 * DAY })
    ]);
    await store.flush();
    expect(store.get('old')).toBeUndefined();
    expect(fileElements().map((e) => e.id).sort()).toEqual(['fresh', 'live']);
  });

  it('records the hash of what it wrote', async () => {
    const store = new SceneStore({ path, debounceMs: 0 });
    store.upsert([el('a')]);
    await store.flush();
    expect(store.lastWrittenHash).toBe(hashContent(readFileSync(path, 'utf8')));
  });

  it('loads an existing file and preserves appState and files', async () => {
    const appState = { viewBackgroundColor: '#123456' };
    const files = { f: { id: 'f', mimeType: 'image/png', dataURL: 'data:' } };
    writeFileSync(path, serializeScene({ elements: [el('a')], appState, files }));
    const store = await SceneStore.load({ path, debounceMs: 0 });
    expect(store.get('a')).toBeDefined();
    store.upsert([el('b')]);
    await store.flush();
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    expect(doc.appState).toEqual(appState);
    expect(doc.files).toEqual(files);
    expect(doc.elements).toHaveLength(2);
  });

  it('adds only files it does not have yet, and saves them', async () => {
    const store = new SceneStore({ path, debounceMs: 0 });
    const f1 = { id: 'f1', mimeType: 'image/png', dataURL: 'data:1' };
    expect(store.addFiles({ f1 })).toEqual(['f1']);
    expect(store.addFiles({ f1: { ...f1, dataURL: 'data:changed' } })).toEqual([]);
    await store.idle();
    expect(JSON.parse(readFileSync(path, 'utf8')).files).toEqual({ f1 });
    expect(store.getFiles()).toEqual({ f1 });
  });

  it('saves again when changes arrive during a write', async () => {
    const store = new SceneStore({ path, debounceMs: 0 });
    store.upsert([el('a')]);
    const first = store.flush();
    store.upsert([el('b')]);
    await first;
    await store.idle();
    expect(fileElements().map((e) => e.id).sort()).toEqual(['a', 'b']);
  });

  it('creates the folder of a new scene file', async () => {
    const nested = join(path, '..', 'new', 'dir', 's.excalidraw');
    const store = new SceneStore({ path: nested, debounceMs: 0 });
    store.upsert([el('a')]);
    await store.idle();
    expect(existsSync(nested)).toBe(true);
  });

  it('survives a failed save and retries on the next change', async () => {
    writeFileSync(join(path, '..', 'blocker'), '');
    const bad = join(path, '..', 'blocker', 's.excalidraw');
    const store = new SceneStore({ path: bad, debounceMs: 0 });
    store.upsert([el('a')]);
    await sleep(50);
    await store.idle();
    expect(store.get('a')).toBeDefined();
  });
});
