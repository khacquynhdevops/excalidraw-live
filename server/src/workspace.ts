import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DIAGRAM_KINDS, type DiagramEntry, type DiagramKind, type SceneEl } from '@excalidraw-live/shared';
import { serializeScene, writeAtomic } from './file-io.js';
import { SceneStore } from './store.js';
import { watchStore } from './watch.js';

export interface WorkspaceOptions {
  dir: string;
  debounceMs?: number;
  now?: () => number;
  // Where each role's read position is kept across restarts.
  cursorsPath?: string;
}

export interface NewDiagram {
  name: string;
  kind: DiagramKind;
  owner: string;
  audience?: string[];
  refines?: string;
}

export interface Binding {
  diagramId: string;
  mode: 'writer' | 'reader';
  // Session holding the writer lease, if any, its role and how long it has
  // been idle.
  writer?: string;
  writerRole?: string;
  writerIdleSeconds?: number;
}

// Elements (and new files) merged from an outside edit of a diagram file.
export type FileChangeListener = (diagramId: string, rev: number, elements: SceneEl[], files: Record<string, unknown>) => void;

// Thrown for bad input; the HTTP layer turns it into a 400.
export class WorkspaceError extends Error {}

const INDEX = 'diagrams.json';

// MCP servers use `mcp-<pid>` as their session id.
function sessionAlive(sessionId: string): boolean {
  const m = /^mcp-(\d+)$/.exec(sessionId);
  if (!m) return true;
  try {
    process.kill(Number(m[1]), 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function slug(name: string): string {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'diagram';
}

// A folder of diagrams: `diagrams.json` lists them, each has its own
// `.excalidraw` file and, once opened, its own SceneStore.
//
// Sessions (one Claude Code session = one role) bind to a single diagram.
// The diagram's owner role writes; another role writes only when it asks to
// edit (after the user confirmed). One session at a time holds that writer
// lease; everyone else reads. A session left open elsewhere keeps the lease
// until it closes, or until another session takes it over (again after the
// user confirmed).
export class Workspace {
  readonly dir: string;
  private entries: DiagramEntry[] = [];
  private stores = new Map<string, Promise<SceneStore>>();
  private sessions = new Map<string, Binding & { as: string; active: number }>();
  private leases = new Map<string, string>(); // diagramId → sessionId
  private unwatch: (() => Promise<void>)[] = [];
  private fileListeners = new Set<FileChangeListener>();
  // "<diagramId> <role>" → the last revision that role has read.
  private cursors: Record<string, number> = {};
  private savingCursors: Promise<void> = Promise.resolve();

  private constructor(private opts: WorkspaceOptions) {
    this.dir = opts.dir;
  }

  static async load(opts: WorkspaceOptions): Promise<Workspace> {
    const ws = new Workspace(opts);
    try {
      ws.entries = JSON.parse(await readFile(join(opts.dir, INDEX), 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (opts.cursorsPath) {
      try {
        ws.cursors = JSON.parse(await readFile(opts.cursorsPath, 'utf8'));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    return ws;
  }

  list(): DiagramEntry[] {
    return this.entries;
  }

  get(id: string): DiagramEntry | undefined {
    return this.entries.find((d) => d.id === id);
  }

  async create(input: NewDiagram): Promise<DiagramEntry> {
    const name = input.name?.trim();
    const owner = input.owner?.trim();
    if (!name) throw new WorkspaceError('name is required');
    if (!owner) throw new WorkspaceError('owner is required');
    if (!DIAGRAM_KINDS.includes(input.kind)) throw new WorkspaceError(`unknown kind: ${input.kind}`);

    let id: string;
    do id = 'd_' + [...randomBytes(6)].map((b) => (b % 36).toString(36)).join('');
    while (this.get(id));

    const taken = new Set(this.entries.map((d) => d.file));
    const stem = slug(name);
    let file = `${stem}.excalidraw`;
    for (let n = 2; taken.has(file); n++) file = `${stem}-${n}.excalidraw`;

    const entry: DiagramEntry = { id, name, file, kind: input.kind, owner, audience: input.audience ?? [] };
    if (input.refines) entry.refines = input.refines;

    await writeAtomic(join(this.dir, file), serializeScene({ elements: [], appState: {}, files: {} }));
    // Change logs are local history, not part of the diagram.
    await writeFile(join(this.dir, '.gitignore'), '*.log.jsonl\n', { flag: 'wx' }).catch((err) => {
      if (err.code !== 'EEXIST') throw err;
    });
    this.entries = [...this.entries, entry];
    await this.saveIndex();
    return entry;
  }

  async rename(id: string, name: string): Promise<DiagramEntry> {
    const entry = this.require(id);
    if (!name?.trim()) throw new WorkspaceError('name is required');
    const renamed = { ...entry, name: name.trim() };
    this.entries = this.entries.map((d) => (d.id === id ? renamed : d));
    await this.saveIndex();
    return renamed;
  }

  // Opened on first use and kept for the life of the workspace. From then on
  // its file is watched for outside edits.
  store(id: string): Promise<SceneStore> {
    let s = this.stores.get(id);
    if (!s) {
      const entry = this.get(id);
      if (!entry) return Promise.reject(new WorkspaceError(`unknown diagram: ${id}`));
      s = SceneStore.load({ path: join(this.dir, entry.file), debounceMs: this.opts.debounceMs, now: this.opts.now })
        .then((store) => {
          this.unwatch.push(watchStore(store, (els, files) => {
            for (const fn of this.fileListeners) fn(id, store.revision, els, files);
          }));
          return store;
        });
      this.stores.set(id, s);
    }
    return s;
  }

  onFileChange(fn: FileChangeListener): void {
    this.fileListeners.add(fn);
  }

  bind(sessionId: string, diagramId: string, as: string, edit = false, takeover = false): Binding {
    const entry = this.require(diagramId);
    this.release(sessionId);
    // An MCP session that died without saying so must not keep the lease.
    const held = this.leases.get(diagramId);
    if (held && !sessionAlive(held)) this.release(held);
    const holder = this.leases.get(diagramId);
    const now = this.opts.now?.() ?? Date.now();
    let binding: Binding;
    if ((as === entry.owner || edit) && (!holder || takeover)) {
      // The session that held it reads from now on.
      const old = holder ? this.sessions.get(holder) : undefined;
      if (old) this.sessions.set(holder!, { ...old, mode: 'reader', writer: sessionId });
      this.leases.set(diagramId, sessionId);
      binding = { diagramId, mode: 'writer', writer: sessionId };
    } else {
      const h = holder ? this.sessions.get(holder) : undefined;
      binding = {
        diagramId, mode: 'reader', writer: holder,
        ...(h && { writerRole: h.as, writerIdleSeconds: Math.round((now - h.active) / 1000) })
      };
    }
    this.sessions.set(sessionId, { ...binding, as, active: now });
    return binding;
  }

  release(sessionId: string): void {
    const b = this.sessions.get(sessionId);
    if (!b) return;
    if (this.leases.get(b.diagramId) === sessionId) this.leases.delete(b.diagramId);
    this.sessions.delete(sessionId);
  }

  assertWrite(sessionId: string, diagramId: string): void {
    const b = this.sessions.get(sessionId);
    if (!b) throw new WorkspaceError(`session ${sessionId} is not bound to a diagram`);
    if (b.diagramId !== diagramId) throw new WorkspaceError(`session is bound to ${b.diagramId}, not ${diagramId}`);
    if (this.leases.get(diagramId) !== sessionId) throw new WorkspaceError(`${diagramId} is read-only for this session`);
    b.active = this.opts.now?.() ?? Date.now();
  }

  // Last revision `role` has read on a diagram; undefined before its first bind.
  cursor(diagramId: string, role: string): number | undefined {
    return this.cursors[`${diagramId} ${role}`];
  }

  // Saves are queued so two quick reads cannot race on the same file.
  setCursor(diagramId: string, role: string, rev: number): Promise<void> {
    this.cursors = { ...this.cursors, [`${diagramId} ${role}`]: rev };
    const path = this.opts.cursorsPath;
    if (!path) return Promise.resolve();
    this.savingCursors = this.savingCursors
      .then(() => writeAtomic(path, JSON.stringify(this.cursors, null, 2) + '\n'))
      .catch((err) => console.error(`saving read cursors failed: ${err.message}`));
    return this.savingCursors;
  }

  async close(): Promise<void> {
    await Promise.all(this.unwatch.splice(0).map((stop) => stop()));
    await Promise.all([...this.stores.values()].map(async (s) => (await s).flush()));
  }

  private require(id: string): DiagramEntry {
    const entry = this.get(id);
    if (!entry) throw new WorkspaceError(`unknown diagram: ${id}`);
    return entry;
  }

  private saveIndex(): Promise<void> {
    return writeAtomic(join(this.dir, INDEX), JSON.stringify(this.entries, null, 2) + '\n');
  }
}
