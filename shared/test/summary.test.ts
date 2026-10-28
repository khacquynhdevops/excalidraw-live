import { describe, it, expect } from 'vitest';
import type { SceneEl } from '../src/types.js';
import { summarizeScene } from '../src/summary.js';

function el(id: string, over: Partial<SceneEl> = {}): SceneEl {
  return { id, type: 'rectangle', x: 0, y: 0, width: 100, height: 50, version: 1, versionNonce: 1, isDeleted: false, updated: 0, ...over };
}

function labelled(id: string, text: string, over: Partial<SceneEl> = {}): SceneEl[] {
  return [
    el(id, { boundElements: [{ id: `${id}-t`, type: 'text' }], ...over }),
    el(`${id}-t`, { type: 'text', text, originalText: text, containerId: id })
  ];
}

const scene = [
  el('f', { type: 'frame', name: 'Proposal', width: 500, height: 300 }),
  ...labelled('auth', 'Auth', { frameId: 'f', groupIds: ['g1'] }),
  ...labelled('q', 'Queue', { x: 200, groupIds: ['g1'], link: '/d/d_seq#e1' }),
  ...labelled('ar', 'JWT', { type: 'arrow', startBinding: { elementId: 'auth' }, endBinding: { elementId: 'q' } }),
  el('n', { type: 'text', text: 'why sync?', x: 0, y: 70, width: 60, height: 20 }),
  el('gone', { isDeleted: true })
];

describe('summarizeScene', () => {
  it('lists frames, shapes, arrows, notes and groups, skipping deleted and bound text', () => {
    expect(summarizeScene(scene, { rev: 7, name: 'Checkout', kind: 'flow' }).split('\n')).toEqual([
      'board "Checkout" (flow) · rev 7 · 2 shapes, 1 arrow, 1 note, 1 frame',
      'frames:',
      '  "Proposal" [f] @(0,0) 500x300: 1 element',
      'shapes:',
      '  rectangle "Auth" [auth] @(0,0) 100x50 in frame "Proposal"',
      '  rectangle "Queue" [q] @(200,0) 100x50 → /d/d_seq#e1',
      'arrows:',
      '  "Auth"→"Queue" [ar] label "JWT"',
      'notes:',
      '  "why sync?" [n] @(0,70)',
      'groups:',
      '  [g1]: "Auth", "Queue"'
    ]);
  });

  it('narrows to one frame', () => {
    const text = summarizeScene(scene, { rev: 7, frameId: 'f' });
    expect(text.split('\n')).toEqual([
      'frame "Proposal" [f] · rev 7 · 1 shape',
      'shapes:',
      '  rectangle "Auth" [auth] @(0,0) 100x50 in frame "Proposal"'
    ]);
    expect(summarizeScene(scene, { rev: 7, frameId: 'nope' })).toBe('no frame [nope] on this board (rev 7)');
  });

  it('says when the board is empty and cuts long boards', () => {
    expect(summarizeScene([], { rev: 0 })).toBe('board · rev 0 · empty');
    const many = Array.from({ length: 30 }, (_, i) => el(`e${i}`));
    const lines = summarizeScene(many, { rev: 1, maxLines: 10 }).split('\n');
    expect(lines).toHaveLength(10 + 1);
    expect(lines.at(-1)).toBe('… and 22 more lines');
  });
});
