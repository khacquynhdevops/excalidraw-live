// Types shared by server, mcp and web.

// An Excalidraw element as the server sees it. Only the fields sync depends on
// are typed; everything else passes through untouched so the file stays a
// plain `.excalidraw` scene. Deletes are tombstones (`isDeleted: true`), never
// absence from a patch.
export interface SceneEl {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  updated: number;
  [field: string]: unknown;
}

// Who made a change: the person in the browser, Claude via MCP, or an edit to
// the file on disk from outside the server.
export type Origin = 'human' | 'agent' | 'file';

export type ChangeKind = 'add' | 'update' | 'delete';

// One entry in a diagram's revision log.
export interface ChangeRecord {
  rev: number;
  kind: ChangeKind;
  id: string;
  origin: Origin;
  // ISO timestamp
  at: string;
  // Element type, kept so deletes stay describable after the element is gone.
  type: string;
  label?: string;
  // For updates: only the fields that differed.
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

export const DIAGRAM_KINDS = [
  'overview', 'c4-context', 'c4-container', 'sequence',
  'flow', 'erd', 'state', 'wireframe', 'free',
  'journey', 'timeline', 'c4-component', 'test-map',
  'pipeline', 'deployment', 'threat-model', 'story-map',
  'network', 'health-model'
] as const;

export type DiagramKind = (typeof DIAGRAM_KINDS)[number];

// One entry in `diagrams.json`. `id` is stable; `file` and `name` may change.
export interface DiagramEntry {
  id: string;
  name: string;
  // Relative to DIAGRAMS_DIR.
  file: string;
  kind: DiagramKind;
  // The one role that may write this diagram, e.g. "po".
  owner: string;
  // Roles that read it, e.g. ["swe", "tester"].
  audience: string[];
  // `<diagramId>#<elementId>` of the element this diagram details.
  refines?: string;
}

// Points at a diagram, optionally at a revision and one element. Sent between
// role sessions as `dl://<id>@<rev>#<elementId>` (see ref.ts).
export interface BoardRef {
  id: string;
  rev?: number;
  elementId?: string;
}

// A question one role asks another about a board.
export interface Question {
  id: string;
  ref: BoardRef;
  fromRole: string;
  toRole: string;
  text: string;
  // ISO timestamp
  at: string;
  answer?: { text: string; ref?: BoardRef; at: string };
}
