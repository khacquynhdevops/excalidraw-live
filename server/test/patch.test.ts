import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SceneStore } from '../src/store.js';
import { applyPatch } from '../src/patch.js';
import { el } from './helpers.js';

let store: SceneStore;
beforeEach(() => {
  store = new SceneStore({ path: join(mkdtempSync(join(tmpdir(), 'xl-patch-')), 's.excalidraw'), debounceMs: 60_000 });
});

describe('applyPatch', () => {
  it('accepts new elements', () => {
    const r = applyPatch(store, [el('a')]);
    expect(r.accepted.map((e) => e.id)).toEqual(['a']);
    expect(r.rejected).toEqual([]);
    expect(store.get('a')).toBeDefined();
  });

  it('accepts a higher version', () => {
    applyPatch(store, [el('a', { version: 1, x: 0 })]);
    const r = applyPatch(store, [el('a', { version: 2, x: 50 })]);
    expect(r.accepted).toHaveLength(1);
    expect(store.get('a')?.x).toBe(50);
  });

  it('rejects a lower version and returns the stored copy', () => {
    applyPatch(store, [el('a', { version: 5, x: 1 })]);
    const r = applyPatch(store, [el('a', { version: 3, x: 2 })]);
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toEqual([store.get('a')]);
    expect(store.get('a')?.x).toBe(1);
  });

  it('breaks version ties by the lower versionNonce, like reconcile.ts', () => {
    applyPatch(store, [el('a', { version: 2, versionNonce: 50, x: 1 })]);
    expect(applyPatch(store, [el('a', { version: 2, versionNonce: 60, x: 2 })]).accepted).toEqual([]);
    expect(applyPatch(store, [el('a', { version: 2, versionNonce: 50, x: 3 })]).accepted).toEqual([]);
    expect(applyPatch(store, [el('a', { version: 2, versionNonce: 40, x: 4 })]).accepted).toHaveLength(1);
    expect(store.get('a')?.x).toBe(4);
  });

  it('applies a tombstone and keeps it', () => {
    applyPatch(store, [el('a', { version: 1 })]);
    applyPatch(store, [el('a', { version: 2, isDeleted: true })]);
    expect(store.get('a')?.isDeleted).toBe(true);
  });

  it('never deletes an element just because a patch omits it (KI-7)', () => {
    applyPatch(store, [el('a'), el('b')]);
    applyPatch(store, [el('a', { version: 2 })]);
    expect(store.get('b')?.isDeleted).toBe(false);
  });

  it('bumps revision once per patch, and not at all when nothing is accepted', () => {
    applyPatch(store, [el('a'), el('b')]);
    expect(store.revision).toBe(1);
    applyPatch(store, [el('a', { version: 0 })]);
    expect(store.revision).toBe(1);
  });
});
