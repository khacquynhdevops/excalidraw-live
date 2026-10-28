// For the status line: the board this Claude session has open, and how many
// changes its role has not read. Null when there is no open board or no
// server; the status line then stays empty.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// The MCP server records its binding under its parent, the Claude process.
// The status line runs a few levels below that same process, so walk up.
function ancestors(pid, depth = 8) {
  const out = [];
  for (let p = pid; p > 1 && out.length < depth; ) {
    out.push(p);
    try {
      p = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(p)], { encoding: 'utf8' }).trim());
    } catch {
      break;
    }
  }
  return out;
}

export async function boardStatus(projectDir) {
  const state = join(projectDir, '.claude', 'skills', 'setup-excalidraw-live-multiagent', 'state');
  let session = null;
  for (const pid of ancestors(process.ppid)) {
    session = await readFile(join(state, 'sessions', `${pid}.json`), 'utf8').then(JSON.parse, () => null);
    if (session) break;
  }
  if (!session) return null;
  try {
    const { port } = JSON.parse(await readFile(join(state, 'server.json'), 'utf8'));
    const res = await fetch(`http://127.0.0.1:${port}/api/diagrams/${encodeURIComponent(session.diagramId)}/status?as=${encodeURIComponent(session.as)}`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return null;
    return { diagramId: session.diagramId, ...(await res.json()) };
  } catch {
    return null;
  }
}

export async function projectDir() {
  let input = {};
  try {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    input = JSON.parse(raw || '{}');
  } catch {
    // no input
  }
  return process.env.CLAUDE_PROJECT_DIR || input.workspace?.project_dir || input.cwd || process.cwd();
}
