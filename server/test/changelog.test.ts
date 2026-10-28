import { describe, it, expect } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChangeRecord } from '@excalidraw-live/shared';
import { ChangeLog } from '../src/changelog.js';
import { SceneStore } from '../src/store.js';
import { mergeFromFile } from '../src/watch.js';
import { el } from './helpers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'xl-log-'));
const rec = (rev: number, id = 'a'): ChangeRecord =>
  ({ rev, kind: 'update', id, origin: 'human', at: '2026-10-27T00:00:00.000Z', type: 'rectangle', before: { x: rev - 1 }, after: { x: rev } });

describe('ChangeLog', () => {
  it('keeps the newest records in RAM and says when older ones are gone', async () => {
    const log = await ChangeLog.load(join(tmp(), 'a.log.jsonl'), { maxRecords: 3 });
    for (let r = 1; r <= 5; r++) log.append([rec(r)]);
    expect(log.after(0).map((r) => r.rev)).toEqual([3, 4, 5]);
    expect(log.evictedUpTo).toBe(2);
    expect(log.after(4).map((r) => r.rev)).toEqual([5]);
  });

  it('reloads from the file, skipping broken lines', async () => {
    const path = join(tmp(), 'a.log.jsonl');
    const log = await ChangeLog.load(path);
    log.append([rec(1), rec(2, 'b')]);
    log.append([rec(3)]);
    await log.idle();
    appendFileSync(path, '{ half a line\n');

    const again = await ChangeLog.load(path);
    expect(again.after(0).map((r) => [r.rev, r.id])).toEqual([[1, 'a'], [2, 'b'], [3, 'a']]);
    expect(again.lastRev).toBe(3);
  });

  it('cuts the file back to its newest half when it passes the size cap', async () => {
    const path = join(tmp(), 'a.log.jsonl');
    const maxBytes = 2 * 1024 * 1024;
    const log = await ChangeLog.load(path, { maxBytes });
    const padding = 'x'.repeat(1000);
    for (let r = 1; r <= 2500; r++) log.append([{ ...rec(r), label: padding }]);
    await log.idle();

    const size = statSync(path).size;
    expect(size).toBeLessThanOrEqual(maxBytes);
    const revs = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l).rev);
    expect(revs.at(-1)).toBe(2500);
    expect(revs).toEqual([...revs].sort((a, b) => a - b));
    expect((await ChangeLog.load(path)).evictedUpTo).toBe(revs[0] - 1);
  });
});

describe('SceneStore change log', () => {
  const open = (path: string) => SceneStore.load({ path, debounceMs: 0 });

  it('logs each write with its origin and reports changes since a revision', async () => {
    const s = await open(join(tmp(), 'a.excalidraw'));
    s.upsert([el('a')]);
    const since = s.revision;
    s.upsert([el('a', { version: 2, x: 40 })], 'agent');
    mergeFromFile(s, [el('b', { version: 1 })]);

    const w = s.changesSince(since);
    expect(w).toMatchObject({ since: 1, rev: 3, truncated: false, reset: false });
    expect(w.records.map((r) => [r.id, r.kind, r.origin])).toEqual([['a', 'update', 'agent'], ['b', 'add', 'file']]);
  });

  it('keeps its revision across a restart and writes the log beside the file', async () => {
    const path = join(tmp(), 'a.excalidraw');
    const s = await open(path);
    s.upsert([el('a')]);
    s.upsert([el('a', { version: 2, x: 9 })]);
    await s.flush();
    expect(readFileSync(`${path}.log.jsonl`, 'utf8').trim().split('\n')).toHaveLength(2);

    const again = await open(path);
    expect(again.revision).toBe(2);
    expect(again.changesSince(1).records).toHaveLength(1);
    expect(again.changesSince(7).reset).toBe(true);
  });

  it('keeps the revision of a write that changed nothing a report shows, across a restart', async () => {
    const path = join(tmp(), 'a.excalidraw');
    const s = await open(path);
    s.upsert([el('a')]);
    s.upsert([el('a', { version: 2, index: 'a1' })]); // only fields a report leaves out
    expect(s.revision).toBe(2);
    await s.flush();

    const again = await open(path);
    expect(again.revision).toBe(2);
    expect(again.changesSince(0).records.map((r) => [r.rev, r.kind])).toEqual([[1, 'add']]);
    again.upsert([el('b')]);
    expect(again.revision).toBe(3);
  });
});

describe('Workspace', () => {
  it('keeps change logs out of git', async () => {
    const { Workspace } = await import('../src/workspace.js');
    const dir = join(tmp(), 'diagrams');
    const ws = await Workspace.load({ dir, debounceMs: 0 });
    await ws.create({ name: 'A', kind: 'free', owner: 'po' });
    await ws.create({ name: 'B', kind: 'free', owner: 'po' });
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('*.log.jsonl\n');
    await ws.close();
  });
});
