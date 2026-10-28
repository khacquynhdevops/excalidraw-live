// Turning element edits into change records, and change records into a short
// report Claude can read.
//
// The canonical-projection idea is adapted from mcp_excalidraw-ldele
// src/core/changes.ts (MIT, Copyright (c) 2024 MCP Excalidraw Server).

import type { ChangeRecord, Origin, SceneEl } from './types.js';

export type Lookup = (id: string) => SceneEl | undefined;

export const alive = (el: SceneEl | undefined): el is SceneEl => !!el && !el.isDeleted;

const textOf = (el: SceneEl): string | undefined => {
  const t = el.originalText ?? el.text;
  return typeof t === 'string' ? t : undefined;
};

// What a person would call the element: its own text, a frame's name, or the
// text bound inside it.
export function labelOf(el: SceneEl, get: Lookup): string | undefined {
  if (el.type === 'text') return textOf(el);
  if (el.type === 'frame' || el.type === 'magicframe') return typeof el.name === 'string' ? el.name : undefined;
  const bound = (el.boundElements as { id: string; type: string }[] | null | undefined)?.find((b) => b.type === 'text');
  const t = bound && get(bound.id);
  return t && alive(t) ? textOf(t) : undefined;
}

export const isPath = (el: SceneEl) => el.type === 'arrow' || el.type === 'line' || el.type === 'freedraw';
export const bindingId = (b: unknown) => (b as { elementId?: string } | null | undefined)?.elementId;

// The fields a person can see, in one shape. Comparing raw elements would
// report Excalidraw's bookkeeping (seed, versionNonce, updated) as edits.
// An arrow bound at both ends is placed by the shapes it joins, so its
// geometry is left out: moving a box should not read as "the arrow moved".
function canonicalize(el: SceneEl, get: Lookup): Record<string, unknown> {
  const derivedGeometry = isPath(el) && !!bindingId(el.startBinding) && !!bindingId(el.endBinding);
  const sized = el.type !== 'text' && !isPath(el);
  return {
    x: derivedGeometry ? null : el.x,
    y: derivedGeometry ? null : el.y,
    width: sized ? el.width : null,
    height: sized ? el.height : null,
    angle: el.angle,
    points: isPath(el) && !derivedGeometry
      ? (el.points as [number, number][] | undefined)?.map(([x, y]) => [Math.round(x), Math.round(y)])
      : null,
    strokeColor: el.strokeColor,
    backgroundColor: el.backgroundColor,
    fillStyle: el.fillStyle,
    strokeWidth: el.strokeWidth,
    strokeStyle: el.strokeStyle,
    roughness: el.roughness,
    opacity: el.opacity,
    roundness: (el.roundness as { type?: unknown } | null | undefined)?.type ?? null,
    label: labelOf(el, get),
    fontSize: el.fontSize,
    fontFamily: el.fontFamily,
    textAlign: el.textAlign,
    groupIds: Array.isArray(el.groupIds) ? [...el.groupIds].sort() : null,
    frameId: el.frameId,
    startTarget: bindingId(el.startBinding),
    endTarget: bindingId(el.endBinding),
    startArrowhead: el.startArrowhead,
    endArrowhead: el.endArrowhead,
    locked: el.locked,
    link: el.link
  };
}

function same(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.5;
  return JSON.stringify(a) === JSON.stringify(b);
}

const COMPANIONS: Record<string, string> = { x: 'y', y: 'x', width: 'height', height: 'width' };

// Only the fields that differ, plus the other half of a position or size so
// the report can say where things ended up.
function diffFields(a: Record<string, unknown>, b: Record<string, unknown>) {
  const keys = Object.keys(a).filter((k) => !same(a[k], b[k]));
  for (const k of [...keys]) if (COMPANIONS[k] && !keys.includes(COMPANIONS[k])) keys.push(COMPANIONS[k]);
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const k of keys) {
    before[k] = a[k] ?? null;
    after[k] = b[k] ?? null;
  }
  return keys.length ? { before, after } : null;
}

// Records for one write. `prev` sees the scene before it, `next` after.
// A bound text is reported as its container, so editing a caption reads as
// "the box changed".
export function recordChanges(
  changedIds: string[],
  prev: Lookup,
  next: Lookup,
  meta: { rev: number; origin: Origin; at: string }
): ChangeRecord[] {
  const ids = new Set<string>();
  for (const id of changedIds) {
    const el = next(id) ?? prev(id);
    const container = el?.type === 'text' && typeof el.containerId === 'string' ? el.containerId : null;
    if (container) {
      if (next(container) ?? prev(container)) ids.add(container);
    } else if (el) ids.add(id);
  }

  const out: ChangeRecord[] = [];
  for (const id of ids) {
    const a = prev(id);
    const b = next(id);
    const base = { rev: meta.rev, id, origin: meta.origin, at: meta.at, type: (b ?? a)!.type };
    if (!alive(a) && alive(b)) out.push({ ...base, kind: 'add', label: labelOf(b, next) });
    else if (alive(a) && !alive(b)) out.push({ ...base, kind: 'delete', label: labelOf(a, prev) });
    else if (alive(a) && alive(b)) {
      const d = diffFields(canonicalize(a, prev), canonicalize(b, next));
      if (d) out.push({ ...base, kind: 'update', label: labelOf(b, next), ...d });
    }
  }
  return out;
}

export interface FoldedChange {
  kind: ChangeRecord['kind'];
  id: string;
  type: string;
  label?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  // In order of first appearance.
  origins: Origin[];
}

// One entry per element: dragging a box 200 times is one move from where it
// started to where it is now. Added-then-deleted elements and edits that were
// undone drop out.
export function foldChanges(records: ChangeRecord[]): FoldedChange[] {
  const byId = new Map<string, ChangeRecord[]>();
  for (const r of records) {
    const list = byId.get(r.id);
    if (list) list.push(r);
    else byId.set(r.id, [r]);
  }

  const out: FoldedChange[] = [];
  for (const [id, list] of byId) {
    const first = list[0];
    const last = list[list.length - 1];
    const existedBefore = first.kind !== 'add';
    const existsNow = last.kind !== 'delete';
    const origins = [...new Set(list.map((r) => r.origin))];
    const label = [...list].reverse().find((r) => r.label !== undefined)?.label;
    const base = { id, type: last.type, label, origins };

    if (!existedBefore && !existsNow) continue;
    if (!existedBefore) out.push({ ...base, kind: 'add' });
    else if (!existsNow) out.push({ ...base, kind: 'delete' });
    else {
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const r of list) {
        for (const k of Object.keys(r.before ?? {})) if (!(k in before)) before[k] = r.before![k];
        Object.assign(after, r.after);
      }
      for (const k of Object.keys(before)) {
        if (same(before[k], after[k]) && !(COMPANIONS[k] && !same(before[COMPANIONS[k]], after[COMPANIONS[k]]))) {
          delete before[k];
          delete after[k];
        }
      }
      if (Object.keys(before).length) out.push({ ...base, kind: 'update', before, after });
    }
  }
  return out;
}

export interface ChangesWindow {
  since: number;
  rev: number;
  // Records older than the log keeps were requested.
  truncated: boolean;
  // `since` is past the current revision (the log was lost or reset).
  reset: boolean;
  records: ChangeRecord[];
}

const ORIGINS: Origin[] = ['human', 'agent', 'file'];
const NEAR_PX = 250;
const r0 = (n: unknown) => Math.round(Number(n) || 0);

// A short report, one line per changed element, at most `maxLines` lines.
export function formatReport(w: ChangesWindow, elements: SceneEl[], maxLines = 50): string {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const get: Lookup = (id) => byId.get(id);

  const warnings: string[] = [];
  if (w.reset) warnings.push(`⚠ rev ${w.since} is ahead of the board (rev ${w.rev}); the change log was reset. Read the whole board instead.`);
  if (w.truncated) warnings.push('⚠ older changes were dropped from the log; this report is partial.');

  const folded = foldChanges(w.records);
  if (!folded.length) return [...warnings, `rev ${w.since}→${w.rev}: no changes.`].join('\n');

  const counts = ORIGINS
    .map((o) => [o, folded.filter((c) => c.origins[c.origins.length - 1] === o).length] as const)
    .filter(([, n]) => n)
    .map(([o, n]) => `${o} ${n}`);
  const header = `rev ${w.since}→${w.rev}: ${folded.length} element${folded.length === 1 ? '' : 's'} changed (${counts.join(', ')})`;

  const name = (id: string | undefined): string => {
    if (!id) return 'nothing';
    const el = get(id);
    const label = el && labelOf(el, get);
    return label ? `"${label}"` : `[${id}]`;
  };

  const describe = (c: FoldedChange): string => {
    const el = get(c.id);
    const label = el && alive(el) ? labelOf(el, get) ?? c.label : c.label;
    if (label !== undefined) return `${c.type} "${label}" [${c.id}]`;
    if (el && isPath(el) && (bindingId(el.startBinding) || bindingId(el.endBinding))) {
      return `${c.type} ${name(bindingId(el.startBinding))}→${name(bindingId(el.endBinding))} [${c.id}]`;
    }
    return `${c.type} [${c.id}]`;
  };

  const placed = (el: SceneEl): string => {
    const parts = [`@(${r0(el.x)},${r0(el.y)}) ${r0(el.width)}x${r0(el.height)}`];
    if (typeof el.frameId === 'string') parts.push(`in frame ${name(el.frameId)}`);
    return parts.join(' ');
  };

  // A loose text a person drops on the board is usually a note about the
  // shape next to it.
  const near = (el: SceneEl): string | null => {
    const cx = r0(el.x) + r0(el.width) / 2;
    const cy = r0(el.y) + r0(el.height) / 2;
    let best: SceneEl | null = null;
    let bestD = NEAR_PX;
    for (const o of elements) {
      if (o.id === el.id || !alive(o) || o.type === 'text' || isPath(o)) continue;
      const d = Math.hypot(r0(o.x) + r0(o.width) / 2 - cx, r0(o.y) + r0(o.height) / 2 - cy);
      if (d < bestD) [best, bestD] = [o, d];
    }
    return best && `near ${best.type} ${name(best.id)} [${best.id}]`;
  };

  const changeText = (c: FoldedChange): string => {
    const b = c.before!;
    const a = c.after!;
    const parts: string[] = [];
    if ('x' in b || 'y' in b) {
      const dx = r0(a.x) - r0(b.x);
      const dy = r0(a.y) - r0(b.y);
      const steps = [
        dx && `${dx > 0 ? 'right' : 'left'} ${Math.abs(dx)}px`,
        dy && `${dy > 0 ? 'down' : 'up'} ${Math.abs(dy)}px`
      ].filter(Boolean);
      if (steps.length) parts.push(`moved ${steps.join(', ')} to (${r0(a.x)},${r0(a.y)})`);
    }
    if ('width' in b || 'height' in b) parts.push(`resized ${r0(b.width)}x${r0(b.height)}→${r0(a.width)}x${r0(a.height)}`);
    for (const k of Object.keys(b)) {
      if (['x', 'y', 'width', 'height'].includes(k)) continue;
      if (k === 'label') parts.push(`label "${b.label ?? ''}"→"${a.label ?? ''}"`);
      else if (k === 'startTarget' || k === 'endTarget') {
        parts.push(`${k === 'startTarget' ? 'start' : 'end'} rebound ${name(b[k] as string)}→${name(a[k] as string)}`);
      } else parts.push(`${k} ${JSON.stringify(b[k])}→${JSON.stringify(a[k])}`);
    }
    return parts.join('; ');
  };

  const line = (c: FoldedChange): string => {
    const el = get(c.id);
    const by = ` · ${c.origins.join('+')}`;
    if (c.kind === 'delete') return `- ${describe(c)}${by}`;
    if (c.kind === 'update') return `~ ${describe(c)}: ${changeText(c)}${by}`;
    if (!el) return `+ ${describe(c)}${by}`;
    const note = el.type === 'text' && !el.containerId && c.origins.includes('human') ? near(el) : null;
    return `+ ${describe(c)} ${placed(el)}${note ? `, ${note}` : ''}${by}`;
  };

  const lines = folded.slice(0, maxLines).map(line);
  if (folded.length > maxLines) lines.push(`… and ${folded.length - maxLines} more changes`);
  return [...warnings, header, ...lines].join('\n');
}
