import { describe, it, expect } from 'vitest';
import { parseRef, formatRef } from '../src/ref.js';

describe('parseRef', () => {
  it('reads the agent form', () => {
    expect(parseRef('dl://d_x@57#el')).toEqual({ id: 'd_x', rev: 57, elementId: 'el' });
  });

  it('reads the agent form without rev or element', () => {
    expect(parseRef('dl://d_x')).toEqual({ id: 'd_x' });
    expect(parseRef('dl://d_x@3')).toEqual({ id: 'd_x', rev: 3 });
    expect(parseRef('dl://d_x#el')).toEqual({ id: 'd_x', elementId: 'el' });
  });

  it('reads the browser URL form', () => {
    expect(parseRef('http://127.0.0.1:3000/d/d_x?rev=57#el')).toEqual({ id: 'd_x', rev: 57, elementId: 'el' });
    expect(parseRef('http://localhost:3000/d/d_x')).toEqual({ id: 'd_x' });
  });

  it('keeps element ids with Excalidraw characters', () => {
    expect(parseRef('dl://d_x@1#Ab-3_kZ')?.elementId).toBe('Ab-3_kZ');
    expect(parseRef('http://127.0.0.1:3000/d/d_x?rev=1#Ab-3_kZ')?.elementId).toBe('Ab-3_kZ');
  });

  it('returns null for anything else', () => {
    for (const s of ['', 'd_x', 'dl://', 'dl://d_x@abc', 'http://127.0.0.1:3000/x/d_x', 'http://127.0.0.1:3000/d/d_x?rev=-1', 'not a url']) {
      expect(parseRef(s), s).toBeNull();
    }
  });
});

describe('formatRef', () => {
  it('writes the agent form by default', () => {
    expect(formatRef({ id: 'd_x', rev: 57, elementId: 'el' })).toBe('dl://d_x@57#el');
    expect(formatRef({ id: 'd_x' })).toBe('dl://d_x');
  });

  it('writes the browser URL form given a base URL', () => {
    expect(formatRef({ id: 'd_x', rev: 57, elementId: 'el' }, 'http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000/d/d_x?rev=57#el');
    expect(formatRef({ id: 'd_x' }, 'http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000/d/d_x');
  });

  it('round-trips both forms', () => {
    const ref = { id: 'd_x', rev: 9, elementId: 'Ab-3' };
    expect(parseRef(formatRef(ref))).toEqual(ref);
    expect(parseRef(formatRef(ref, 'http://127.0.0.1:3000'))).toEqual(ref);
  });
});
