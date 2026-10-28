// WebSocket messages between browser and canvas server.
import type { Origin, SceneEl } from './types.js';

// Excalidraw's BinaryFileData, kept loose: files pass through untouched.
export type SceneFile = { id: string; dataURL: string; [field: string]: unknown };
export type SceneFiles = Record<string, SceneFile>;

export interface Presence {
  // Text element being typed in, if any.
  editingId: string | null;
  selectedIds: string[];
  // False while drawing, dragging, resizing or typing.
  idle: boolean;
}

export type ClientMsg =
  // Only changed elements, tombstones included. `baseRev` is the last server
  // rev the client had applied.
  | { t: 'client_patch'; clientId: string; baseRev: number; elements: SceneEl[]; files?: SceneFiles }
  | ({ t: 'presence'; clientId: string } & Presence);

export type ServerMsg =
  | { t: 'scene_init'; rev: number; elements: SceneEl[]; files: SceneFiles }
  | { t: 'scene_patch'; rev: number; origin: Origin; elements: SceneEl[]; files?: SceneFiles }
  // Sent only to the patch's author: the server's newer copies of elements it refused.
  | { t: 'patch_rejected'; rev: number; elements: SceneEl[] };
