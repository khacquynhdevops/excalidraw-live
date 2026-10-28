// What the MCP server asks the canvas server. Claude does not read the board
// on its own: each role keeps a read position per diagram, `status` says only
// how much is unread, and `changes` / `wait` hand over the report and move
// the position forward.
//
//   POST   /api/sessions               bind {session, diagramId, as} → {mode, writer, rev}
//   DELETE /api/sessions/:session      release
//   GET    /api/diagrams/:id/scene     {rev, elements} without tombstones
//   GET    /api/diagrams/:id/status?as=role     {unread, fromRev, toRev, name}
//   POST   /api/diagrams/:id/changes  {as, since?, origin?}  → report
//   POST   /api/diagrams/:id/wait     {as, since?, idleSeconds?, timeoutSeconds?, origin?}
//   POST   /api/diagrams/:id/apply    {session, ops, frameId?, color?} → {rev, applied, conflicts, frameId?}
//   POST   /api/diagrams/:id/accept   {session, frameId, elementIds?, keepColor?}
//                                      → {rev, accepted, conflicts, frameDeleted}
//                                      apply and accept: only the session holding the writer lease
//
// Without `since`, changes and wait read from the role's position and move it
// to the revision they report. With `since`, the position is left alone.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { alive, foldChanges, formatReport, type ChangeRecord, type ChangesWindow } from '@excalidraw-live/shared';
import type { SceneStore } from './store.js';
import { WorkspaceError, type Workspace } from './workspace.js';
import type { SyncRooms } from './ws.js';
import { json, readJson } from './json.js';
import { acceptProposal, agentWrite } from './agent-write.js';

type OriginFilter = 'any' | 'human' | 'agent';

const POLL_MS = 200;

// "human" covers edits made in a text editor too: both came from a person.
function matches(filter: OriginFilter) {
  return (r: ChangeRecord) => filter === 'any' || (filter === 'agent' ? r.origin === 'agent' : r.origin !== 'agent');
}

function originOf(v: unknown, fallback: OriginFilter): OriginFilter {
  if (v === undefined) return fallback;
  if (v === 'any' || v === 'human' || v === 'agent') return v;
  throw new WorkspaceError(`origin must be any, human or agent`);
}

function role(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) throw new WorkspaceError('as (role) is required');
  return v.trim();
}

function seconds(v: unknown, fallback: number, min: number, max: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new WorkspaceError(`expected ${min}–${max} seconds, got ${v}`);
  return n;
}

function windowFor(store: SceneStore, since: number, filter: OriginFilter): ChangesWindow {
  const w = store.changesSince(since);
  return { ...w, records: w.records.filter(matches(filter)) };
}

// Returns false when the path is not one of these routes.
export async function agentApi(workspace: Workspace, rooms: SyncRooms, url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = url.pathname;

  if (path === '/api/sessions' && req.method === 'POST') {
    const b = await readJson(req);
    const session = String(b.session ?? '');
    if (!session) throw new WorkspaceError('session is required');
    const as = role(b.as);
    const diagramId = String(b.diagramId ?? '');
    const binding = workspace.bind(session, diagramId, as);
    const store = await workspace.store(diagramId);
    // A role's first bind starts reading from now, not from the board's birth.
    if (workspace.cursor(diagramId, as) === undefined) await workspace.setCursor(diagramId, as, store.revision);
    json(res, 200, { ...binding, rev: store.revision });
    return true;
  }

  const s = /^\/api\/sessions\/([^/]+)$/.exec(path);
  if (s && req.method === 'DELETE') {
    workspace.release(decodeURIComponent(s[1]));
    json(res, 200, { ok: true });
    return true;
  }

  const m = /^\/api\/diagrams\/([^/]+)\/(scene|status|changes|wait|apply|accept)$/.exec(path);
  if (!m) return false;
  const id = decodeURIComponent(m[1]);
  const entry = workspace.get(id);
  if (!entry) {
    json(res, 404, { error: `unknown diagram: ${id}` });
    return true;
  }
  const store = await workspace.store(id);
  const route = `${req.method} ${m[2]}`;

  if (route === 'GET scene') {
    json(res, 200, { rev: store.revision, elements: store.all().filter(alive) });
    return true;
  }

  if (route === 'GET status') {
    const as = role(url.searchParams.get('as'));
    const cursor = workspace.cursor(id, as) ?? store.revision;
    // The owner's own agent wrote those; they are not news to it.
    const w = windowFor(store, cursor, as === entry.owner ? 'human' : 'any');
    json(res, 200, { unread: foldChanges(w.records).length, fromRev: cursor, toRev: store.revision, name: entry.name });
    return true;
  }

  if (route === 'POST changes') {
    const b = await readJson(req);
    const as = role(b.as);
    const explicit = b.since !== undefined;
    const since = explicit ? Number(b.since) : workspace.cursor(id, as) ?? store.revision;
    if (!Number.isInteger(since) || since < 0) throw new WorkspaceError('since must be a revision number');
    const w = windowFor(store, since, originOf(b.origin, 'any'));
    if (!explicit) await workspace.setCursor(id, as, w.rev);
    json(res, 200, { since: w.since, rev: w.rev, truncated: w.truncated, reset: w.reset, report: formatReport(w, store.all()) });
    return true;
  }

  if (route === 'POST wait') {
    const b = await readJson(req);
    const as = role(b.as);
    const explicit = b.since !== undefined;
    const since = explicit ? Number(b.since) : workspace.cursor(id, as) ?? store.revision;
    if (!Number.isInteger(since) || since < 0) throw new WorkspaceError('since must be a revision number');
    const filter = originOf(b.origin, 'human');
    const idleMs = seconds(b.idleSeconds, 3, 1, 30) * 1000;
    const deadline = Date.now() + seconds(b.timeoutSeconds, 90, 1, 240) * 1000;

    const browsers = () => [...(rooms.presence(id)?.values() ?? [])];
    if (!browsers().length) {
      json(res, 200, { status: 'no_browser', rev: store.revision });
      return true;
    }
    for (;;) {
      if (res.destroyed) return true;
      const w = windowFor(store, since, filter);
      const last = w.records.at(-1);
      const editing = browsers().some((p) => !p.idle || p.editingId);
      if (last && !editing && Date.now() - Date.parse(last.at) >= idleMs) {
        if (!explicit) await workspace.setCursor(id, as, w.rev);
        json(res, 200, { status: 'changes', since: w.since, rev: w.rev, truncated: w.truncated, reset: w.reset, report: formatReport(w, store.all()) });
        return true;
      }
      if (Date.now() >= deadline) {
        json(res, 200, { status: 'timeout', rev: store.revision, ...(last && { editing }) });
        return true;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  if (route === 'POST apply') {
    const b = await readJson(req);
    workspace.assertWrite(String(b.session ?? ''), id);
    const presence = [...(rooms.presence(id)?.values() ?? [])];
    const { elements, ...result } = agentWrite(store, b.ops, {
      presence,
      ...((typeof b.frameId === 'string' || b.frameId === null) && { frameId: b.frameId }),
      ...(typeof b.color === 'string' && { color: b.color })
    });
    if (elements.length) rooms.broadcast(id, { t: 'scene_patch', rev: result.rev, origin: 'agent', elements });
    json(res, 200, result);
    return true;
  }

  if (route === 'POST accept') {
    const b = await readJson(req);
    workspace.assertWrite(String(b.session ?? ''), id);
    const ids = b.elementIds;
    if (ids !== undefined && !(Array.isArray(ids) && ids.every((x) => typeof x === 'string'))) throw new WorkspaceError('elementIds must be a list of ids');
    const { elements, ...result } = acceptProposal(store, {
      frameId: String(b.frameId ?? ''),
      ...(ids && { elementIds: ids }),
      keepColor: b.keepColor === true,
      presence: [...(rooms.presence(id)?.values() ?? [])]
    });
    if (elements.length) rooms.broadcast(id, { t: 'scene_patch', rev: result.rev, origin: 'agent', elements });
    json(res, 200, result);
    return true;
  }

  json(res, 405, { error: 'method not allowed' });
  return true;
}
