// The MCP tools. One instance per Claude Code session (one role), talking to
// the project's canvas server over HTTP. Reading other diagrams works from
// the files alone, so it does not start the server; everything that binds,
// writes or follows live changes does.
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  DIAGRAM_KINDS, alive, formatRef, labelOf, layoutIssues, parseRef, summarizeScene,
  type DiagramEntry, type SceneEl
} from '@excalidraw-live/shared';
import { diagramsDir, ensureServer, findServer, stateDir } from '@excalidraw-live/shared/ensureServer';
import { answerQuestion, askQuestion, inboxFor, markSeen } from '@excalidraw-live/shared/questions';
import { checkConsistency, linkRef } from './consistency.js';
import { conventionLine } from './conventions.js';

export interface BoardServerOptions {
  projectDir: string;
  // Identifies this session to the canvas server; `mcp-<pid>` lets the server
  // take back the writer lease if this process dies.
  sessionId: string;
  // The Claude Code process, so the status line can find this session's board.
  claudePid: number;
  serverEntry?: string;
  // Bind to this diagram on first use instead of waiting for open_diagram.
  diagramId?: string;
  as?: string;
}

class ToolError extends Error {}

interface Binding {
  diagramId: string;
  as: string;
  // Asked to write on a board another role owns (the user confirmed).
  edit?: boolean;
}

type Text = { content: { type: 'text'; text: string }[]; isError?: boolean };

export function createBoardServer(opts: BoardServerOptions) {
  const dir = diagramsDir(opts.projectDir);
  const sessionFile = join(stateDir(opts.projectDir), 'sessions', `${opts.claudePid}.json`);
  let binding: Binding | null = null;

  // ---- files ------------------------------------------------------------

  async function index(): Promise<DiagramEntry[]> {
    try {
      return JSON.parse(await readFile(join(dir, 'diagrams.json'), 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async function entry(id: string): Promise<DiagramEntry> {
    const e = (await index()).find((d) => d.id === id);
    if (!e) throw new ToolError(`unknown diagram: ${id}`);
    return e;
  }

  // The last revision in the change log, as the server will report it.
  async function fileRev(e: DiagramEntry): Promise<number> {
    let raw = '';
    try {
      raw = await readFile(join(dir, `${e.file}.log.jsonl`), 'utf8');
    } catch {
      return 0;
    }
    for (const line of raw.trimEnd().split('\n').reverse()) {
      try {
        return Number(JSON.parse(line).rev) || 0;
      } catch {
        // a line cut short by a crash
      }
    }
    return 0;
  }

  // The live scene when the server runs (it may hold edits not saved yet),
  // otherwise the file.
  async function scene(e: DiagramEntry): Promise<{ rev: number; elements: SceneEl[] }> {
    const live = await findServer(opts.projectDir);
    if (live) return request(live.url, 'GET', `/api/diagrams/${encodeURIComponent(e.id)}/scene`);
    let elements: SceneEl[] = [];
    try {
      elements = JSON.parse(await readFile(join(dir, e.file), 'utf8')).elements ?? [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return { rev: await fileRev(e), elements: elements.filter(alive) };
  }

  // ---- server -----------------------------------------------------------

  async function request<T = any>(base: string, method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ToolError(data.error ?? `${method} ${path}: HTTP ${res.status}`);
    return data;
  }

  // The server, started if needed. A freshly started one does not know this
  // session yet, so the binding is sent again.
  async function server(): Promise<string> {
    const s = await ensureServer(opts.projectDir, { serverEntry: opts.serverEntry });
    if (s.started && binding) await bindOn(s.url, binding);
    return s.url;
  }

  // `takeover` is for this call only: a restarted server must not hand the
  // lease back on its own.
  function bindOn(url: string, b: Binding, takeover = false) {
    return request<{ mode: 'writer' | 'reader'; writer?: string; writerRole?: string; writerIdleSeconds?: number; rev: number }>(
      url, 'POST', '/api/sessions', { session: opts.sessionId, ...b, takeover });
  }

  async function bound(): Promise<Binding & { url: string }> {
    if (!binding && opts.diagramId && opts.as) await open(opts.diagramId, opts.as);
    if (!binding) throw new ToolError('no diagram is open in this session; call open_diagram {id, as} first');
    return { ...binding, url: await server() };
  }

  // "a dev session (mcp-123, idle 12 min)"
  function holder(b: { writer?: string; writerRole?: string; writerIdleSeconds?: number }) {
    if (!b.writer) return 'another session';
    const idle = b.writerIdleSeconds === undefined ? '' : `, idle ${b.writerIdleSeconds < 60 ? `${b.writerIdleSeconds}s` : `${Math.round(b.writerIdleSeconds / 60)} min`}`;
    return `${b.writerRole ? `a ${b.writerRole} session` : 'a session'} (${b.writer}${idle})`;
  }

  async function open(id: string, as: string, edit = false, takeover = false): Promise<string> {
    const e = await entry(id);
    const url = await server();
    const b = await bindOn(url, { diagramId: id, as, edit }, takeover);
    binding = { diagramId: id, as, edit };
    await mkdir(join(sessionFile, '..'), { recursive: true });
    await writeFile(sessionFile, JSON.stringify({ diagramId: id, as, mode: b.mode, session: opts.sessionId }) + '\n');

    // Another session holding the lease is worth naming. Another role's board
    // is read-only until the user confirms editing it.
    const mode = b.mode === 'writer' ? (as === e.owner ? 'writer' : `writer on ${e.owner}'s board`)
      : as === e.owner || edit ? `read-only: ${holder(b)} holds the writer lease. Ask the user whether that session is done with this board; only on yes call open_diagram {id, as${edit ? ', edit: true' : ''}, takeover: true}, after which that session only reads`
      : `read-only: owner is ${e.owner}. To change it, first ask the user in their language "This board belongs to ${e.owner}, not ${as}. Are you sure you want to edit it?" and only on yes call open_diagram {id, as, edit: true}`;
    const lines = [`opened ${id} "${e.name}" as ${as} (${mode}) · rev ${b.rev} · ${url}/d/${encodeURIComponent(id)}`];
    const s = await scene(e);
    lines.push(summarizeScene(s.elements, { rev: s.rev, name: e.name, kind: e.kind, maxLines: 60 }));
    const how = conventionLine(e.kind);
    if (how) lines.push(how);
    const st = await request(url, 'GET', `/api/diagrams/${encodeURIComponent(id)}/status?as=${encodeURIComponent(as)}`);
    if (st.unread) lines.push(`${st.unread} changes since ${as} last read (rev ${st.fromRev}→${st.toRev}); get_changes_since shows them.`);

    // Questions left while this role's session was not running, and answers
    // to its own questions (shown once).
    const inbox = await inboxFor(dir, as);
    for (const q of inbox.pending) lines.push(`question ${q.id} from ${q.from}: "${q.text}" · ${q.ref} (answer {questionId, text, ref?})`);
    for (const q of inbox.answered) lines.push(`answer to ${q.id} from ${q.answer!.by}: "${q.answer!.text}"${q.answer!.ref ? ` · ${q.answer!.ref}` : ''} (you asked: "${q.text}")`);
    if (inbox.answered.length) await markSeen(dir, as, inbox.answered.map((q) => q.id));
    return lines.join('\n');
  }

  // ---- text -------------------------------------------------------------

  const named = (e: DiagramEntry) => `${e.id} "${e.name}"`;

  function elementName(elements: SceneEl[], id: string): string {
    const byId = new Map(elements.map((x) => [x.id, x]));
    const el = byId.get(id);
    const label = el && labelOf(el, (k) => byId.get(k));
    return label ? `"${label}" [${id}]` : `[${id}]`;
  }

  // ---- tools ------------------------------------------------------------

  const mcp = new McpServer({ name: 'excalidraw-live', version: '0.1.0' });

  function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S, run: (args: z.infer<z.ZodObject<S>>) => Promise<string>) {
    mcp.registerTool(name, { description, inputSchema: shape }, (async (args: z.infer<z.ZodObject<S>>): Promise<Text> => {
      try {
        return { content: [{ type: 'text', text: await run(args) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }) as never);
  }

  const origin = z.enum(['human', 'agent', 'any']);

  tool('list_diagrams', 'List the diagrams of this project, with their owner role, audience and current revision. Works without the canvas server.', {
    kind: z.enum(DIAGRAM_KINDS).optional(),
    audience: z.string().optional().describe('only diagrams this role owns or reads')
  }, async ({ kind, audience }) => {
    const rows = (await index()).filter((e) => (!kind || e.kind === kind) && (!audience || e.owner === audience || e.audience.includes(audience)));
    if (!rows.length) return 'no diagrams';
    return (await Promise.all(rows.map(async (e) => {
      const updated = await stat(join(dir, e.file)).then((s) => s.mtime.toISOString().slice(0, 16), () => '-');
      const who = `owner ${e.owner}${e.audience.length ? `, audience ${e.audience.join(', ')}` : ''}`;
      return `${named(e)} (${e.kind}) ${who}${e.refines ? ` · refines ${e.refines}` : ''} · rev ${await fileRev(e)} · updated ${updated}`;
    }))).join('\n');
  });

  tool('create_diagram', 'Create a new diagram file and index entry. The owner defaults to the role this session opened a diagram as.', {
    name: z.string(),
    kind: z.enum(DIAGRAM_KINDS),
    owner: z.string().optional(),
    audience: z.array(z.string()).optional(),
    refines: z.string().optional().describe('<diagramId>#<elementId> this diagram details')
  }, async ({ name, kind, owner, audience, refines }) => {
    const who = owner ?? binding?.as;
    if (!who) throw new ToolError('owner is required (no diagram is open in this session)');
    const url = await server();
    const e: DiagramEntry = await request(url, 'POST', '/api/diagrams', { name, kind, owner: who, audience, refines });
    const how = conventionLine(e.kind);
    return `created ${named(e)} (${e.kind}) owner ${e.owner} · ${url}/d/${encodeURIComponent(e.id)}${how ? `\n${how}` : ''}`;
  });

  tool('open_diagram', "Bind this session to one diagram as a role. The owner role gets the writer lease; other roles read unless they pass edit: true, which only the user's yes to editing another role's board allows. Returns the URL for the user and a summary of the board.", {
    id: z.string(),
    as: z.string().describe('your role, e.g. po, dev, tester'),
    edit: z.boolean().optional().describe("write on another role's board; only after the user confirmed"),
    takeover: z.boolean().optional().describe('take the writer lease from another session; only after the user confirmed')
  }, ({ id, as, edit, takeover }) => open(id, as, edit, takeover));

  tool('read_diagram', "Summarize a diagram, read-only (e.g. another role's board). Accepts an id, a dl:// ref or a board URL; with neither, the diagram open in this session. Works without the canvas server.", {
    id: z.string().optional(),
    ref: z.string().optional().describe('dl://<id>[@rev][#element] or http://…/d/<id>'),
    frameId: z.string().optional()
  }, async ({ id, ref, frameId }) => {
    const target = id ?? (ref ? parseRef(ref)?.id : binding?.diagramId);
    if (!target) throw new ToolError(ref ? `not a board reference: ${ref}` : 'give id or ref, or call open_diagram {id, as} first');
    const e = await entry(target);
    const s = await scene(e);
    return summarizeScene(s.elements, { rev: s.rev, name: e.name, kind: e.kind, frameId });
  });

  tool('trace', 'Follow one element across diagrams: where its link points, which diagrams refine it, what this diagram refines, and who links to it.', {
    id: z.string(),
    elementId: z.string()
  }, async ({ id, elementId }) => {
    const all = await index();
    const e = await entry(id);
    const { elements } = await scene(e);
    const el = elements.find((x) => x.id === elementId);
    if (!el) throw new ToolError(`no element [${elementId}] on ${id}`);
    const lines = [`${elementName(elements, elementId)} on ${named(e)}`];

    const elementOn = async (ref: { id: string; elementId?: string }) => {
      const target = all.find((d) => d.id === ref.id);
      if (!target) return `${ref.id} (unknown diagram)`;
      if (!ref.elementId) return named(target);
      return `${named(target)} → ${elementName((await scene(target)).elements, ref.elementId)}`;
    };

    const link = linkRef(el.link);
    if (link) lines.push(`links to: ${await elementOn(link)}`);
    for (const d of all.filter((d) => d.refines === `${id}#${elementId}`)) lines.push(`detailed by: ${named(d)} (${d.kind})`);
    if (e.refines) {
      const [pid, pel] = e.refines.split('#');
      lines.push(`this diagram refines: ${await elementOn({ id: pid, elementId: pel })}`);
    }
    for (const d of all.filter((d) => d.id !== id)) {
      const els = (await scene(d)).elements;
      for (const x of els) {
        const r = linkRef(x.link);
        if (r?.id === id && (!r.elementId || r.elementId === elementId)) lines.push(`linked from: ${named(d)} ${elementName(els, x.id)}`);
      }
    }
    return lines.join('\n');
  });

  tool('get_scene_summary', 'Summarize the open diagram (or one frame of it): shapes, arrows, notes, frames, groups, the revision and layout issues (labels overflowing or outside their shape, overlaps, elements outside their frame). Use when the user asks about the board, and after a large drawing before you report it done.', {
    frameId: z.string().optional()
  }, async ({ frameId }) => {
    const b = await bound();
    const e = await entry(b.diagramId);
    const s = await scene(e);
    const summary = summarizeScene(s.elements, { rev: s.rev, name: e.name, kind: e.kind, frameId });
    const inFrame = frameId ? s.elements.filter((x: SceneEl) => x.id === frameId || x.frameId === frameId).map((x: SceneEl) => x.id) : undefined;
    const issues = layoutIssues(s.elements, inFrame);
    return issues.length ? `${summary}\nlayout issues:\n${issues.map((l) => `- ${l}`).join('\n')}` : summary;
  });

  tool('get_changes_since', "What changed on the open diagram. Without `since` it reports everything since this role last read and marks it read. Call it when the user's question is about the board, not on your own.", {
    since: z.number().int().min(0).optional(),
    origin: origin.optional()
  }, async ({ since, origin }) => {
    const b = await bound();
    const r = await request(b.url, 'POST', `/api/diagrams/${encodeURIComponent(b.diagramId)}/changes`, { as: b.as, since, origin });
    return r.report;
  });

  tool('wait_for_changes', 'Wait until the user draws on the open diagram and then pauses, and return the changes. Only when the user asks you to watch the board.', {
    since: z.number().int().min(0).optional(),
    idleSeconds: z.number().min(1).max(30).optional(),
    timeoutSeconds: z.number().min(1).max(240).optional(),
    origin: origin.optional()
  }, async ({ since, idleSeconds, timeoutSeconds, origin }) => {
    const b = await bound();
    const id = encodeURIComponent(b.diagramId);
    const r = await request(b.url, 'POST', `/api/diagrams/${id}/wait`, { as: b.as, since, idleSeconds, timeoutSeconds, origin });
    if (r.status === 'changes') return r.report;
    if (r.status === 'no_browser') return `no browser has ${b.diagramId} open; ask the user to open ${b.url}/d/${id} (rev ${r.rev})`;
    return `no new changes before the timeout (rev ${r.rev})${r.editing ? '; the user is still editing' : ''}`;
  });

  const why: Record<string, string> = {
    editing: 'the user is typing in it',
    selected: 'the user has it selected',
    recent: 'the user changed it in the last 5s',
    missing: 'no such element',
    exists: 'id already taken',
    version: 'it changed since you read it'
  };
  // The open board, refusing a write meant for another one.
  async function writeTarget(diagramId?: string) {
    const b = await bound();
    const e = await entry(b.diagramId);
    if (diagramId && diagramId !== b.diagramId) {
      const other = (await index()).find((d) => d.id === diagramId);
      throw new ToolError(`this session has "${e.name}" (${e.id}) open, not ${other ? `"${other.name}" (${other.id})` : `unknown diagram ${diagramId}`}; ask the user before switching with open_diagram`);
    }
    return { b, e, id: encodeURIComponent(b.diagramId) };
  }

  tool('apply_changes', 'Change the open diagram (writer only). Pass diagramId to make sure it is the board you mean. Colour new elements by meaning (see the kind conventions); the default stroke is neutral. When the user asked for this exact change ("connect A and B", "draw X", "rename Y"), pass frameId: null so it lands on the board directly. Leave frameId out only for content you propose on your own (options, a suggested structure): it then goes into a "Claude proposal" frame placed in free space; arrows that reach the user\'s shapes stay outside it. Elements the user is editing, has selected or changed in the last 5s are not touched; they come back as conflicts: read again, then retry or ask.', {
    ops: z.array(z.discriminatedUnion('op', [
      z.object({
        op: z.literal('create'),
        type: z.string().describe('rectangle, ellipse, diamond, text, arrow, line, frame, …'),
        id: z.string().optional(),
        label: z.string().optional().describe('text inside a shape or on an arrow'),
        start: z.string().optional().describe('arrow: id of the element it starts at'),
        end: z.string().optional().describe('arrow: id of the element it ends at')
      }).passthrough().describe('any other Excalidraw field: x, y, width, height, text, strokeColor, backgroundColor, points, link, …'),
      z.object({
        op: z.literal('update'),
        id: z.string(),
        patch: z.record(z.string(), z.unknown()).describe('fields to change; `label` relabels'),
        expectedVersion: z.number().int().optional()
      }),
      z.object({ op: z.literal('delete'), id: z.string(), expectedVersion: z.number().int().optional() })
    ])).min(1),
    diagramId: z.string().optional().describe('the board you mean to change; refused if another board is open'),
    frameId: z.string().nullable().optional(),
    color: z.string().optional().describe('default stroke for this call; neutral #343a40 when left out')
  }, async ({ ops, diagramId, frameId, color }) => {
    const { b, e, id } = await writeTarget(diagramId);
    const r = await request(b.url, 'POST', `/api/diagrams/${id}/apply`, { session: opts.sessionId, ops, frameId, color });
    const counts = (['create', 'update', 'delete'] as const)
      .map((k) => [k, r.applied.filter((a: { kind: string }) => a.kind === k).length] as const)
      .filter(([, n]) => n).map(([k, n]) => `${k} ${n}`);
    const lines = [`on "${e.name}" (${e.id}) rev ${r.rev} · applied ${r.applied.length}${counts.length ? ` (${counts.join(', ')})` : ''}${r.frameId ? ` · frame [${r.frameId}]` : ''}`];
    const made = r.applied.filter((a: { kind: string }) => a.kind === 'create').map((a: { id: string }) => `[${a.id}]`);
    if (made.length) lines.push(`created ${made.join(' ')}`);
    for (const c of r.conflicts) {
      lines.push(`conflict op ${c.op} [${c.id}]: ${why[c.reason] ?? c.reason}${c.version !== undefined ? ` (now v${c.version})` : ''}`);
    }
    for (const w of r.warnings ?? []) lines.push(`layout: ${w}`);
    return lines.join('\n');
  });

  tool('accept_proposal', 'When the user accepts a proposal (all of it, or the elements they name): its elements leave the frame with their colours; a frame left empty is deleted. Elements the user is busy with come back as conflicts.', {
    frameId: z.string().describe('the proposal frame'),
    elementIds: z.array(z.string()).optional().describe('only these elements of the frame; default all'),
    diagramId: z.string().optional().describe('the board you mean to change; refused if another board is open')
  }, async ({ frameId, elementIds, diagramId }) => {
    const { b, e, id } = await writeTarget(diagramId);
    const r = await request(b.url, 'POST', `/api/diagrams/${id}/accept`, { session: opts.sessionId, frameId, elementIds });
    const lines = [`on "${e.name}" (${e.id}) rev ${r.rev} · accepted ${r.accepted.length}${r.accepted.length ? ` [${r.accepted.join('] [')}]` : ''} · frame ${r.frameDeleted ? 'deleted' : 'kept'}`];
    for (const c of r.conflicts) {
      lines.push(`conflict [${c.id}]: ${why[c.reason] ?? c.reason}${c.version !== undefined ? ` (now v${c.version})` : ''}`);
    }
    return lines.join('\n');
  });

  tool('make_ref', 'A reference to the open diagram (or one element on it) at its current revision: dl:// for other agents, http for people.', {
    elementId: z.string().optional()
  }, async ({ elementId }) => {
    const b = await bound();
    const s = await scene(await entry(b.diagramId));
    if (elementId && !s.elements.some((x) => x.id === elementId)) throw new ToolError(`no element [${elementId}] on ${b.diagramId}`);
    const ref = { id: b.diagramId, rev: s.rev, elementId };
    return `${formatRef(ref)}\n${formatRef(ref, b.url)}`;
  });

  tool('ask', "Leave a question for a role whose session is not running. It sees the question when it next opens a diagram. If that role's session is running, SendMessage it instead.", {
    ref: z.string().describe('dl:// ref or board URL the question is about'),
    toRole: z.string(),
    text: z.string()
  }, async ({ ref, toRole, text }) => {
    const b = await bound();
    const r = parseRef(ref);
    if (!r) throw new ToolError(`not a board reference: ${ref}`);
    await entry(r.id);
    const q = await askQuestion(dir, { from: b.as, to: toRole, ref, text });
    return `asked ${toRole}: ${q.id}`;
  });

  tool('answer', 'Answer a question another role left for your role (listed by open_diagram).', {
    questionId: z.string(),
    text: z.string(),
    ref: z.string().optional().describe('a ref to your own board that shows the answer')
  }, async ({ questionId, text, ref }) => {
    const b = await bound();
    await answerQuestion(dir, { questionId, by: b.as, text, ref });
    return `answered ${questionId}`;
  });

  tool('check_consistency', 'Compare diagrams that refine or link each other: broken refs, labels that drifted between boards, and parent shapes no child diagram details yet. Report only; the owner role decides what changes. Works without the canvas server.', {
    ids: z.array(z.string()).optional().describe('only findings that involve these diagrams')
  }, async ({ ids }) => {
    const all = await index();
    const boards = await Promise.all(all.map(async (e) => ({ entry: e, elements: (await scene(e)).elements })));
    const found = checkConsistency(boards, ids);
    return found.length ? found.join('\n') : `consistent: ${all.length} diagrams checked`;
  });

  return {
    server: mcp,
    // Give back the writer lease and the status line's session file. Does not
    // start a server just to say goodbye.
    async close() {
      await mcp.close();
      if (!binding) return;
      binding = null;
      await unlink(sessionFile).catch(() => {});
      const live = await findServer(opts.projectDir);
      if (live) await request(live.url, 'DELETE', `/api/sessions/${encodeURIComponent(opts.sessionId)}`).catch(() => {});
    }
  };
}
