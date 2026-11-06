// The setup skill (set up, --update, --stop, --restart), run as Claude would
// run it from a project root, with both skills copied into .claude/skills
// as `npx skills add --copy` does (a symlink would put state/ in this repo).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findServer } from '@excalidraw-live/shared/ensureServer';

const tool = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));

function run(cwd: string, script: string, input = '', env: Record<string, string> = {}, args: string[] = []) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    const child = execFile(process.execPath, [script, ...args], { cwd, env: { ...process.env, ...env } }, (err, stdout, stderr) =>
      resolve({ code: err ? Number(err.code ?? 1) : 0, out: stdout + stderr }));
    child.stdin!.end(input);
  });
}

describe('setup-excalidraw-live-multiagent', () => {
  let dir: string;
  const init = (...args: string[]) => run(dir, '.claude/skills/setup-excalidraw-live-multiagent/scripts/setup.mjs', '', {}, args);
  const json = (p: string) => JSON.parse(readFileSync(join(dir, p), 'utf8'));

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'xl-init-')));
    for (const skill of ['setup-excalidraw-live-multiagent', 'excalidraw-collab'])
      cpSync(join(tool, 'skills', skill), join(dir, '.claude', 'skills', skill), { recursive: true });
    // A project that already has settings, a prompt hook of its own, an MCP
    // server and a .gitignore, plus the prompt hook and absolute status line
    // path an older setup wrote.
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({
      permissions: { allow: ['Bash(ls)'] },
      hooks: { UserPromptSubmit: [
        { hooks: [{ type: 'command', command: 'echo mine' }] },
        { hooks: [{ type: 'command', command: 'node "/old/scripts/unread-hint.mjs"' }] }
      ] },
      statusLine: { type: 'command', command: 'node "/old/scripts/statusline.mjs"' }
    }));
    writeFileSync(join(dir, '.gitignore'), 'node_modules/');
  });
  afterAll(async () => {
    const s = await findServer(dir);
    if (s) process.kill(s.pid, 'SIGTERM');
  });

  it('installs what was chosen and starts the server', async () => {
    const r = await init('--statusline', '--agents', 'po-diagram,dev-diagram');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/http:\/\/127\.0\.0\.1:\d+/);

    expect(json('.mcp.json').mcpServers).toEqual({
      other: { command: 'x' },
      'excalidraw-live': { command: 'node', args: ['.claude/skills/setup-excalidraw-live-multiagent/runtime/mcp.mjs'] }
    });
    for (const role of ['po', 'dev', 'tester', 'devops', 'security'])
      expect(existsSync(join(dir, '.claude', 'agents', `${role}-diagram.md`))).toBe(role === 'po' || role === 'dev');
    expect(existsSync(join(dir, '.claude', 'skills', 'excalidraw-collab', 'references', 'elements.md'))).toBe(true);
    expect(json('docs/diagrams/diagrams.json')).toEqual([]);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('node_modules/\n.claude/skills/setup-excalidraw-live-multiagent/state/\n*.excalidraw.log.jsonl\n');

    const settings = json('.claude/settings.json');
    expect(settings.permissions).toEqual({ allow: ['Bash(ls)'] });
    // The old prompt hook is gone; the project's own is kept.
    expect(settings.hooks).toEqual({ UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] });
    // Relative to the project, so the committed files work in any clone.
    expect(settings.statusLine).toEqual({ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/skills/setup-excalidraw-live-multiagent/scripts/statusline.mjs"', refreshInterval: 2 });
    expect(await findServer(dir)).not.toBeNull();
  }, 30_000);

  it('changes nothing the second time and keeps edited files', async () => {
    writeFileSync(join(dir, '.claude', 'agents', 'po-diagram.md'), 'my own po');
    const before = ['.mcp.json', '.claude/settings.json', '.gitignore', 'docs/diagrams/diagrams.json'].map((p) => readFileSync(join(dir, p), 'utf8'));
    const pid = (await findServer(dir))!.pid;
    const r = await init();
    expect(r.code, r.out).toBe(0);
    expect(['.mcp.json', '.claude/settings.json', '.gitignore', 'docs/diagrams/diagrams.json'].map((p) => readFileSync(join(dir, p), 'utf8'))).toEqual(before);
    expect(readFileSync(join(dir, '.claude', 'agents', 'po-diagram.md'), 'utf8')).toBe('my own po');
    expect((await findServer(dir))!.pid).toBe(pid);
  }, 30_000);

  it('with --update brings the installed skills and agents up to date and leaves diagrams alone', async () => {
    const diagrams = readFileSync(join(dir, 'docs', 'diagrams', 'diagrams.json'), 'utf8');
    const pid = (await findServer(dir))!.pid;
    // An agent installed under its old name.
    writeFileSync(join(dir, '.claude', 'agents', 'security.md'), 'old security');
    const r = await init('--update');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/updated\s+\.claude\/agents\/po-diagram\.md/);
    expect(r.out).toMatch(/unchanged\s+\.claude\/agents\/dev-diagram\.md/);
    expect(r.out).toMatch(/restart/i);
    expect(readFileSync(join(dir, '.claude', 'agents', 'po-diagram.md'), 'utf8')).toBe(readFileSync(join(tool, 'skills', 'setup-excalidraw-live-multiagent', 'agents', 'po-diagram.md'), 'utf8'));
    expect(existsSync(join(dir, '.claude', 'agents', 'tester-diagram.md'))).toBe(false);
    expect(existsSync(join(dir, '.claude', 'agents', 'security-diagram.md'))).toBe(true);
    expect(readFileSync(join(dir, '.claude', 'agents', 'security.md'), 'utf8')).toBe('old security');
    expect(r.out).toContain('the security agent is now security-diagram: remove .claude/agents/security.md yourself');
    expect(readFileSync(join(dir, 'docs', 'diagrams', 'diagrams.json'), 'utf8')).toBe(diagrams);
    expect((await findServer(dir))!.pid).toBe(pid);
  }, 30_000);

  it('shows the board this Claude session has open, whose it is and its unread changes, and stays empty otherwise', async () => {
    const settings = json('.claude/settings.json');
    const script = (cmd: string) => /"([^"]+)"/.exec(cmd)![1].replace(/^\$\{?CLAUDE_PROJECT_DIR(:-\.)?\}?/, dir);
    const status = script(settings.statusLine.command);
    const env = { CLAUDE_PROJECT_DIR: dir };

    // No session file for this process: empty.
    expect((await run(dir, status, '{}', env)).out).toBe('');

    const url = (await findServer(dir))!.url;
    await fetch(`${url}/api/diagrams`, { method: 'POST', body: JSON.stringify({ name: 'Shop', kind: 'overview', owner: 'po' }) });
    const id = (json('docs/diagrams/diagrams.json') as { id: string }[])[0].id;
    // What open_diagram does: bind on the server, and record the binding
    // under the Claude process, which the status line runs under too.
    await fetch(`${url}/api/sessions`, { method: 'POST', body: JSON.stringify({ session: 's', diagramId: id, as: 'po' }) });
    mkdirSync(join(dir, '.claude', 'skills', 'setup-excalidraw-live-multiagent', 'state', 'sessions'), { recursive: true });
    const bind = (as: string, mode: string) => writeFileSync(join(dir, '.claude', 'skills', 'setup-excalidraw-live-multiagent', 'state', 'sessions', `${process.pid}.json`), JSON.stringify({ diagramId: id, as, mode, session: 's' }));
    bind('po', 'writer');
    expect((await run(dir, status, '{}', env)).out).toBe('✏️ Shop · po: 0 unread');

    const ws = new (await import('ws')).default(`${url.replace('http', 'ws')}/ws/${id}`);
    await new Promise((r) => ws.on('open', r));
    const el = { id: 'a', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, version: 1, versionNonce: 1, isDeleted: false, updated: Date.now() };
    ws.send(JSON.stringify({ t: 'client_patch', clientId: 'tab', baseRev: 0, elements: [el] }));
    await new Promise((r) => setTimeout(r, 200));
    ws.close();

    expect((await run(dir, status, '{}', env)).out).toBe('✏️ Shop · po: 1 unread');
    // Another role's board: reading, or editing after the user confirmed.
    bind('dev', 'reader');
    expect((await run(dir, status, '{}', env)).out).toBe("👀 Shop (po's) · dev read-only: 0 unread");
    bind('dev', 'writer');
    expect((await run(dir, status, '{}', env)).out).toBe("⚠️ Shop (po's) · dev editing: 0 unread");
  }, 30_000);

  it('stops the server with the last drawing saved', async () => {
    const url = (await findServer(dir))!.url;
    const id = (json('docs/diagrams/diagrams.json') as { id: string; file: string }[])[0];
    const ws = new (await import('ws')).default(`${url.replace('http', 'ws')}/ws/${id.id}`);
    await new Promise((r) => ws.on('open', r));
    const el = { id: 'last', type: 'ellipse', x: 0, y: 0, width: 10, height: 10, version: 1, versionNonce: 1, isDeleted: false, updated: Date.now() };
    ws.send(JSON.stringify({ t: 'client_patch', clientId: 'tab', baseRev: 1, elements: [el] }));
    await new Promise((r) => setTimeout(r, 100));
    ws.close();

    const r = await init('--stop');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`docs/diagrams/${id.file}`);
    expect(await findServer(dir)).toBeNull();
    expect(existsSync(join(dir, '.claude', 'skills', 'setup-excalidraw-live-multiagent', 'state', 'server.json'))).toBe(false);
    expect(readFileSync(join(dir, 'docs', 'diagrams', id.file), 'utf8')).toContain('"id": "last"');

    const again = await init('--stop');
    expect(again).toEqual({ code: 0, out: 'no canvas server is running for this project\n' });
  }, 30_000);

  it('without choices installs no agent and no status line, and refuses an unknown role', async () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'xl-bare-')));
    for (const skill of ['setup-excalidraw-live-multiagent', 'excalidraw-collab'])
      cpSync(join(tool, 'skills', skill), join(bare, '.claude', 'skills', skill), { recursive: true });
    const script = '.claude/skills/setup-excalidraw-live-multiagent/scripts/setup.mjs';

    const wrong = await run(bare, script, '', {}, ['--agents', 'po-diagram,po']);
    expect(wrong).toEqual({ code: 1, out: 'unknown role agent: po (choose from dev-diagram, devops-diagram, po-diagram, security-diagram, tester-diagram)\n' });
    expect(existsSync(join(bare, '.mcp.json'))).toBe(false);

    const r = await run(bare, script);
    expect(r.code, r.out).toBe(0);
    expect(existsSync(join(bare, '.mcp.json'))).toBe(true);
    expect(existsSync(join(bare, '.claude', 'agents'))).toBe(false);
    expect(existsSync(join(bare, '.claude', 'settings.json'))).toBe(false);
    process.kill((await findServer(bare))!.pid, 'SIGTERM');
  }, 30_000);

  it('restarts the server, whether or not one is running', async () => {
    const first = await init('--restart');
    expect(first.code, first.out).toBe(0);
    expect(first.out).toMatch(/canvas server started/);
    const pid = (await findServer(dir))!.pid;

    const r = await init('--restart');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`stopped canvas server (pid ${pid}`);
    expect(r.out).toMatch(/canvas server started/);
    expect((await findServer(dir))!.pid).not.toBe(pid);
  }, 30_000);
});
