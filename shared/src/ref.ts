import type { BoardRef } from './types.js';

// Agent form: dl://<diagramId>[@<rev>][#<elementId>]
const DL = /^dl:\/\/([^@#\s/?]+)(?:@(\d+))?(?:#(\S+))?$/;

// Reads a board reference in either the agent form (`dl://d_x@57#el`) or the
// browser form (`http://127.0.0.1:3000/d/d_x?rev=57#el`). Null if neither.
export function parseRef(s: string): BoardRef | null {
  const m = DL.exec(s);
  if (m) return build(m[1], m[2], m[3]);

  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const path = /^\/d\/([^/]+)$/.exec(url.pathname);
  if (!path) return null;
  const rev = url.searchParams.get('rev');
  if (rev !== null && !/^\d+$/.test(rev)) return null;
  return build(decodeURIComponent(path[1]), rev ?? undefined, url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined);
}

// Writes the agent form, or the browser form when `baseUrl` is given.
export function formatRef(ref: BoardRef, baseUrl?: string): string {
  const el = ref.elementId ? `#${ref.elementId}` : '';
  if (!baseUrl) return `dl://${ref.id}${ref.rev !== undefined ? `@${ref.rev}` : ''}${el}`;
  const rev = ref.rev !== undefined ? `?rev=${ref.rev}` : '';
  return `${baseUrl.replace(/\/+$/, '')}/d/${encodeURIComponent(ref.id)}${rev}${el}`;
}

function build(id: string, rev?: string, elementId?: string): BoardRef {
  const ref: BoardRef = { id };
  if (rev !== undefined) ref.rev = Number(rev);
  if (elementId) ref.elementId = elementId;
  return ref;
}
