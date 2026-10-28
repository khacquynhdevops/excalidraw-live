import { appendFile, readFile } from 'node:fs/promises';
import type { ChangeRecord } from '@excalidraw-live/shared';
import { writeAtomic } from './file-io.js';

export interface ChangeLogOptions {
  maxRecords?: number;
  maxBytes?: number;
}

// A diagram's revision log: the newest records in memory, and all of them
// appended to `<file>.log.jsonl` so a restart keeps the history. Once the
// file passes `maxBytes` it is rewritten with its newest half.
export class ChangeLog {
  // Records at or below this revision are no longer kept.
  evictedUpTo = 0;
  lastRev = 0;

  private records: ChangeRecord[] = [];
  private lines: string[] = [];
  private bytes = 0;
  private maxRecords: number;
  private maxBytes: number;
  private writing: Promise<void> = Promise.resolve();
  // Lines not yet appended to the file. A burst of edits becomes one write.
  private pending: string[] = [];
  private rewrite = false;
  private scheduled = false;

  private constructor(readonly path: string, opts: ChangeLogOptions) {
    this.maxRecords = opts.maxRecords ?? 5000;
    this.maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  }

  static async load(path: string, opts: ChangeLogOptions = {}): Promise<ChangeLog> {
    const log = new ChangeLog(path, opts);
    let raw = '';
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        log.keep(r.id === undefined ? null : r, `${line}\n`, r.rev);
      } catch {
        // A line cut short by a crash; the rest of the log is still good.
      }
    }
    if (log.lines.length) log.evictedUpTo = Math.max(log.evictedUpTo, JSON.parse(log.lines[0]).rev - 1);
    return log;
  }

  // A revision whose write changed nothing a report shows is still logged,
  // as a bare `{"rev":N}` line, so a restart resumes from it and never hands
  // out a revision number twice.
  append(records: ChangeRecord[], rev = records[0]?.rev): void {
    const chunk = records.length ? records.map((r) => `${JSON.stringify(r)}\n`) : [`${JSON.stringify({ rev })}\n`];
    if (records.length) for (let i = 0; i < records.length; i++) this.keep(records[i], chunk[i]);
    else this.keep(null, chunk[0], rev);
    if (this.bytes > this.maxBytes) {
      this.trimFile();
      this.rewrite = true;
    } else {
      this.pending.push(...chunk);
    }
    this.schedule();
  }

  // Records newer than `rev`, oldest first.
  after(rev: number): ChangeRecord[] {
    return this.records.filter((r) => r.rev > rev);
  }

  async idle(): Promise<void> {
    await this.writing;
  }

  private keep(r: ChangeRecord | null, line: string, rev = r!.rev): void {
    if (r) this.records.push(r);
    this.lines.push(line);
    this.bytes += Buffer.byteLength(line);
    this.lastRev = Math.max(this.lastRev, rev);
    if (this.records.length > this.maxRecords) {
      const gone = this.records.splice(0, this.records.length - this.maxRecords);
      this.evictedUpTo = Math.max(this.evictedUpTo, gone[gone.length - 1].rev);
    }
  }

  // Drop the oldest lines until the file is back to half the cap. A revision
  // is never split, so a reader sees either all of its records or none.
  private trimFile(): void {
    const revAt = (i: number) => JSON.parse(this.lines[i]).rev as number;
    let drop = 0;
    while (drop < this.lines.length - 1 && (this.bytes > this.maxBytes / 2 || (drop > 0 && revAt(drop) === revAt(drop - 1)))) {
      this.bytes -= Buffer.byteLength(this.lines[drop++]);
    }
    if (drop) {
      const lastDropped = JSON.parse(this.lines[drop - 1]).rev as number;
      this.lines.splice(0, drop);
      this.evictedUpTo = Math.max(this.evictedUpTo, lastDropped);
      this.records = this.records.filter((r) => r.rev > this.evictedUpTo);
    }
  }

  // One write at a time. What to write is decided when the write starts, so
  // a rewrite always holds every line kept so far. A failed write is
  // reported and the next one still runs.
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.writing = this.writing.then(async () => {
      this.scheduled = false;
      const text = this.rewrite ? this.lines.join('') : this.pending.join('');
      const rewrite = this.rewrite;
      this.rewrite = false;
      this.pending = [];
      if (rewrite) await writeAtomic(this.path, text);
      else if (text) await appendFile(this.path, text);
    }).catch((err) => console.error(`change log write failed: ${this.path}:`, err.message));
  }
}
