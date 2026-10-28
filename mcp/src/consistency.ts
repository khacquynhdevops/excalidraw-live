// Cross-board checks for check_consistency. Report only: the owner role
// decides which board changes.
//   broken      a `refines` or `link` that points at no diagram or element
//   drift       two boards name the same thing almost, but not quite, alike
//   undetailed  a shape on a board that has children, which no child refines
//               and nothing links
import { alive, labelOf, parseRef, type DiagramEntry, type SceneEl } from '@excalidraw-live/shared';

export interface Board {
  entry: DiagramEntry;
  elements: SceneEl[];
}

const SHAPES = new Set(['rectangle', 'ellipse', 'diamond', 'frame']);

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

// Same thing, spelled differently: "Payment Service" / "Payments Service",
// "Payment Service" / "Payment Svc", "Auth" / "Auth Service".
function drifted(a: string, b: string): boolean {
  const x = norm(a), y = norm(b);
  if (!x || !y || x === y) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= 4 && long.includes(short)) return true;
  return distance(x, y) <= Math.max(1, Math.floor(long.length * 0.3));
}

// A `link` field: `/d/<id>#el`, a full URL, or dl://.
export const linkRef = (link: unknown) => (typeof link === 'string' && link ? parseRef(link.startsWith('/') ? `http://x${link}` : link) : null);

export function checkConsistency(boards: Board[], ids?: string[]): string[] {
  const byId = new Map(boards.map((b) => [b.entry.id, b]));
  const out: { text: string; about: string[] }[] = [];
  const report = (text: string, ...about: string[]) => out.push({ text, about });

  const lookup = (b: Board) => {
    const els = new Map(b.elements.map((e) => [e.id, e]));
    return (id: string) => els.get(id);
  };
  const named = (b: Board, el: SceneEl) => {
    const label = labelOf(el, lookup(b));
    return label ? `"${label}" [${el.id}]` : `[${el.id}]`;
  };
  const find = (diagramId: string, elementId: string) => {
    const b = byId.get(diagramId);
    const el = b?.elements.find((e) => e.id === elementId);
    return b && alive(el) ? { b, el } : null;
  };

  const detailed = new Set<string>(); // "<diagram>#<element>" refined or linked
  const parents = new Set<string>();

  for (const child of boards) {
    const r = child.entry.refines;
    if (r) {
      const [pid, pel] = r.split('#');
      parents.add(pid);
      detailed.add(r);
      const p = pel && find(pid, pel);
      if (!p) report(`broken: ${child.entry.id} refines ${r}, which does not exist`, child.entry.id, pid);
      else {
        const want = labelOf(p.el, lookup(p.b));
        const labels = child.elements.filter(alive).map((e) => ({ e, label: labelOf(e, lookup(child)) })).filter((x) => x.label);
        const near = want && !labels.some((x) => norm(x.label!) === norm(want)) && labels.find((x) => drifted(x.label!, want));
        if (near) report(`drift: ${child.entry.id} refines ${pid} ${named(p.b, p.el)} but names it ${named(child, near.e)}`, child.entry.id, pid);
      }
    }

    for (const el of child.elements.filter(alive)) {
      const ref = linkRef(el.link);
      if (!ref || ref.id === child.entry.id && !ref.elementId) continue;
      if (!ref.elementId) {
        if (!byId.has(ref.id)) report(`broken: ${child.entry.id} ${named(child, el)} links to ${ref.id}, which does not exist`, child.entry.id, ref.id);
        continue;
      }
      detailed.add(`${child.entry.id}#${el.id}`);
      const t = find(ref.id, ref.elementId);
      if (!t) {
        report(`broken: ${child.entry.id} ${named(child, el)} links to ${ref.id}#${ref.elementId}, which does not exist`, child.entry.id, ref.id);
        continue;
      }
      const a = labelOf(el, lookup(child)), b = labelOf(t.el, lookup(t.b));
      if (a && b && drifted(a, b)) report(`drift: ${child.entry.id} ${named(child, el)} links to ${ref.id} ${named(t.b, t.el)}`, child.entry.id, ref.id);
    }
  }

  for (const pid of parents) {
    const p = byId.get(pid);
    if (!p) continue;
    for (const el of p.elements.filter(alive)) {
      if (!SHAPES.has(el.type) || !labelOf(el, lookup(p)) || detailed.has(`${pid}#${el.id}`)) continue;
      report(`undetailed: ${pid} ${named(p, el)} (no diagram refines or links it)`, pid);
    }
  }

  return out.filter((f) => !ids?.length || f.about.some((a) => ids.includes(a))).map((f) => f.text);
}
