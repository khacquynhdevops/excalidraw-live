// Canvas server: serves the web app and syncs a folder of diagrams over WebSocket.
// It runs as the bundle runtime/server.mjs inside the init skill, with the web
// app in runtime/web next to it.
//   PROJECT_DIR   project root; state goes to .claude/skills/setup-excalidraw-live-multiagent/state/ (default: cwd)
//   DIAGRAMS_DIR  folder holding diagrams.json and the .excalidraw files (default <project>/docs/diagrams)
//   PORT          default: a free port
//   HOST          default 127.0.0.1
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { diagramsDir, stateDir } from '@excalidraw-live/shared/ensureServer';
import { Workspace } from './workspace.js';
import { startServer } from './http.js';
import { exitOnSignal, writeState } from './lifecycle.js';

const projectDir = resolve(process.env.PROJECT_DIR ?? '.');
const dir = resolve(process.env.DIAGRAMS_DIR ?? diagramsDir(projectDir));
const port = Number(process.env.PORT ?? 0);
const host = process.env.HOST ?? '127.0.0.1';
const staticDir = fileURLToPath(new URL('./web', import.meta.url));

const workspace = await Workspace.load({ dir, cursorsPath: join(stateDir(projectDir), 'cursors.json') });
const server = await startServer({ workspace, port, host, staticDir });
const actual = (server.http.address() as AddressInfo).port;
exitOnSignal(server, projectDir);
await writeState(projectDir, actual);
console.log(`excalidraw-live: http://${host}:${actual}/  →  ${dir}`);
