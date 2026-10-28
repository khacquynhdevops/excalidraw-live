import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientMsg, Presence, SceneFiles, ServerMsg } from '@excalidraw-live/shared';
import type { SceneStore } from './store.js';
import type { Workspace } from './workspace.js';
import { applyPatch } from './patch.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

// Base64 payload size of a data URL, in decoded bytes.
function fileBytes(dataURL: string): number {
  const comma = dataURL.indexOf(',');
  return Math.floor(((dataURL.length - comma - 1) * 3) / 4);
}

// The server binds to 127.0.0.1, but any web page the user has open could
// still open a socket to it. Only pages served from localhost may connect;
// non-browser clients (no Origin header) are allowed.
export function allowedOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === '127.0.0.1' || host === 'localhost';
  } catch {
    return false;
  }
}

export interface SyncRooms {
  presence(diagramId: string): Map<string, Presence> | undefined;
  // Send to every client viewing the diagram.
  broadcast(diagramId: string, msg: ServerMsg): void;
  close(): void;
}

interface Room {
  wss: WebSocketServer;
  presence: Map<string, Presence>;
}

// One room per diagram, reached at /ws/<id>: a browser patch is applied by
// version, accepted elements go to every other client in the room, refused
// ones go back to the sender.
export function attachSync(http: Server, workspace: Workspace): SyncRooms {
  const rooms = new Map<string, Room>();

  http.on('upgrade', async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const refuse = (status: string) => {
      socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
      socket.destroy();
    };
    const id = diagramIdOf(req.url);
    if (!id || !workspace.get(id) || !allowedOrigin(req)) return refuse('403 Forbidden');
    let store: SceneStore;
    try {
      store = await workspace.store(id);
    } catch (err) {
      console.error(`cannot open diagram ${id}:`, (err as Error).message);
      return refuse('500 Internal Server Error');
    }
    let room = rooms.get(id);
    if (!room) {
      room = { wss: new WebSocketServer({ noServer: true }), presence: new Map() };
      rooms.set(id, room);
    }
    const r = room;
    r.wss.handleUpgrade(req, socket, head, (ws) => serve(ws, r, store));
  });

  const broadcast = (id: string, msg: ServerMsg) => {
    for (const ws of rooms.get(id)?.wss.clients ?? []) if (ws.readyState === WebSocket.OPEN) send(ws, msg);
  };

  // Outside edits of a diagram file reach every client in its room.
  workspace.onFileChange((id, rev, elements, files) => {
    const out: ServerMsg = { t: 'scene_patch', rev, origin: 'file', elements };
    if (Object.keys(files).length) out.files = files as SceneFiles;
    broadcast(id, out);
  });

  return {
    presence: (id) => rooms.get(id)?.presence,
    broadcast,
    close() {
      for (const { wss } of rooms.values()) {
        for (const ws of wss.clients) ws.terminate();
        wss.close();
      }
    }
  };
}

const send = (ws: WebSocket, msg: ServerMsg) => ws.send(JSON.stringify(msg));

// The diagram id in /ws/<id>, or null when the path is not one.
function diagramIdOf(url = '/'): string | null {
  const m = /^\/ws\/([^/]+)$/.exec(new URL(url, 'http://x').pathname);
  try {
    return m && decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

// A message from the browser is dropped unless it has the shape the handler
// reads, so a bad one cannot take the server down.
function wellFormed(msg: unknown): msg is ClientMsg {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (typeof m.clientId !== 'string') return false;
  if (m.t !== 'client_patch') return true;
  if (!Array.isArray(m.elements) || !m.elements.every((e) => typeof e === 'object' && e !== null)) return false;
  if (m.files === undefined) return true;
  return typeof m.files === 'object' && m.files !== null &&
    Object.values(m.files).every((f) => typeof f === 'object' && f !== null && typeof (f as { dataURL?: unknown }).dataURL === 'string');
}

function serve(ws: WebSocket, { wss, presence }: Room, store: SceneStore): void {
  let clientId: string | null = null;
  send(ws, { t: 'scene_init', rev: store.revision, elements: store.all(), files: store.getFiles() as SceneFiles });

  ws.on('message', (data) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!wellFormed(msg)) return;
    clientId = msg.clientId;

    if (msg.t === 'presence') {
      const { editingId, selectedIds, idle } = msg;
      presence.set(msg.clientId, { editingId, selectedIds, idle });
      return;
    }

    if (msg.t === 'client_patch') {
      const files: SceneFiles = {};
      for (const [id, f] of Object.entries(msg.files ?? {})) {
        if (fileBytes(f.dataURL) > MAX_FILE_BYTES) console.warn(`file ${id} over 2MB, dropped`);
        else files[id] = f;
      }
      const newFileIds = store.addFiles(files);
      const { accepted, rejected } = applyPatch(store, msg.elements);

      if (rejected.length) send(ws, { t: 'patch_rejected', rev: store.revision, elements: rejected });
      if (!accepted.length && !newFileIds.length) return;
      const out: ServerMsg = { t: 'scene_patch', rev: store.revision, origin: 'human', elements: accepted };
      if (newFileIds.length) out.files = Object.fromEntries(newFileIds.map((id) => [id, files[id]]));
      for (const other of wss.clients) {
        if (other !== ws && other.readyState === WebSocket.OPEN) send(other, out);
      }
    }
  });

  ws.on('close', () => { if (clientId) presence.delete(clientId); });
}
