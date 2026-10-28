import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import type { Presence } from '@excalidraw-live/shared';
import { WorkspaceError, type Workspace } from './workspace.js';
import { allowedOrigin, attachSync, type SyncRooms } from './ws.js';
import { agentApi } from './agent-api.js';
import { json, readJson } from './json.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

export interface ServerOptions {
  workspace: Workspace;
  port: number;
  host: string;
  // Built web app (web/dist). Without it only the WebSocket is served.
  staticDir?: string;
}

export interface CanvasServer {
  http: Server;
  presence(diagramId: string): Map<string, Presence> | undefined;
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions): Promise<CanvasServer> {
  const http = createServer(async (req, res) => {
    if (req.url === '/health') {
      json(res, 200, { ok: true, pid: process.pid, diagramsDir: opts.workspace.dir });
      return;
    }
    if (req.url?.startsWith('/api/')) {
      await api(opts.workspace, room, req, res);
      return;
    }
    if (!opts.staticDir) {
      res.writeHead(404).end();
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    // normalize() resolves "..", and the leading "/" keeps the result inside staticDir.
    const file = join(opts.staticDir, normalize(pathname));
    for (const candidate of [file, join(opts.staticDir, 'index.html')]) {
      try {
        const body = await readFile(candidate);
        res.writeHead(200, { 'content-type': MIME[extname(candidate)] ?? 'application/octet-stream' }).end(body);
        return;
      } catch {
        // try the SPA fallback next
      }
    }
    res.writeHead(404).end();
  });
  const room = attachSync(http, opts.workspace);

  await new Promise<void>((resolve) => http.listen(opts.port, opts.host, resolve));
  return {
    http,
    presence: room.presence,
    async close() {
      room.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await opts.workspace.close();
    }
  };
}

//   GET   /api/diagrams        list
//   POST  /api/diagrams        create {name, kind, owner, audience?, refines?}
//   GET   /api/diagrams/:id    one entry
//   PATCH /api/diagrams/:id    rename {name}
async function api(workspace: Workspace, room: SyncRooms, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  // Same guard as the socket: other web pages must not change diagrams.
  if (req.method !== 'GET' && !allowedOrigin(req)) return json(res, 403, { error: 'forbidden origin' });

  try {
    if (await agentApi(workspace, room, url, req, res)) return;
    const m = /^\/api\/diagrams(?:\/([^/]+))?$/.exec(url.pathname);
    if (!m) return json(res, 404, { error: 'not found' });
    const id = m[1] && decodeURIComponent(m[1]);
    if (!id && req.method === 'GET') return json(res, 200, workspace.list());
    if (!id && req.method === 'POST') {
      const b = await readJson(req);
      const entry = await workspace.create({
        name: String(b.name ?? ''),
        kind: b.kind as never,
        owner: String(b.owner ?? ''),
        audience: Array.isArray(b.audience) ? b.audience.map(String) : undefined,
        refines: typeof b.refines === 'string' ? b.refines : undefined
      });
      return json(res, 201, entry);
    }
    if (id && !workspace.get(id)) return json(res, 404, { error: `unknown diagram: ${id}` });
    if (id && req.method === 'GET') return json(res, 200, workspace.get(id));
    if (id && req.method === 'PATCH') {
      const b = await readJson(req);
      return json(res, 200, await workspace.rename(id, String(b.name ?? '')));
    }
    json(res, 405, { error: 'method not allowed' });
  } catch (err) {
    if (err instanceof WorkspaceError) return json(res, 400, { error: err.message });
    console.error(err);
    json(res, 500, { error: 'internal error' });
  }
}
