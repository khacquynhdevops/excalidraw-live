import { recordChanges, type ChangesWindow, type Origin, type SceneEl } from '@excalidraw-live/shared';
import { ChangeLog, type ChangeLogOptions } from './changelog.js';
import { hashContent, readScene, serializeScene, writeAtomic } from './file-io.js';

const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;

export interface StoreOptions {
  path: string;
  debounceMs?: number;
  now?: () => number;
  log?: ChangeLogOptions;
}

// In-memory scene for one diagram, mirrored to a `.excalidraw` file.
// Tombstones (`isDeleted`) stay in the map and the file so that a delete is
// always an explicit record, never inferred from absence. They are pruned
// once older than 24h.
//
// Every write is also logged per element (see changelog.ts), so readers can
// ask what changed since a revision.
export class SceneStore {
  readonly path: string;
  revision = 0;
  // Hash of the last content this store wrote, so the file watcher can tell
  // its own writes from outside edits.
  lastWrittenHash: string | null = null;

  private elements = new Map<string, SceneEl>();
  private appState: Record<string, unknown> = {};
  private files: Record<string, unknown> = {};
  private debounceMs: number;
  private now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> | null = null;
  private dirty = false;
  private log: ChangeLog | null = null;
  // When a person (browser or text editor) last changed each element.
  private humanEdits = new Map<string, number>();

  constructor(opts: StoreOptions) {
    this.path = opts.path;
    this.debounceMs = opts.debounceMs ?? 500;
    this.now = opts.now ?? Date.now;
  }

  static async load(opts: StoreOptions): Promise<SceneStore> {
    const store = new SceneStore(opts);
    const scene = await readScene(opts.path);
    for (const el of scene.elements) store.elements.set(el.id, el);
    store.appState = scene.appState;
    store.files = scene.files;
    store.log = await ChangeLog.load(`${opts.path}.log.jsonl`, opts.log);
    store.revision = store.log.lastRev;
    return store;
  }

  get(id: string): SceneEl | undefined {
    return this.elements.get(id);
  }

  all(): SceneEl[] {
    return [...this.elements.values()];
  }

  // Store elements as given, log what changed and schedule a save. Version
  // rules are the caller's job (see applyPatch).
  upsert(els: SceneEl[], origin: Origin = 'human'): number {
    const prev = new Map(els.map((el) => [el.id, this.elements.get(el.id)]));
    for (const el of els) this.elements.set(el.id, el);
    if (origin !== 'agent') for (const el of els) this.humanEdits.set(el.id, this.now());
    this.revision++;
    this.log?.append(recordChanges(
      els.map((el) => el.id),
      (id) => (prev.has(id) ? prev.get(id) : this.elements.get(id)),
      (id) => this.elements.get(id),
      { rev: this.revision, origin, at: new Date(this.now()).toISOString() }
    ), this.revision);
    this.scheduleSave();
    return this.revision;
  }

  lastHumanEdit(id: string): number | undefined {
    return this.humanEdits.get(id);
  }

  // Logged changes after revision `since`, for a report (formatReport).
  changesSince(since: number): ChangesWindow {
    return {
      since,
      rev: this.revision,
      reset: since > this.revision,
      truncated: !!this.log && since < this.log.evictedUpTo,
      records: this.log?.after(since) ?? []
    };
  }

  getFiles(): Record<string, unknown> {
    return this.files;
  }

  // Excalidraw files are immutable per id, so a known id is never replaced.
  // Returns the ids that were new.
  addFiles(files: Record<string, unknown>): string[] {
    const added = Object.keys(files).filter((id) => !(id in this.files));
    for (const id of added) this.files[id] = files[id];
    if (added.length) this.scheduleSave();
    return added;
  }

  // Write now, skipping the debounce.
  async flush(): Promise<void> {
    this.clearTimer();
    this.dirty = true;
    await this.drain();
    await this.log?.idle();
  }

  // Resolves once no save is pending or in flight.
  async idle(): Promise<void> {
    while (this.timer || this.writing) {
      if (this.writing) await this.writing;
      else await new Promise((r) => setTimeout(r, this.debounceMs));
    }
    await this.log?.idle();
  }

  private scheduleSave(): void {
    this.dirty = true;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      // A failed save must not take the server down; the scene stays in
      // memory and the next change tries again.
      this.drain().catch((err) => console.error(`save failed: ${this.path}:`, err.message));
    }, this.debounceMs);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // One write at a time; changes that land mid-write trigger another pass
  // instead of being dropped.
  private async drain(): Promise<void> {
    if (this.writing) return this.writing;
    this.writing = (async () => {
      while (this.dirty) {
        this.dirty = false;
        this.pruneTombstones();
        const content = serializeScene({ elements: this.all(), appState: this.appState, files: this.files });
        try {
          await writeAtomic(this.path, content);
        } catch (err) {
          this.dirty = true;
          throw err;
        }
        this.lastWrittenHash = hashContent(content);
      }
    })();
    try {
      await this.writing;
    } finally {
      this.writing = null;
    }
  }

  private pruneTombstones(): void {
    const cutoff = this.now() - TOMBSTONE_TTL_MS;
    for (const [id, el] of this.elements) {
      if (el.isDeleted && el.updated < cutoff) this.elements.delete(id);
    }
  }
}
