import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Presence } from '@excalidraw-live/shared';
import { SceneStore } from '../src/store.js';
import { acceptProposal, agentWrite, AGENT_COLOR, AGENT_FONT, ACCEPTED_COLOR, PROPOSAL_FRAME, type AgentOp } from '../src/agent-write.js';
import { el } from './helpers.js';

let store: SceneStore;
let clock: number;
const LONG_AGO = 60_000;

beforeEach(() => {
  clock = 1_000_000;
  store = new SceneStore({ path: join(mkdtempSync(join(tmpdir(), 'xl-aw-')), 'scene.excalidraw'), now: () => clock });
  // Drawn by a person a minute ago.
  store.upsert([el('a', { index: 'a0' }), el('b', { x: 300, index: 'a1' })]);
  clock += LONG_AGO;
});

const idle: Presence = { editingId: null, selectedIds: [], idle: true };
const write = (ops: AgentOp[], presence: Presence[] = [idle], more = {}) => agentWrite(store, ops, { presence, now: clock, ...more });
const byType = (type: string) => store.all().filter((e) => e.type === type);

describe('agent writes', () => {
  it('creates complete elements in Claude blue, marked as agent, on top', () => {
    const r = write([{ op: 'create', type: 'rectangle', id: 'n', x: 0, y: 200 }]);
    expect(r.applied).toEqual([{ op: 0, kind: 'create', id: 'n' }]);
    expect(r.conflicts).toEqual([]);
    const n = store.get('n')!;
    expect(n).toMatchObject({
      strokeColor: AGENT_COLOR, version: 1, isDeleted: false, customData: { origin: 'agent' },
      angle: 0, opacity: 100, groupIds: [], boundElements: null, locked: false
    });
    expect(n.index! > 'a1').toBe(true);
    expect(store.changesSince(1).records.every((c) => c.origin === 'agent')).toBe(true);
  });

  it('puts new elements in a "Claude proposal" frame and grows it on the next write', () => {
    const r1 = write([{ op: 'create', type: 'rectangle', id: 'n', x: 0, y: 200, width: 100, height: 50 }]);
    const [frame] = byType('frame');
    expect(frame).toMatchObject({ id: r1.frameId, name: PROPOSAL_FRAME, x: -40, y: 160, width: 180, height: 130 });
    expect(store.get('n')!.frameId).toBe(frame.id);
    expect(frame.index! < store.get('n')!.index!).toBe(true);

    const r2 = write([{ op: 'create', type: 'ellipse', id: 'm', x: 400, y: 200, width: 100, height: 50 }]);
    expect(r2.frameId).toBe(frame.id);
    expect(byType('frame')).toHaveLength(1);
    expect(store.get(frame.id)).toMatchObject({ x: -40, width: 540, version: 2 });
  });

  it('leaves new elements unframed with frameId null', () => {
    const r = write([{ op: 'create', type: 'rectangle', id: 'n' }], [idle], { frameId: null });
    expect(r.frameId).toBeUndefined();
    expect(store.get('n')!.frameId).toBeNull();
    expect(byType('frame')).toEqual([]);
  });

  it('labels a shape with bound text, and binds an arrow between two shapes', () => {
    write([
      { op: 'create', type: 'rectangle', id: 'n', label: 'Pay', x: 0, y: 200 },
      { op: 'create', type: 'arrow', id: 'ar', start: 'a', end: 'b' }
    ]);
    const n = store.get('n')!;
    const text = store.get('n-label')!;
    expect(n.boundElements).toEqual([{ id: 'n-label', type: 'text' }]);
    expect(text).toMatchObject({ type: 'text', text: 'Pay', containerId: 'n', frameId: n.frameId });
    expect(store.get('ar')).toMatchObject({ startBinding: { elementId: 'a' }, endBinding: { elementId: 'b' } });
    // The person's shapes now know about the arrow.
    expect(store.get('a')).toMatchObject({ version: 2, boundElements: [{ id: 'ar', type: 'arrow' }] });
  });

  it('writes text in a readable font, not the hand-drawn one', () => {
    write([
      { op: 'create', type: 'text', id: 't', text: 'Note' },
      { op: 'create', type: 'rectangle', id: 'n', label: 'Pay' }
    ]);
    expect(store.get('t')!.fontFamily).toBe(AGENT_FONT);
    expect(store.get('n-label')!.fontFamily).toBe(AGENT_FONT);
    expect(AGENT_FONT).not.toBe(5);
  });

  it('passes font and colour given on a shape down to its label', () => {
    write([{ op: 'create', type: 'rectangle', id: 'n', label: 'Pay', fontFamily: 2, fontSize: 28, strokeColor: '#e03131' }]);
    expect(store.get('n-label')).toMatchObject({ fontFamily: 2, fontSize: 28, strokeColor: '#e03131' });
    expect(store.get('n')).not.toHaveProperty('fontFamily');

    clock += LONG_AGO;
    write([{ op: 'update', id: 'n', patch: { fontFamily: 6, fontSize: 16, strokeColor: '#2f9e44' } }]);
    const label = store.get('n-label')!;
    expect(label).toMatchObject({ fontFamily: 6, fontSize: 16, strokeColor: '#2f9e44', version: 2 });
    expect(label.height).toBe(16 * 1.25);
    expect(store.get('n')).toMatchObject({ strokeColor: '#2f9e44' });
    expect(store.get('n')).not.toHaveProperty('fontFamily');
  });

  it("keeps an arrow between the person's shapes out of the proposal frame", () => {
    const r = write([{ op: 'create', type: 'arrow', id: 'ar', start: 'a', end: 'b', label: 'calls' }]);
    expect(r.frameId).toBeUndefined();
    expect(byType('frame')).toEqual([]);
    expect(store.get('ar')).toMatchObject({ frameId: null, strokeColor: AGENT_COLOR, customData: { origin: 'agent' } });
    expect(store.get('ar-label')!.frameId).toBeNull();
  });

  it('frames an arrow between proposed shapes, and leaves out one that reaches a shape of the person', () => {
    const r = write([
      { op: 'create', type: 'rectangle', id: 'n', x: 0, y: 400 },
      { op: 'create', type: 'rectangle', id: 'm', x: 300, y: 400 },
      { op: 'create', type: 'arrow', id: 'in', start: 'n', end: 'm' },
      { op: 'create', type: 'arrow', id: 'out', start: 'n', end: 'a' }
    ]);
    expect(store.get('in')!.frameId).toBe(r.frameId);
    expect(store.get('out')!.frameId).toBeNull();
  });

  it("moves a proposal that would cover the person's shapes to free space, keeping its layout", () => {
    // a: 0..100 × 0..50, b: 300..400 × 0..50
    write([
      { op: 'create', type: 'rectangle', id: 'n', x: 120, y: 0, width: 100, height: 50, label: 'New' },
      { op: 'create', type: 'rectangle', id: 'm', x: 120, y: 100, width: 100, height: 50 },
      { op: 'create', type: 'arrow', id: 'ar', start: 'n', end: 'm' },
      { op: 'create', type: 'arrow', id: 'out', start: 'm', end: 'a' }
    ]);
    const [frame] = byType('frame');
    const n = store.get('n')!, m = store.get('m')!;
    const overlaps = (p: typeof frame, q: typeof frame) =>
      p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height;
    for (const id of ['a', 'b']) expect(overlaps(frame, store.get(id)!)).toBe(false);
    expect(frame.x).toBeGreaterThanOrEqual(400 + 40);
    expect([m.x - n.x, m.y - n.y]).toEqual([0, 100]);
    expect(store.get('n-label')!.x).toBeGreaterThan(n.x);
    // Arrows follow the shapes they are bound to.
    expect(store.get('ar')!.x).toBeGreaterThan(n.x);
    const out = store.get('out')!;
    expect(out.x).toBeGreaterThan(400);
    expect(out.x + (out.points as number[][])[1][0]).toBeLessThan(100 + 10);
  });

  it('starts a new proposal frame in free space instead of growing one over the person\'s shapes', () => {
    const r1 = write([{ op: 'create', type: 'rectangle', id: 'n', x: 0, y: 400 }]);
    clock += LONG_AGO;
    const r2 = write([{ op: 'create', type: 'rectangle', id: 'm', x: 200, y: 0 }]);
    expect(r2.frameId).not.toBe(r1.frameId);
    expect(store.get(r1.frameId!)).toMatchObject({ version: 1 });
    const f2 = store.get(r2.frameId!)!;
    expect(f2.x).toBeGreaterThanOrEqual(400 + 40);
    clock += LONG_AGO;
    // The newest proposal frame takes the next proposal.
    expect(write([{ op: 'create', type: 'rectangle', id: 'k', x: f2.x + 60, y: 60, width: 20, height: 20 }]).frameId).toBe(r2.frameId);
  });

  it('accepts a proposal: elements leave the frame in green, and the empty frame goes', () => {
    const { frameId } = write([
      { op: 'create', type: 'rectangle', id: 'n', x: 0, y: 400, label: 'Pay' },
      { op: 'create', type: 'rectangle', id: 'm', x: 300, y: 400 }
    ]);
    clock += LONG_AGO;
    const r1 = acceptProposal(store, { frameId: frameId!, elementIds: ['n'], presence: [idle], now: clock });
    expect(r1.accepted).toEqual(['n']);
    expect(r1.frameDeleted).toBe(false);
    expect(store.get('n')).toMatchObject({ frameId: null, strokeColor: ACCEPTED_COLOR, customData: { origin: 'agent' } });
    expect(store.get('n-label')).toMatchObject({ frameId: null, strokeColor: ACCEPTED_COLOR });
    expect(store.get('m')!.frameId).toBe(frameId);

    clock += LONG_AGO;
    const r2 = acceptProposal(store, { frameId: frameId!, keepColor: true, presence: [idle], now: clock });
    expect(r2.accepted).toEqual(['m']);
    expect(r2.frameDeleted).toBe(true);
    expect(store.get('m')).toMatchObject({ frameId: null, strokeColor: AGENT_COLOR });
    expect(store.get(frameId!)!.isDeleted).toBe(true);
  });

  it('accepts nothing the person is working on, and keeps the frame for it', () => {
    const { frameId } = write([{ op: 'create', type: 'rectangle', id: 'n', x: 0, y: 400 }]);
    clock += LONG_AGO;
    const r = acceptProposal(store, { frameId: frameId!, presence: [{ editingId: null, selectedIds: ['n'], idle: true }], now: clock });
    expect(r.accepted).toEqual([]);
    expect(r.conflicts).toEqual([{ op: 0, id: 'n', reason: 'selected' }]);
    expect(store.get(frameId!)!.isDeleted).toBe(false);
    expect(() => acceptProposal(store, { frameId: 'a', presence: [idle], now: clock })).toThrow(/not a frame/);
    expect(() => acceptProposal(store, { frameId: frameId!, elementIds: ['a'], presence: [idle], now: clock })).toThrow(/not in frame/);
  });

  it('bumps version, nonce and updated on update, and keeps the server in charge of them', () => {
    write([{ op: 'update', id: 'a', patch: { x: 50, version: 99, id: 'zz' }, expectedVersion: 1 }]);
    const a = store.get('a')!;
    expect(a).toMatchObject({ id: 'a', x: 50, version: 2, updated: clock });
    expect(a.versionNonce).not.toBe(1);
  });

  it('deletes with a tombstone, never by removing', () => {
    write([{ op: 'delete', id: 'a' }]);
    expect(store.get('a')).toMatchObject({ isDeleted: true, version: 2 });
  });

  it('returns conflicts for elements the person is editing, has selected, or just changed', () => {
    store.upsert([el('b', { x: 310, version: 2, index: 'a1' })]); // just now
    const r = write(
      [
        { op: 'update', id: 'a', patch: { x: 1 } },
        { op: 'delete', id: 'b' },
        { op: 'update', id: 'gone', patch: {} },
        { op: 'update', id: 'a', patch: { x: 2 }, expectedVersion: 7 }
      ],
      [{ editingId: null, selectedIds: ['a'], idle: true }]
    );
    expect(r.applied).toEqual([]);
    expect(r.conflicts).toEqual([
      { op: 0, id: 'a', reason: 'selected' },
      { op: 1, id: 'b', reason: 'recent' },
      { op: 2, id: 'gone', reason: 'missing' },
      { op: 3, id: 'a', reason: 'version', version: 1 }
    ]);
    expect(write([{ op: 'update', id: 'a', patch: {} }], [{ editingId: 'a', selectedIds: [], idle: false }]).conflicts)
      .toEqual([{ op: 0, id: 'a', reason: 'editing' }]);
    expect(store.get('a')!.version).toBe(1);
  });

  it('applies the ops that are free and reports the rest', () => {
    const r = write([
      { op: 'update', id: 'a', patch: { x: 9 } },
      { op: 'update', id: 'b', patch: { x: 9 } }
    ], [{ editingId: null, selectedIds: ['b'], idle: true }]);
    expect(r.applied.map((a) => a.id)).toEqual(['a']);
    expect(r.conflicts.map((c) => c.id)).toEqual(['b']);
    expect(store.get('a')!.x).toBe(9);
    expect(store.get('b')!.x).toBe(300);
  });

  it('touches nothing and keeps the revision when every op conflicts', () => {
    const rev = store.revision;
    const r = write([{ op: 'delete', id: 'nope' }]);
    expect(r.rev).toBe(rev);
    expect(store.revision).toBe(rev);
  });

  it("does not count Claude's own writes as a person's recent edit", () => {
    write([{ op: 'update', id: 'a', patch: { x: 5 } }]);
    expect(write([{ op: 'update', id: 'a', patch: { x: 6 } }]).conflicts).toEqual([]);
  });

  it('rejects an empty op list', () => {
    expect(() => write([])).toThrow(/non-empty/);
  });
});
