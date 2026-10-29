// Claude's writes to a board. The agent describes what it wants (create,
// update, delete); the server fills in what Excalidraw needs, bumps versions
// so every browser takes the change, and refuses to touch anything the person
// is working on right now.
//
// An op is refused (a conflict, nothing of it applied) when an element it
// touches is being typed in or is selected in a browser, was changed by a
// person in the last 5s, no longer exists, or is not at `expectedVersion`.
// New elements go into the "Claude proposal" frame in neutral ink, marked
// `customData.origin = 'agent'`. The frame sits in free space: a proposal that
// would cover the person's elements is moved, as one block, to their right.
// An arrow that reaches an element outside the proposal stays out of the frame.
//
// A shape grows to fit its label, and its label is centred on it after every
// change; arrows bound to a shape that moved or grew are redrawn. The result
// lists layout problems (overflow, overlap, outside a frame) around what was
// written, since the agent never sees the board rendered.
import { randomBytes, randomInt } from 'node:crypto';
import { generateKeyBetween } from 'fractional-indexing';
import { alive, bindingId, box, fitLabel, layoutIssues, measureText, type Presence, type SceneEl } from '@excalidraw-live/shared';
import type { SceneStore } from './store.js';
import { WorkspaceError } from './workspace.js';

// Neutral ink. Colour carries meaning (the kind's conventions); where a shape
// came from is in customData.origin and the proposal frame.
export const AGENT_COLOR = '#343a40';
// Nunito, Excalidraw's "Normal" font: easier to read than the hand-drawn
// Excalifont (5) that Excalidraw uses by default.
export const AGENT_FONT = 6;
export const PROPOSAL_FRAME = 'Claude proposal';
export const RECENT_MS = 5000;
const FRAME_PAD = 40;

export type AgentOp =
  // Any other Excalidraw field (strokeColor, link, points, …) may be given.
  // `label` puts a bound text on a shape or arrow; `start` / `end` bind an
  // arrow to two elements.
  | { op: 'create'; type: string; id?: string; label?: string; start?: string; end?: string; [field: string]: unknown }
  // `patch.label` relabels.
  | { op: 'update'; id: string; patch: Record<string, unknown>; expectedVersion?: number }
  | { op: 'delete'; id: string; expectedVersion?: number };

export type ConflictReason = 'editing' | 'selected' | 'recent' | 'version' | 'missing' | 'exists';

export interface Conflict {
  // Position of the op in the request.
  op: number;
  id: string;
  reason: ConflictReason;
  // The element's current version, for `version`.
  version?: number;
}

export interface WriteOptions {
  presence: Presence[];
  // Frame for new elements; null for none. Default: the proposal frame.
  frameId?: string | null;
  color?: string;
  now?: number;
}

export interface WriteResult {
  rev: number;
  applied: { op: number; kind: AgentOp['op']; id: string }[];
  conflicts: Conflict[];
  // Where new elements went.
  frameId?: string;
  // Every element written, as stored.
  elements: SceneEl[];
  // Layout problems involving what was written.
  warnings: string[];
}

const PROTECTED = ['id', 'type', 'version', 'versionNonce', 'updated', 'isDeleted', 'index'];
const CONTAINERS = new Set(['rectangle', 'ellipse', 'diamond', 'arrow']);
const LINEAR = new Set(['arrow', 'line']);
// Given on a shape or arrow, these style its label (and go with it into or
// out of a frame).
const LABEL_STYLE = ['fontFamily', 'fontSize', 'strokeColor', 'frameId'];
const SHARED_STYLE = new Set(['strokeColor', 'frameId']);

const newId = () => randomBytes(15).toString('base64url');
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
type Ref = { id: string; type: string };
const refs = (el: SceneEl) => (el.boundElements as Ref[] | null | undefined) ?? [];
const boundTextId = (el: SceneEl) => refs(el).find((r) => r.type === 'text')?.id;

const textOf = (t: SceneEl) => String(t.originalText ?? t.text ?? '');

// `container` grown, keeping its top-left, to fit a label of `text`.
function fit(container: SceneEl, text: string, fontSize: number): SceneEl {
  if (LINEAR.has(container.type)) return container;
  const size = fitLabel(container.type, num(container.width, 0), num(container.height, 0), measureText(text, fontSize));
  return { ...container, ...size };
}

// `t` centred on `container`.
function centre(t: SceneEl, container: SceneEl): SceneEl {
  const b = box(container);
  return { ...t, x: (b.x1 + b.x2) / 2 - num(t.width, 0) / 2, y: (b.y1 + b.y2) / 2 - num(t.height, 0) / 2 };
}

const sameBox = (p: Box, q: Box) => p.x1 === q.x1 && p.y1 === q.y1 && p.x2 === q.x2 && p.y2 === q.y2;
const overlaps = (p: Box, q: Box) => p.x1 < q.x2 && q.x1 < p.x2 && p.y1 < q.y2 && q.y1 < p.y2;
const union = (bs: Box[]): Box => ({
  x1: Math.min(...bs.map((b) => b.x1)), y1: Math.min(...bs.map((b) => b.y1)),
  x2: Math.max(...bs.map((b) => b.x2)), y2: Math.max(...bs.map((b) => b.y2))
});
type Box = ReturnType<typeof box>;

// Where the line from a box's centre towards (tx, ty) leaves the box.
function edgePoint(el: SceneEl, tx: number, ty: number, gap = 6) {
  const b = box(el);
  const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2;
  const dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return [cx, cy];
  const t = Math.min(dx ? (b.x2 - b.x1) / 2 / Math.abs(dx) : Infinity, dy ? (b.y2 - b.y1) / 2 / Math.abs(dy) : Infinity);
  const len = Math.hypot(dx, dy);
  return [cx + dx * t + (dx / len) * gap, cy + dy * t + (dy / len) * gap];
}

export function agentWrite(store: SceneStore, ops: unknown, opts: WriteOptions): WriteResult {
  if (!Array.isArray(ops) || !ops.length) throw new WorkspaceError('ops must be a non-empty list');
  const list = ops as AgentOp[];
  const now = opts.now ?? Date.now();
  const color = opts.color ?? AGENT_COLOR;
  // Everything this call changes, by id, in order of first change.
  const next = new Map<string, SceneEl>();
  const created: string[] = [];
  const applied: WriteResult['applied'] = [];
  const conflicts: Conflict[] = [];

  const get = (id: string) => next.get(id) ?? store.get(id);
  const live = (id: string | undefined) => {
    const el = id === undefined ? undefined : get(id);
    return el && alive(el) ? el : undefined;
  };

  function blocked(id: string): ConflictReason | undefined {
    if (!store.get(id)) return undefined; // made in this call
    if (opts.presence.some((p) => p.editingId === id)) return 'editing';
    if (opts.presence.some((p) => p.selectedIds.includes(id))) return 'selected';
    const t = store.lastHumanEdit(id);
    if (t !== undefined && now - t < RECENT_MS) return 'recent';
    return undefined;
  }

  function element(type: string, id: string, props: Record<string, unknown>): SceneEl {
    const el: SceneEl = {
      id, type, x: 0, y: 0, width: 160, height: 80, angle: 0,
      strokeColor: color, backgroundColor: 'transparent', fillStyle: 'solid',
      strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100,
      groupIds: [], frameId: null, roundness: type === 'rectangle' || type === 'diamond' ? { type: 3 } : null,
      seed: randomInt(2 ** 31), version: 1, versionNonce: 0, isDeleted: false,
      boundElements: null, updated: now, link: null, locked: false
    };
    if (type === 'text') {
      const text = String(props.text ?? '');
      Object.assign(el, {
        text, originalText: text, fontSize: 20, fontFamily: AGENT_FONT, textAlign: 'left', verticalAlign: 'top',
        containerId: null, autoResize: true, lineHeight: 1.25, ...measureText(text, num(props.fontSize, 20))
      });
    }
    if (LINEAR.has(type)) {
      Object.assign(el, {
        points: [[0, 0], [num(props.width, 160), num(props.height, 0)]], lastCommittedPoint: null,
        startBinding: null, endBinding: null, startArrowhead: null,
        endArrowhead: type === 'arrow' ? 'arrow' : null, elbowed: false
      });
    }
    if (type === 'frame') Object.assign(el, { name: null, strokeColor: '#bbb' });
    Object.assign(el, props);
    el.customData = { ...(props.customData as object), origin: 'agent' };
    if (LINEAR.has(type)) {
      const b = box(el);
      Object.assign(el, { width: b.x2 - b.x1, height: b.y2 - b.y1 });
    }
    return el;
  }

  // A text bound to `container`, centred on it.
  function label(container: SceneEl, text: string, style: Record<string, unknown> = {}): SceneEl {
    const t = centre(element('text', `${container.id}-label`, {
      text, textAlign: 'center', verticalAlign: 'middle', containerId: container.id,
      frameId: container.frameId ?? null, strokeColor: container.strokeColor, ...style
    }), container);
    if (live(t.id)) t.id = newId();
    return t;
  }

  // Split a shape's fields into its own and its label's: the font goes only
  // to the label, the colour to both.
  function splitStyle(type: string, fields: Record<string, unknown>) {
    const style: Record<string, unknown> = {};
    if (type === 'text') return { own: fields, style };
    const own = { ...fields };
    for (const k of LABEL_STYLE) {
      if (own[k] === undefined) continue;
      style[k] = own[k];
      if (!SHARED_STYLE.has(k)) delete own[k];
    }
    return { own, style };
  }

  const bindTo = (target: SceneEl, ref: Ref) => ({ ...target, boundElements: [...refs(target).filter((r) => r.id !== ref.id), ref] });

  // An arrow drawn from edge to edge between the elements it is bound to.
  function route(el: SceneEl, a: SceneEl, b: SceneEl): SceneEl {
    const ab = box(b), aa = box(a);
    const [sx, sy] = edgePoint(a, (ab.x1 + ab.x2) / 2, (ab.y1 + ab.y2) / 2);
    const [ex, ey] = edgePoint(b, (aa.x1 + aa.x2) / 2, (aa.y1 + aa.y2) / 2);
    return { ...el, x: sx, y: sy, width: Math.abs(ex - sx), height: Math.abs(ey - sy), points: [[0, 0], [ex - sx, ey - sy]] };
  }

  // Redraw an arrow between the elements it is bound to, its label with it.
  function reroute(e: SceneEl) {
    const a = live(bindingId(e.startBinding)), b = live(bindingId(e.endBinding));
    if (!LINEAR.has(e.type) || !a || !b) return;
    const r = route(e, a, b);
    next.set(r.id, r);
    const t = live(boundTextId(r));
    if (t) next.set(t.id, centre(t, r));
  }

  list.forEach((op, i) => {
    const conflict = (id: string, reason: ConflictReason, version?: number) =>
      conflicts.push({ op: i, id, reason, ...(version !== undefined && { version }) });

    if (op.op === 'create') {
      const { op: _, type, id = newId(), label: text, start, end, ...fields } = op;
      if (typeof type !== 'string' || !type) throw new WorkspaceError(`op ${i}: type is required`);
      const { own: props, style } = splitStyle(type, fields);
      if (live(id)) return conflict(id, 'exists');
      const ends = [start, end].filter((e): e is string => typeof e === 'string');
      for (const e of ends) {
        if (!live(e)) return conflict(e, 'missing');
        const why = blocked(e);
        if (why) return conflict(e, why);
      }
      let el = element(type, id, props);
      const out: SceneEl[] = [];
      if (LINEAR.has(type) && start && end) {
        const a = live(start)!, b = live(end)!;
        el = {
          ...route(el, a, b),
          startBinding: { elementId: start, focus: 0, gap: 6 }, endBinding: { elementId: end, focus: 0, gap: 6 }
        };
        out.push(bindTo(a, { id, type: 'arrow' }));
        out.push(bindTo(start === end ? out[0] : b, { id, type: 'arrow' }));
      }
      if (typeof text === 'string' && text && CONTAINERS.has(type)) {
        el = fit(el, text, num(style.fontSize, 20));
        const t = label(el, text, style);
        el = bindTo(el, { id: t.id, type: 'text' });
        out.push(t);
        created.push(t.id);
      }
      next.set(el.id, el);
      created.push(el.id);
      for (const o of out) next.set(o.id, o);
      applied.push({ op: i, kind: 'create', id });
      return;
    }

    const el = live(op.id);
    if (!el) return conflict(op.id, 'missing');
    const stored = store.get(op.id);
    if (op.expectedVersion !== undefined && stored && stored.version !== op.expectedVersion) {
      return conflict(op.id, 'version', stored.version);
    }
    const textId = boundTextId(el);
    for (const id of [op.id, ...(textId ? [textId] : [])]) {
      const why = blocked(id);
      if (why) return conflict(id, why);
    }

    if (op.op === 'delete') {
      next.set(el.id, { ...el, isDeleted: true });
      const t = live(textId);
      if (t) next.set(t.id, { ...t, isDeleted: true });
      applied.push({ op: i, kind: 'delete', id: el.id });
      return;
    }

    if (op.op !== 'update') throw new WorkspaceError(`op ${i}: unknown op ${(op as { op: unknown }).op}`);
    const { label: text, ...fields } = op.patch ?? {};
    for (const k of PROTECTED) delete fields[k];
    const { own: patch, style } = splitStyle(el.type, fields);
    let updated: SceneEl = { ...el, ...patch };
    const t = live(textId);
    if (el.type === 'text' && !el.containerId && (typeof patch.text === 'string' || patch.fontSize !== undefined)) {
      // A free text: what it says is originalText; its box follows.
      const s = typeof patch.text === 'string' ? patch.text : textOf(el);
      updated = { ...updated, text: s, originalText: s, ...measureText(s, num(updated.fontSize, 20)) };
    } else if (t) {
      // The label follows its shape, which grows to fit it.
      const s = typeof text === 'string' ? text : textOf(t);
      const fontSize = num(style.fontSize ?? t.fontSize, 20);
      updated = fit(updated, s, fontSize);
      next.set(t.id, centre({ ...t, ...style, text: s, originalText: s, ...measureText(s, fontSize) }, updated));
    } else if (typeof text === 'string' && text && CONTAINERS.has(el.type)) {
      updated = fit(updated, text, num(style.fontSize, 20));
      const nt = label(updated, text, style);
      updated = bindTo(updated, { id: nt.id, type: 'text' });
      next.set(nt.id, nt);
      created.push(nt.id);
    }
    next.set(el.id, updated);
    // Arrows bound to a shape that moved or grew follow it.
    if (!LINEAR.has(el.type) && !sameBox(box(el), box(updated))) {
      for (const r of refs(updated)) {
        const a = live(r.id);
        if (r.type === 'arrow' && a && !blocked(a.id)) reroute(a);
      }
    }
    applied.push({ op: i, kind: 'update', id: el.id });
  });

  // New elements go into a frame.
  let frameId: string | undefined;
  const loose = created.map((id) => next.get(id)!).filter((e) => e.type !== 'frame' && !e.containerId && e.frameId == null);
  let framed = loose;
  if (loose.length && opts.frameId !== null) {
    let frame: SceneEl | undefined;
    if (opts.frameId) {
      frame = live(opts.frameId);
      if (!frame || frame.type !== 'frame') throw new WorkspaceError(`no frame [${opts.frameId}] on this board`);
    } else {
      // The newest proposal frame.
      frame = store.all().filter((e) => alive(e) && e.type === 'frame' && e.name === PROPOSAL_FRAME)
        .sort((p, q) => String(p.index ?? '').localeCompare(String(q.index ?? ''))).at(-1);
      // An arrow reaching outside the proposal belongs to the board, not the frame.
      const inside = new Set(loose.map((e) => e.id));
      const proposed = (id: unknown) => typeof id === 'string' && (inside.has(id) || (!!frame && get(id)?.frameId === frame.id));
      const ends = (e: SceneEl) => [e.startBinding, e.endBinding].map((b) => (b as { elementId?: string } | null)?.elementId).filter(Boolean);
      framed = loose.filter((e) => !LINEAR.has(e.type) || ends(e).every(proposed));
      if (framed.length) frame = place(framed, frame);
    }
    if (framed.length) {
      frameId = frame!.id;
      const inFrame = new Set(framed.map((e) => e.id));
      for (const [id, e] of next) {
        if (inFrame.has(id) || (e.containerId && inFrame.has(e.containerId as string))) next.set(id, { ...e, frameId });
      }
    }
  }

  // Fit the proposal frame around `els`, in free space. Returns the frame.
  function place(els: SceneEl[], frame: SceneEl | undefined): SceneEl {
    const isNew = new Set(created);
    const others = [...new Set([...store.all().map((e) => e.id), ...next.keys()])].map(get)
      .filter((e): e is SceneEl => !!e && alive(e) && !isNew.has(e.id));
    // Inside the frame being grown is not in the way.
    const ours = (o: SceneEl, f?: SceneEl) => !!f && (o.id === f.id || o.frameId === f.id);
    const clear = (b: Box, f?: SceneEl) => !others.some((o) => !ours(o, f) && overlaps(b, box(o)));
    const content = union(els.map(box));
    if (frame) {
      // A proposal frame the person is busy with is not resized.
      if (blocked(frame.id)) return frame;
      const grown = union([content, box(frame)]);
      if (clear(grown, frame)) {
        const fit = { x: grown.x1, y: grown.y1, width: grown.x2 - grown.x1, height: grown.y2 - grown.y1 };
        if (Object.entries(fit).some(([k, v]) => frame![k] !== v)) next.set(frame.id, { ...frame, ...fit });
        return frame;
      }
    }
    // A new frame, moved with its content to the right of everything when it
    // would cover something.
    let fb = { x1: content.x1 - FRAME_PAD, y1: content.y1 - FRAME_PAD, x2: content.x2 + FRAME_PAD, y2: content.y2 + FRAME_PAD };
    if (!clear(fb)) {
      const dx = Math.max(...others.map((o) => box(o).x2)) + FRAME_PAD - fb.x1;
      fb = { ...fb, x1: fb.x1 + dx, x2: fb.x2 + dx };
      const moved = new Set(els.map((e) => e.id));
      for (const [id, e] of next) {
        if (moved.has(id) || (e.containerId && moved.has(e.containerId as string))) next.set(id, { ...e, x: num(e.x, 0) + dx });
      }
      // Arrows made in this call follow the shapes they are bound to.
      for (const id of created) reroute(next.get(id)!);
    }
    const f = element('frame', newId(), { name: PROPOSAL_FRAME, x: fb.x1, y: fb.y1, width: fb.x2 - fb.x1, height: fb.y2 - fb.y1 });
    created.unshift(f.id);
    next.set(f.id, f);
    return f;
  }

  if (!next.size) return { rev: store.revision, applied, conflicts, elements: [], warnings: [] };

  // New elements go on top, in the order they were made; existing ones keep
  // their place. Every element written gets a version the browsers will take.
  let top = store.all().reduce<string | null>((m, e) => (typeof e.index === 'string' && (!m || e.index > m) ? e.index : m), null);
  const isNew = new Set(created);
  const elements = [...created.filter((id) => next.has(id)), ...[...next.keys()].filter((id) => !isNew.has(id))].map((id) => {
    const e = next.get(id)!;
    const out: SceneEl = { ...e, version: (store.get(id)?.version ?? 0) + 1, versionNonce: randomInt(2 ** 31), updated: now };
    if (isNew.has(id)) out.index = top = generateKeyBetween(top, null);
    return out;
  });
  const rev = store.upsert(elements, 'agent');
  const warnings = layoutIssues(store.all(), elements.map((e) => e.id));
  return { rev, applied, conflicts, ...(frameId && { frameId }), elements, warnings };
}

export interface AcceptOptions {
  frameId: string;
  // Default: everything in the frame.
  elementIds?: string[];
  presence: Presence[];
  now?: number;
}

export interface AcceptResult {
  rev: number;
  accepted: string[];
  conflicts: Conflict[];
  frameDeleted: boolean;
  elements: SceneEl[];
}

// The person accepts (part of) a proposal: its elements leave the frame,
// keeping their colours, and a frame left empty is deleted.
export function acceptProposal(store: SceneStore, opts: AcceptOptions): AcceptResult {
  const frame = store.get(opts.frameId);
  if (!frame || !alive(frame) || frame.type !== 'frame') throw new WorkspaceError(`[${opts.frameId}] is not a frame on this board`);
  const inFrame = () => store.all().filter((e) => alive(e) && e.frameId === frame.id && !e.containerId).map((e) => e.id);
  const ids = opts.elementIds ?? inFrame();
  const stray = ids.find((id) => !inFrame().includes(id));
  if (stray) throw new WorkspaceError(`[${stray}] is not in frame [${frame.id}]`);
  const patch = { frameId: null };
  const write = (ops: AgentOp[]) => agentWrite(store, ops, { presence: opts.presence, now: opts.now, frameId: null });
  const r = ids.length ? write(ids.map((id) => ({ op: 'update', id, patch }))) : { rev: store.revision, applied: [], conflicts: [], elements: [] };
  const result: AcceptResult = { rev: r.rev, accepted: r.applied.map((a) => a.id), conflicts: r.conflicts, frameDeleted: false, elements: r.elements };
  if (!inFrame().length) {
    const d = write([{ op: 'delete', id: frame.id }]);
    result.frameDeleted = d.applied.length > 0;
    result.rev = d.rev;
    result.elements.push(...d.elements);
  }
  return result;
}
