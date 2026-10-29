// Layout problems the agent cannot see because it never sees the board
// rendered: a label that overflows, sits off the centre of or outside its
// shape, an arrow label longer than its arrow, lying on a shape, another arrow
// label or a frame's edge, an arrow crossing a shape it does not connect,
// shapes that partly overlap, an element sticking out of its frame.
import type { SceneEl } from './types.js';
import { alive } from './changes.js';

export interface Box { x1: number; y1: number; x2: number; y2: number }

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const LINEAR = new Set(['arrow', 'line']);
const SHAPES = new Set(['rectangle', 'ellipse', 'diamond', 'image', 'text']);
// Excalidraw's padding between a shape's edge and its label.
const TEXT_PADDING = 5;

export function box(el: SceneEl): Box {
  const x = num(el.x), y = num(el.y);
  if (LINEAR.has(el.type)) {
    const pts = (el.points as [number, number][] | undefined) ?? [[0, 0]];
    const xs = pts.map((p) => x + p[0]), ys = pts.map((p) => y + p[1]);
    return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
  }
  return { x1: x, y1: y, x2: x + num(el.width), y2: y + num(el.height) };
}

// Rough size of a text in Nunito: wide enough to catch overflow, no font needed.
export function measureText(text: string, fontSize: number) {
  const lines = text.split('\n');
  return { width: Math.max(...lines.map((l) => l.length)) * fontSize * 0.6, height: lines.length * fontSize * 1.25 };
}

// The room a shape of this size has for its label: an ellipse fits a
// rectangle 1/√2 of its size, a diamond half of it.
const ROOM: Record<string, number> = { ellipse: Math.SQRT1_2, diamond: 0.5 };
export function labelRoom(type: string, width: number, height: number) {
  const k = ROOM[type] ?? 1;
  return { width: width * k - 2 * TEXT_PADDING, height: height * k - 2 * TEXT_PADDING };
}

// The smallest size of shape `type` at least `width` × `height` that fits a
// label of `text` with some air around it.
export function fitLabel(type: string, width: number, height: number, text: { width: number; height: number }) {
  const k = ROOM[type] ?? 1;
  return { width: Math.max(width, Math.ceil((text.width + 40) / k)), height: Math.max(height, Math.ceil((text.height + 30) / k)) };
}

// Whether the segment (x1,y1)→(x2,y2) passes through `b` (Liang–Barsky).
function crosses(x1: number, y1: number, x2: number, y2: number, b: Box) {
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  for (const [p, q] of [[-dx, x1 - b.x1], [dx, b.x2 - x1], [-dy, y1 - b.y1], [dy, b.y2 - y1]]) {
    if (!p) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

const overlaps = (p: Box, q: Box) => p.x1 < q.x2 && q.x1 < p.x2 && p.y1 < q.y2 && q.y1 < p.y2;
const inside = (p: Box, q: Box, slack = 1) => p.x1 >= q.x1 - slack && p.y1 >= q.y1 - slack && p.x2 <= q.x2 + slack && p.y2 <= q.y2 + slack;

// One line per problem. With `ids`, only problems involving one of them.
export function layoutIssues(elements: SceneEl[], ids?: Iterable<string>): string[] {
  const live = elements.filter(alive);
  const byId = new Map(live.map((e) => [e.id, e]));
  const only = ids ? new Set(ids) : undefined;
  const textOf = (t: SceneEl) => String(t.originalText ?? t.text ?? '').split('\n')[0].slice(0, 30);
  const named = (e: SceneEl) => {
    const t = e.type === 'text' ? e : byId.get(((e.boundElements as { id: string; type: string }[] | null) ?? []).find((r) => r.type === 'text')?.id ?? '');
    return t ? `${e.type} "${textOf(t)}" [${e.id}]` : `${e.type} [${e.id}]`;
  };
  const out: string[] = [];
  const add = (about: string[], text: string) => {
    if (!only || about.some((id) => only.has(id))) out.push(text);
  };

  const shapes = live.filter((e) => SHAPES.has(e.type) && !e.containerId);
  const frames = live.filter((e) => e.type === 'frame');
  const arrowLabels: { arrow: SceneEl; box: Box }[] = [];
  for (const t of live) {
    const c = typeof t.containerId === 'string' ? byId.get(t.containerId) : undefined;
    if (t.type !== 'text' || !c) continue;
    const tb = box(t), cb = box(c);
    if (LINEAR.has(c.type)) {
      const length = Math.hypot(cb.x2 - cb.x1, cb.y2 - cb.y1);
      if (tb.x2 - tb.x1 + 20 > length) add([c.id, t.id], `label of ${named(c)} is longer than the arrow: shorten it or move the shapes apart`);
      const hit = shapes.find((s) => overlaps(tb, box(s)));
      if (hit) add([c.id, t.id, hit.id], `label of ${named(c)} lies on ${named(hit)}`);
      const edge = frames.find((f) => overlaps(tb, box(f)) && !inside(tb, box(f), 0));
      if (edge) add([c.id, t.id, edge.id], `label of ${named(c)} lies on the edge of frame "${String(edge.name ?? edge.id)}"`);
      for (const o of arrowLabels) {
        if (overlaps(tb, o.box)) add([c.id, o.arrow.id], `labels of ${named(o.arrow)} and ${named(c)} overlap`);
      }
      arrowLabels.push({ arrow: c, box: tb });
      continue;
    }
    if (!overlaps(tb, cb)) {
      add([c.id, t.id], `label of ${named(c)} is outside its shape`);
      continue;
    }
    const room = labelRoom(c.type, cb.x2 - cb.x1, cb.y2 - cb.y1);
    if (tb.x2 - tb.x1 > room.width + 1 || tb.y2 - tb.y1 > room.height + 1) {
      const fit = fitLabel(c.type, cb.x2 - cb.x1, cb.y2 - cb.y1, { width: tb.x2 - tb.x1, height: tb.y2 - tb.y1 });
      add([c.id, t.id], `label of ${named(c)} overflows it: make it ${fit.width}x${fit.height} or shorten the label`);
    } else if (Math.abs((tb.x1 + tb.x2 - cb.x1 - cb.x2) / 2) > 10 || Math.abs((tb.y1 + tb.y2 - cb.y1 - cb.y2) / 2) > 10) {
      add([c.id, t.id], `label of ${named(c)} is off its centre: update the shape to re-centre it`);
    }
  }

  // An arrow passing through a shape it does not start or end at.
  for (const a of live.filter((e) => LINEAR.has(e.type))) {
    const ends = new Set([a.startBinding, a.endBinding].map((b) => (b as { elementId?: string } | null)?.elementId));
    const pts = ((a.points as [number, number][] | undefined) ?? []).map(([px, py]) => [num(a.x) + px, num(a.y) + py]);
    for (const s of shapes) {
      if (ends.has(s.id) || s.type === 'text') continue;
      const sb = box(s);
      // A shape holding an end of the arrow is a boundary around it, not in its way.
      if (pts.some(([px, py]) => px > sb.x1 && px < sb.x2 && py > sb.y1 && py < sb.y2)) continue;
      // Shrunk so an arrow ending on the shape's edge does not count.
      const core = { x1: sb.x1 + 2, y1: sb.y1 + 2, x2: sb.x2 - 2, y2: sb.y2 - 2 };
      if (pts.some((p, i) => i > 0 && crosses(pts[i - 1][0], pts[i - 1][1], p[0], p[1], core))) {
        add([a.id, s.id], `${named(a)} crosses ${named(s)}: move one of them so the arrow goes around`);
      }
    }
  }

  // Partly overlapping shapes; one fully inside another is on purpose.
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      const p = box(shapes[i]), q = box(shapes[j]);
      if (overlaps(p, q) && !inside(p, q) && !inside(q, p)) add([shapes[i].id, shapes[j].id], `${named(shapes[i])} overlaps ${named(shapes[j])}`);
    }
  }

  for (const e of live) {
    const f = typeof e.frameId === 'string' ? byId.get(e.frameId) : undefined;
    if (!f || e.containerId) continue;
    if (!inside(box(e), box(f))) add([e.id, f.id], `${named(e)} sticks out of frame "${String(f.name ?? f.id)}"`);
  }
  return out;
}
