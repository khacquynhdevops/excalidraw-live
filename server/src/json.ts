import type { IncomingMessage, ServerResponse } from 'node:http';
import { WorkspaceError } from './workspace.js';

const MAX_BODY = 64 * 1024;

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) throw new WorkspaceError('body too large');
  }
  try {
    const body = JSON.parse(raw);
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {
    // fall through
  }
  throw new WorkspaceError('body must be a JSON object');
}
