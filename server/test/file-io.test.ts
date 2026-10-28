import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAtomic, readScene, serializeScene, hashContent } from '../src/file-io.js';
import { el } from './helpers.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'xl-fileio-')); });

describe('writeAtomic', () => {
  it('writes the content and leaves no temp file behind', async () => {
    const path = join(dir, 'a.excalidraw');
    await writeAtomic(path, 'hello');
    expect(readFileSync(path, 'utf8')).toBe('hello');
    expect(readdirSync(dir)).toEqual(['a.excalidraw']);
  });

  it('replaces an existing file', async () => {
    const path = join(dir, 'a.excalidraw');
    await writeAtomic(path, 'one');
    await writeAtomic(path, 'two');
    expect(readFileSync(path, 'utf8')).toBe('two');
  });
});

describe('serializeScene / readScene', () => {
  it('writes a standard .excalidraw document', () => {
    const doc = JSON.parse(serializeScene({ elements: [el('a')], appState: {}, files: {} }));
    expect(doc.type).toBe('excalidraw');
    expect(doc.version).toBe(2);
    expect(doc.elements).toHaveLength(1);
    expect(doc.files).toEqual({});
  });

  it('round-trips elements, appState and files', async () => {
    const path = join(dir, 's.excalidraw');
    const scene = {
      elements: [el('a'), el('b', { isDeleted: true })],
      appState: { viewBackgroundColor: '#fff' },
      files: { f1: { id: 'f1', mimeType: 'image/png', dataURL: 'data:' } }
    };
    writeFileSync(path, serializeScene(scene));
    expect(await readScene(path)).toEqual(scene);
  });

  it('returns an empty scene when the file does not exist', async () => {
    expect(await readScene(join(dir, 'missing.excalidraw')))
      .toEqual({ elements: [], appState: {}, files: {} });
  });
});

describe('hashContent', () => {
  it('is stable and content-sensitive', () => {
    expect(hashContent('x')).toBe(hashContent('x'));
    expect(hashContent('x')).not.toBe(hashContent('y'));
  });
});
