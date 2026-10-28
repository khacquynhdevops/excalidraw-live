import { describe, it, expect } from 'vitest';
import type { DiagramEntry, SceneEl } from '@excalidraw-live/shared';
import { checkConsistency, type Board } from '../src/consistency.js';

function el(id: string, over: Partial<SceneEl> = {}): SceneEl {
  return { id, type: 'rectangle', x: 0, y: 0, version: 1, versionNonce: 1, isDeleted: false, updated: 0, ...over };
}
const box = (id: string, text: string, over: Partial<SceneEl> = {}): SceneEl[] => [
  el(id, { boundElements: [{ id: `${id}-t`, type: 'text' }], ...over }),
  el(`${id}-t`, { type: 'text', text, containerId: id })
];
const board = (entry: Partial<DiagramEntry> & { id: string }, elements: SceneEl[]): Board => ({
  entry: { name: entry.id, file: `${entry.id}.excalidraw`, kind: 'overview', owner: 'po', audience: [], ...entry },
  elements
});

const overview = board({ id: 'd_over' }, [
  ...box('pay', 'Payment Service', { link: '/d/d_seq#svc' }),
  ...box('inv', 'Inventory'),
  ...box('web', 'Web shop')
]);

describe('check_consistency', () => {
  it('reports nothing for boards that agree', () => {
    const seq = board({ id: 'd_seq', kind: 'sequence', owner: 'swe', refines: 'd_over#pay' }, box('svc', 'payment service'));
    const web = board({ id: 'd_web', kind: 'c4-container', owner: 'swe', refines: 'd_over#web' }, []);
    const inv = board({ id: 'd_inv', kind: 'erd', owner: 'swe', refines: 'd_over#inv' }, []);
    expect(checkConsistency([overview, seq, web, inv])).toEqual([]);
  });

  it('catches a label that drifted between a link and its target', () => {
    const seq = board({ id: 'd_seq', kind: 'sequence', owner: 'swe' }, box('svc', 'Payments Service'));
    expect(checkConsistency([overview, seq])).toContain(
      'drift: d_over "Payment Service" [pay] links to d_seq "Payments Service" [svc]'
    );
  });

  it('catches a refined element named differently on the child board', () => {
    const seq = board({ id: 'd_seq', kind: 'sequence', owner: 'swe', refines: 'd_over#pay' }, box('p', 'Payment Svc'));
    expect(checkConsistency([overview, seq])).toContain(
      'drift: d_seq refines d_over "Payment Service" [pay] but names it "Payment Svc" [p]'
    );
  });

  it('lists shapes on a refined board that no diagram details yet', () => {
    const seq = board({ id: 'd_seq', kind: 'sequence', owner: 'swe', refines: 'd_over#pay' }, box('svc', 'Payment Service'));
    const found = checkConsistency([overview, seq]);
    expect(found).toContain('undetailed: d_over "Inventory" [inv] (no diagram refines or links it)');
    expect(found).toContain('undetailed: d_over "Web shop" [web] (no diagram refines or links it)');
    expect(found.some((f) => f.includes('[pay]') && f.startsWith('undetailed'))).toBe(false);
  });

  it('reports refines and links that point at nothing', () => {
    const seq = board({ id: 'd_seq', kind: 'sequence', owner: 'swe', refines: 'd_over#gone' }, box('svc', 'Payment Service', { link: 'dl://d_nope#x' }));
    const found = checkConsistency([overview, seq]);
    expect(found).toContain('broken: d_seq refines d_over#gone, which does not exist');
    expect(found).toContain('broken: d_seq "Payment Service" [svc] links to d_nope#x, which does not exist');
  });

  it('keeps to the given diagrams', () => {
    const seq = board({ id: 'd_seq', kind: 'sequence', owner: 'swe' }, box('svc', 'Payments Service'));
    const other = board({ id: 'd_x', kind: 'flow', owner: 'tester', refines: 'd_x2#a' }, []);
    expect(checkConsistency([overview, seq, other], ['d_seq'])).toEqual([
      'drift: d_over "Payment Service" [pay] links to d_seq "Payments Service" [svc]'
    ]);
  });
});
