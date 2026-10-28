import { describe, it, expect } from 'vitest';
import type { ChangeRecord, Origin, SceneEl } from '../src/types.js';
import { foldChanges, formatReport, recordChanges } from '../src/changes.js';

function el(id: string, over: Partial<SceneEl> = {}): SceneEl {
  return { id, type: 'rectangle', x: 0, y: 0, width: 100, height: 50, version: 1, versionNonce: 1, isDeleted: false, updated: 0, ...over };
}

// A tiny scene that records like the store does: each step replaces some
// elements and logs what changed.
class Scene {
  els = new Map<string, SceneEl>();
  records: ChangeRecord[] = [];
  rev = 0;
  put(origin: Origin, ...changed: SceneEl[]) {
    const prev = new Map(changed.map((e) => [e.id, this.els.get(e.id)]));
    for (const e of changed) this.els.set(e.id, e);
    this.rev++;
    this.records.push(...recordChanges(
      changed.map((e) => e.id),
      (id) => (prev.has(id) ? prev.get(id) : this.els.get(id)),
      (id) => this.els.get(id),
      { rev: this.rev, origin, at: '2026-10-27T00:00:00.000Z' }
    ));
    return this;
  }
  report(since = 0, maxLines?: number) {
    return formatReport(
      { since, rev: this.rev, truncated: false, reset: false, records: this.records.filter((r) => r.rev > since) },
      [...this.els.values()],
      maxLines
    );
  }
}

// A shape with a bound label, as Excalidraw stores it.
function labelled(id: string, text: string, over: Partial<SceneEl> = {}): SceneEl[] {
  return [
    el(id, { boundElements: [{ id: `${id}-t`, type: 'text' }], ...over }),
    el(`${id}-t`, { type: 'text', text, originalText: text, containerId: id })
  ];
}

describe('recordChanges', () => {
  it('records an add with its label, not the bound text separately', () => {
    const s = new Scene().put('human', ...labelled('a', 'Auth'));
    expect(s.records).toEqual([
      expect.objectContaining({ kind: 'add', id: 'a', type: 'rectangle', label: 'Auth', origin: 'human', rev: 1 })
    ]);
  });

  it('records a relabel as an update of the container', () => {
    const s = new Scene().put('human', ...labelled('a', 'Gateway'));
    s.put('agent', el('a-t', { type: 'text', text: 'API\nGateway', originalText: 'API Gateway', containerId: 'a', version: 2 }));
    expect(s.records[1]).toMatchObject({ kind: 'update', id: 'a', origin: 'agent', before: { label: 'Gateway' }, after: { label: 'API Gateway' } });
  });

  it('ignores bookkeeping and sub-pixel noise', () => {
    const s = new Scene().put('human', el('a'));
    s.put('human', el('a', { version: 2, versionNonce: 9, seed: 5, updated: 99, x: 0.2 }));
    expect(s.records).toHaveLength(1);
  });

  it('records a delete as a tombstone and keeps the label', () => {
    const s = new Scene().put('human', ...labelled('a', 'Queue'));
    s.put('human', el('a', { isDeleted: true, version: 2 }));
    expect(s.records[1]).toMatchObject({ kind: 'delete', id: 'a', label: 'Queue' });
  });

  it('records a rebind of an arrow end', () => {
    const s = new Scene().put('human', el('x'), el('y'), el('z'),
      el('ar', { type: 'arrow', startBinding: { elementId: 'x' }, endBinding: { elementId: 'y' }, points: [[0, 0], [100, 0]] }));
    s.put('human', el('ar', { type: 'arrow', startBinding: { elementId: 'x' }, endBinding: { elementId: 'z' }, points: [[0, 0], [100, 0]], version: 2 }));
    expect(s.records.at(-1)).toMatchObject({ kind: 'update', id: 'ar', before: { endTarget: 'y' }, after: { endTarget: 'z' } });
  });
});

describe('foldChanges', () => {
  it('folds 200 moves of one element into one net move', () => {
    const s = new Scene().put('human', el('a'));
    const since = s.rev;
    for (let i = 1; i <= 200; i++) s.put('human', el('a', { x: i, version: i + 1 }));
    const folded = foldChanges(s.records.filter((r) => r.rev > since));
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ kind: 'update', before: { x: 0 }, after: { x: 200 } });
  });

  it('drops an element added and deleted in the same window, and moves that cancel out', () => {
    const s = new Scene().put('human', el('keep'));
    const since = s.rev;
    s.put('human', el('tmp')).put('human', el('tmp', { isDeleted: true, version: 2 }));
    s.put('human', el('keep', { x: 50, version: 2 })).put('human', el('keep', { x: 0, version: 3 }));
    expect(foldChanges(s.records.filter((r) => r.rev > since))).toEqual([]);
  });

  it('reports an element added then edited as one add', () => {
    const s = new Scene().put('agent', el('a')).put('human', el('a', { x: 300, version: 2 }));
    expect(foldChanges(s.records)).toEqual([expect.objectContaining({ kind: 'add', id: 'a', origins: ['agent', 'human'] })]);
  });
});

describe('formatReport', () => {
  it('reads like the PLAN example: one line per element, origin on each', () => {
    const s = new Scene().put('human', ...labelled('gw', 'Gateway'), ...labelled('q', 'Queue'), ...labelled('web', 'Web'), ...labelled('auth', 'Auth'),
      el('old', { type: 'arrow', startBinding: { elementId: 'web' }, endBinding: { elementId: 'auth' }, points: [[0, 0], [10, 0]] }));
    const since = s.rev;
    s.put('agent', ...labelled('svc', 'Auth Service', { x: 400, y: 120 }));
    s.put('human', el('gw-t', { type: 'text', text: 'API Gateway', originalText: 'API Gateway', containerId: 'gw', version: 2 }));
    s.put('human', el('gw', { boundElements: [{ id: 'gw-t', type: 'text' }], x: 120, version: 2 }));
    s.put('human', el('old', { type: 'arrow', isDeleted: true, version: 2, startBinding: { elementId: 'web' }, endBinding: { elementId: 'auth' } }));
    s.put('human', el('note', { type: 'text', text: 'why sync?', x: 0, y: 70, width: 60, height: 20 }));

    const report = s.report(since);
    expect(report.split('\n')).toEqual([
      'rev 1→6: 4 elements changed (human 3, agent 1)',
      '+ rectangle "Auth Service" [svc] @(400,120) 100x50 · agent',
      '~ rectangle "API Gateway" [gw]: moved right 120px to (120,0); label "Gateway"→"API Gateway" · human',
      '- arrow "Web"→"Auth" [old] · human',
      '+ text "why sync?" [note] @(0,70) 60x20, near rectangle "Queue" [q] · human'
    ]);
  });

  it('cuts after the line limit and counts the rest', () => {
    const s = new Scene();
    for (let i = 0; i < 80; i++) s.put('human', el(`e${i}`));
    const lines = s.report(0).split('\n');
    expect(lines).toHaveLength(1 + 50 + 1);
    expect(lines.at(-1)).toBe('… and 30 more changes');
  });

  it('says so when nothing changed, or when the history is gone', () => {
    expect(new Scene().report(0)).toBe('rev 0→0: no changes.');
    const text = formatReport({ since: 9, rev: 3, truncated: false, reset: true, records: [] }, []);
    expect(text).toMatch(/^⚠ rev 9 is ahead of the board/);
    expect(formatReport({ since: 1, rev: 3, truncated: true, reset: false, records: [] }, [])).toMatch(/partial/);
  });
});
