import type { SceneEl } from '@excalidraw-live/shared';
import type { SceneStore } from './store.js';

// Server-side mirror of excalidraw's shouldDiscardRemoteElement
// (packages/excalidraw/data/reconcile.ts): the higher version wins, and a tie
// goes to the lower versionNonce. The server has no editing state, so the
// "local element is being edited" checks stay in the browser.
export function shouldAccept(stored: SceneEl | undefined, incoming: SceneEl): boolean {
  if (!stored) return true;
  if (incoming.version !== stored.version) return incoming.version > stored.version;
  return incoming.versionNonce < stored.versionNonce;
}

export interface PatchResult {
  accepted: SceneEl[];
  // The stored copy of each element the patch lost to, so the sender can catch up.
  rejected: SceneEl[];
}

// Only the elements in the patch are touched. An element missing from a
// patch is never treated as deleted; deletes arrive as `isDeleted: true`.
export function applyPatch(store: SceneStore, incoming: SceneEl[]): PatchResult {
  const accepted: SceneEl[] = [];
  const rejected: SceneEl[] = [];
  for (const el of incoming) {
    const stored = store.get(el.id);
    if (shouldAccept(stored, el)) accepted.push(el);
    else rejected.push(stored!);
  }
  if (accepted.length) store.upsert(accepted);
  return { accepted, rejected };
}
