import { randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { watch } from 'chokidar';
import type { SceneEl } from '@excalidraw-live/shared';
import { hashContent } from './file-io.js';
import type { SceneStore } from './store.js';

// Key order does not matter: editors and jq may reorder fields.
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

// Merge the elements read from the diagram file into the store.
//
// Higher versions win as usual. A hand edit (jq, a text editor, a git merge
// that kept the version) changes content without bumping the version, so a
// copy at the stored version but with different content is taken as newer
// and given the next version. A lower version is stale: the store has edits
// not yet saved. Elements missing from the file are left alone.
export function mergeFromFile(store: SceneStore, elements: SceneEl[], now = Date.now()): SceneEl[] {
  const accepted: SceneEl[] = [];
  for (const el of elements) {
    const stored = store.get(el.id);
    if (!stored || el.version > stored.version) accepted.push(el);
    else if (el.version === stored.version && canonical(el) !== canonical(stored)) {
      accepted.push({ ...el, version: stored.version + 1, versionNonce: randomInt(2 ** 31), updated: now });
    }
  }
  if (accepted.length) store.upsert(accepted, 'file');
  return accepted;
}

// Watch the store's file and merge outside edits. The store's own writes are
// recognised by hash and skipped, so saving a merge does not loop.
export function watchStore(
  store: SceneStore,
  onMerge: (elements: SceneEl[], files: Record<string, unknown>) => void
): () => Promise<void> {
  const watcher = watch(store.path, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 } });
  const check = async () => {
    try {
      const raw = await readFile(store.path, 'utf8');
      if (hashContent(raw) === store.lastWrittenHash) return;
      const doc = JSON.parse(raw);
      const files = store.addFiles(doc.files ?? {});
      const elements = mergeFromFile(store, doc.elements ?? []);
      if (elements.length || files.length) {
        onMerge(elements, Object.fromEntries(files.map((id) => [id, store.getFiles()[id]])));
      }
    } catch (err) {
      console.warn(`ignored outside change to ${store.path}: ${(err as Error).message}`);
    }
  };
  watcher.on('add', check).on('change', check);
  return () => watcher.close();
}
