import { readFile, unlink } from 'node:fs/promises';
import { statePath, type ServerState } from '@excalidraw-live/shared/ensureServer';
import { writeAtomic } from './file-io.js';
import type { CanvasServer } from './http.js';

// Record this process in <projectDir>/.claude/skills/setup-excalidraw-live-multiagent/state/server.json so
// ensureServer can find it.
export async function writeState(projectDir: string, port: number): Promise<void> {
  const state: ServerState = { port, pid: process.pid, startedAt: new Date().toISOString() };
  await writeAtomic(statePath(projectDir), JSON.stringify(state, null, 2) + '\n');
}

// Remove server.json, unless another server has replaced it since.
export async function removeState(projectDir: string): Promise<void> {
  try {
    const state: ServerState = JSON.parse(await readFile(statePath(projectDir), 'utf8'));
    if (state.pid === process.pid) await unlink(statePath(projectDir));
  } catch {
    // already gone
  }
}

// On SIGINT/SIGTERM: stop accepting, flush pending saves, drop server.json, exit.
export function exitOnSignal(server: CanvasServer, projectDir: string): void {
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      if (stopping) return;
      stopping = true;
      try {
        await server.close();
      } finally {
        await removeState(projectDir);
        process.exit(0);
      }
    });
  }
}
