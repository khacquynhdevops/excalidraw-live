// The whole board as short text: what is on it, not what changed (that is
// formatReport in changes.ts).

import type { SceneEl } from './types.js';
import { alive, bindingId, labelOf, type Lookup } from './changes.js';

export interface SummaryOptions {
  rev: number;
  name?: string;
  kind?: string;
  // Only the elements inside this frame.
  frameId?: string;
  maxLines?: number;
}

const r0 = (n: unknown) => Math.round(Number(n) || 0);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const isFrame = (el: SceneEl) => el.type === 'frame' || el.type === 'magicframe';

export function summarizeScene(elements: SceneEl[], opts: SummaryOptions): string {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const get: Lookup = (id) => byId.get(id);
  const name = (id: string | undefined): string => {
    if (!id) return 'nothing';
    const el = get(id);
    const label = el && labelOf(el, get);
    return label ? `"${label}"` : `[${id}]`;
  };

  // Bound text is shown as its container's label.
  let shown = elements.filter((e) => alive(e) && !(e.type === 'text' && e.containerId));
  let title = `board${opts.name ? ` "${opts.name}"` : ''}${opts.kind ? ` (${opts.kind})` : ''}`;
  if (opts.frameId) {
    const frame = get(opts.frameId);
    if (!frame || !alive(frame) || !isFrame(frame)) return `no frame [${opts.frameId}] on this board (rev ${opts.rev})`;
    shown = shown.filter((e) => e.frameId === opts.frameId);
    title = `frame ${name(frame.id)} [${frame.id}]`;
  }

  const frames = shown.filter(isFrame);
  const arrows = shown.filter((e) => e.type === 'arrow');
  const notes = shown.filter((e) => e.type === 'text');
  const shapes = shown.filter((e) => !isFrame(e) && e.type !== 'arrow' && e.type !== 'text');

  const counts = [
    shapes.length && plural(shapes.length, 'shape'),
    arrows.length && plural(arrows.length, 'arrow'),
    notes.length && plural(notes.length, 'note'),
    frames.length && plural(frames.length, 'frame')
  ].filter(Boolean);
  const lines = [`${title} · rev ${opts.rev} · ${counts.length ? counts.join(', ') : 'empty'}`];

  const where = (e: SceneEl) => `@(${r0(e.x)},${r0(e.y)})`;
  const inFrame = (e: SceneEl) => (typeof e.frameId === 'string' ? ` in frame ${name(e.frameId)}` : '');
  const link = (e: SceneEl) => (typeof e.link === 'string' && e.link ? ` → ${e.link}` : '');
  const section = (head: string, items: SceneEl[], line: (e: SceneEl) => string) => {
    if (items.length) lines.push(`${head}:`, ...items.map((e) => `  ${line(e)}`));
  };

  section('frames', frames, (f) => {
    const n = shown.filter((e) => e.frameId === f.id).length;
    return `${name(f.id)} [${f.id}] ${where(f)} ${r0(f.width)}x${r0(f.height)}: ${plural(n, 'element')}`;
  });
  section('shapes', shapes, (e) => {
    const label = labelOf(e, get);
    return `${e.type}${label ? ` "${label}"` : ''} [${e.id}] ${where(e)} ${r0(e.width)}x${r0(e.height)}${inFrame(e)}${link(e)}`;
  });
  section('arrows', arrows, (e) => {
    const label = labelOf(e, get);
    const ends = bindingId(e.startBinding) || bindingId(e.endBinding)
      ? `${name(bindingId(e.startBinding))}→${name(bindingId(e.endBinding))} [${e.id}]`
      : `arrow [${e.id}] ${where(e)}`;
    return `${ends}${label ? ` label "${label}"` : ''}${inFrame(e)}${link(e)}`;
  });
  section('notes', notes, (e) => `"${labelOf(e, get) ?? ''}" [${e.id}] ${where(e)}${inFrame(e)}${link(e)}`);

  const groups = new Map<string, SceneEl[]>();
  for (const e of shown) {
    for (const g of (e.groupIds as string[] | undefined) ?? []) groups.set(g, [...(groups.get(g) ?? []), e]);
  }
  const shownGroups = [...groups].filter(([, members]) => members.length > 1);
  if (shownGroups.length) lines.push('groups:', ...shownGroups.map(([g, m]) => `  [${g}]: ${m.map((e) => name(e.id)).join(', ')}`));

  const max = opts.maxLines ?? 200;
  if (lines.length <= max) return lines.join('\n');
  return [...lines.slice(0, max), `… and ${lines.length - max} more lines`].join('\n');
}
