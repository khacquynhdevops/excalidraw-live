import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { SceneEl } from '@excalidraw-live/shared';

export interface SceneData {
  elements: SceneEl[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}

// A standard `.excalidraw` document, openable on excalidraw.com.
export function serializeScene(scene: SceneData): string {
  return JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'excalidraw-live',
    elements: scene.elements,
    appState: scene.appState,
    files: scene.files
  }, null, 2) + '\n';
}

export async function readScene(path: string): Promise<SceneData> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { elements: [], appState: {}, files: {} };
    throw err;
  }
  const doc = JSON.parse(raw);
  return { elements: doc.elements ?? [], appState: doc.appState ?? {}, files: doc.files ?? {} };
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// Write to a temp file in the same directory, fsync, then rename over the
// target, so readers (git, the file watcher, excalidraw.com) never see a
// half-written scene.
export async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(content, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
