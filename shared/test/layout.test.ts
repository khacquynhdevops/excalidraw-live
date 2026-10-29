import { describe, it, expect } from 'vitest';
import type { SceneEl } from '../src/types.js';
import { fitLabel, labelRoom, layoutIssues } from '../src/layout.js';

function el(id: string, over: Partial<SceneEl> = {}): SceneEl {
  return { id, type: 'rectangle', x: 0, y: 0, width: 100, height: 50, version: 1, versionNonce: 1, isDeleted: false, updated: 0, ...over };
}

function labelled(id: string, text: string, over: Partial<SceneEl> = {}, label: Partial<SceneEl> = {}): SceneEl[] {
  return [
    el(id, { boundElements: [{ id: `${id}-t`, type: 'text' }], ...over }),
    el(`${id}-t`, { type: 'text', text, originalText: text, containerId: id, x: 10, y: 15, width: 60, height: 20, ...label })
  ];
}

describe('layoutIssues', () => {
  it('finds nothing on a tidy board', () => {
    expect(layoutIssues([...labelled('a', 'Auth'), ...labelled('b', 'DB', { x: 300 }, { x: 310 })])).toEqual([]);
  });

  it('reports a label that overflows its shape, with a size that fits', () => {
    const issues = layoutIssues(labelled('a', 'Authentication service', {}, { width: 260 }));
    expect(issues).toEqual(['label of rectangle "Authentication service" [a] overflows it: make it 300x50 or shorten the label']);
  });

  it('gives an ellipse and a diamond less room than a rectangle', () => {
    expect(labelRoom('ellipse', 100, 100).width).toBeLessThan(labelRoom('rectangle', 100, 100).width);
    expect(fitLabel('diamond', 0, 0, { width: 100, height: 20 })).toEqual({ width: 280, height: 100 });
  });

  it('reports a label left behind by its shape', () => {
    expect(layoutIssues(labelled('a', 'Auth', { x: 500 }))).toEqual(['label of rectangle "Auth" [a] is outside its shape']);
  });

  it('reports an arrow label longer than the arrow, or lying on a shape', () => {
    const arrow = labelled('ar', 'calls with a JWT token', { type: 'arrow', x: 100, y: 25, points: [[0, 0], [60, 0]] }, { x: 60, y: 15, width: 140 });
    expect(layoutIssues([el('a'), ...arrow])).toEqual([
      'label of arrow "calls with a JWT token" [ar] is longer than the arrow: shorten it or move the shapes apart',
      'label of arrow "calls with a JWT token" [ar] lies on rectangle [a]'
    ]);
  });

  it('reports shapes that partly overlap, not one inside another', () => {
    expect(layoutIssues([el('a'), el('b', { x: 50 }), el('in', { x: 500, width: 10, height: 10 }), el('out', { x: 490, width: 100, height: 100 })]))
      .toEqual(['rectangle [a] overlaps rectangle [b]']);
  });

  it('reports an element sticking out of its frame', () => {
    const f = el('f', { type: 'frame', name: 'VPC', width: 200, height: 200 });
    expect(layoutIssues([f, el('a', { x: 150, frameId: 'f' })])).toEqual(['rectangle [a] sticks out of frame "VPC"']);
  });

  it('reports a label off the centre of its shape', () => {
    expect(layoutIssues(labelled('a', 'Auth', {}, { x: 35 }))).toEqual(['label of rectangle "Auth" [a] is off its centre: update the shape to re-centre it']);
  });

  it('reports arrow labels that overlap each other or lie on a frame edge', () => {
    const f = el('f', { type: 'frame', name: 'VPC', x: 0, y: -100, width: 130, height: 300 });
    const one = labelled('a1', 'calls', { type: 'arrow', x: 0, y: 25, points: [[0, 0], [300, 0]] }, { x: 110, y: 15, width: 40 });
    const two = labelled('a2', 'reads', { type: 'arrow', x: 0, y: 30, points: [[0, 0], [300, 0]] }, { x: 120, y: 20, width: 40 });
    expect(layoutIssues([f, ...one, ...two])).toEqual([
      'label of arrow "calls" [a1] lies on the edge of frame "VPC"',
      'label of arrow "reads" [a2] lies on the edge of frame "VPC"',
      'labels of arrow "calls" [a1] and arrow "reads" [a2] overlap'
    ]);
  });

  it('reports an arrow crossing a shape it does not connect', () => {
    const arrow = el('ar', { type: 'arrow', x: 100, y: 25, points: [[0, 0], [400, 0]], startBinding: { elementId: 'a' }, endBinding: { elementId: 'c' } });
    const box = el('box', { x: -50, y: -50, width: 700, height: 200 });
    expect(layoutIssues([el('a'), el('b', { x: 250 }), el('c', { x: 500 }), arrow, box], ['ar'])).toEqual([
      'arrow [ar] crosses rectangle [b]: move one of them so the arrow goes around'
    ]);
  });

  it('keeps to the given elements', () => {
    const scene = [el('a'), el('b', { x: 50 }), el('c', { x: 500 }), el('d', { x: 550 })];
    expect(layoutIssues(scene, ['c'])).toEqual(['rectangle [c] overlaps rectangle [d]']);
  });
});
