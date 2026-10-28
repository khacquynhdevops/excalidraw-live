import type { SceneEl } from '@excalidraw-live/shared';

export function el(id: string, over: Partial<SceneEl> = {}): SceneEl {
  return {
    id, type: 'rectangle', x: 0, y: 0, width: 100, height: 50,
    version: 1, versionNonce: 1, isDeleted: false, updated: Date.now(),
    ...over
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
