// The setup skill (set up, --update, --stop, --restart), run as Claude would
// run it from a project root, with both skills copied into .claude/skills
// as `npx skills add --copy` does.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

describe('setup-excalidraw-live', () => {
  let dir: string;
  const init = (...args: string[]) => run(dir, '.claude/skills/setup-excalidraw-live/scripts/setup.mjs', '', {}, args);
  const json = (p: string) => JSON.parse(readFileSync(join(dir, p), 'utf8'));

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'xl-init-')));
    for (const skill of ['setup-excalidraw-live', 'excalidraw-collab'])
      cpSync(join(tool, 'skills', skill), join(dir, '.claude', 'skills', skill), { recursive: true });
    // A project that already has settings, a prompt hook of its own, an MCP
    // server and a .gitignore, plus the prompt hook and status line an older
    // setup wrote.
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
    const r = await init('--agents', 'po-diagram,dev-diagram');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/http:\/\/127\.0\.0\.1:\d+/);

    expect(json('.mcp.json').mcpServers).toEqual({
      other: { command: 'x' },
      'excalidraw-live': { command: 'node', args: ['.claude/skills/setup-excalidraw-live/runtime/mcp.mjs'] }
    });
    for (const role of ['po', 'dev', 'tester', 'devops', 'security'])
      expect(existsSync(join(dir, '.claude', 'agents', `${role}-diagram.md`))).toBe(role === 'po' || role === 'dev');
    // The older setup's status line and prompt hook go; the project's own stay.
    expect(json('.claude/settings.json')).toEqual({
      permissions: { allow: ['Bash(ls)'] },
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] }
    });
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('node_modules/\n.claude/excalidraw-live/state/\n*.excalidraw.log.jsonl\n');
    expect(existsSync(join(dir, '.claude', 'excalidraw-live', 'state', 'server.json'))).toBe(true);
  }, 30_000);

  it('stops the server with the last drawing saved', async () => {
    const url = (await findServer(dir))!.url;
    await fetch(`${url}/api/diagrams`, { method: 'POST', body: JSON.stringify({ name: 'Shop', kind: 'overview', owner: 'po' }) });
    const id = (json('docs/diagrams/diagrams.json') as { id: string; file: string }[])[0];
    const ws = new (await import('ws')).default(`${url.replace('http', 'ws')}/ws/${id.id}`);
    await new Promise((r) => ws.on('open', r));
    const el = { id: 'last', type: 'ellipse', x: 0, y: 0, width: 10, height: 10, version: 1, versionNonce: 1, isDeleted: false, updated: Date.now() };
    ws.send(JSON.stringify({ t: 'client_patch', clientId: 'tab', baseRev: 0, elements: [el] }));
    await new Promise((r) => setTimeout(r, 100));
    ws.close();

    const r = await init('--stop');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`docs/diagrams/${id.file}`);
    expect(await findServer(dir)).toBeNull();
    expect(existsSync(join(dir, '.claude', 'excalidraw-live', 'state', 'server.json'))).toBe(false);
    expect(readFileSync(join(dir, 'docs', 'diagrams', id.file), 'utf8')).toContain('"id": "last"');

    const again = await init('--stop');
    expect(again).toEqual({ code: 0, out: 'no canvas server is running for this project\n' });
  }, 30_000);

  it('without choices installs no agent and no settings, and refuses an unknown role', async () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'xl-bare-')));
    for (const skill of ['setup-excalidraw-live', 'excalidraw-collab'])
      cpSync(join(tool, 'skills', skill), join(bare, '.claude', 'skills', skill), { recursive: true });
    const script = '.claude/skills/setup-excalidraw-live/scripts/setup.mjs';

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

  it('installed as a plugin, leaves the MCP server and skills to the plugin', async () => {
    // The plugin's layout: <plugin>/.claude-plugin/plugin.json beside <plugin>/skills/.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'xl-plugin-')));
    const plugin = join(root, 'plugin'), project = join(root, 'project');
    cpSync(join(tool, '.claude-plugin'), join(plugin, '.claude-plugin'), { recursive: true });
    for (const skill of ['setup-excalidraw-live', 'excalidraw-collab'])
      cpSync(join(tool, 'skills', skill), join(plugin, 'skills', skill), { recursive: true });
    mkdirSync(project);

    const r = await run(project, join(plugin, 'skills', 'setup-excalidraw-live', 'scripts', 'setup.mjs'), '', {}, ['--agents', 'po-diagram']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/canvas server started/);
    expect(existsSync(join(project, '.mcp.json'))).toBe(false);
    expect(existsSync(join(project, '.claude', 'skills'))).toBe(false);
    expect(existsSync(join(project, '.claude', 'agents', 'po-diagram.md'))).toBe(true);
    expect(existsSync(join(project, 'docs', 'diagrams', 'diagrams.json'))).toBe(true);
    expect(readFileSync(join(project, '.gitignore'), 'utf8')).toBe('.claude/excalidraw-live/state/\n*.excalidraw.log.jsonl\n');

    // --harness works from the plugin too, by the plugin's absolute path.
    const h = await run(project, join(plugin, 'skills', 'setup-excalidraw-live', 'scripts', 'setup.mjs'), '', {}, ['--harness', 'gemini,claude']);
    expect(h.code, h.out).toBe(0);
    expect(JSON.parse(readFileSync(join(project, '.gemini', 'settings.json'), 'utf8')).mcpServers['excalidraw-live'])
      .toEqual({ command: 'node', args: [join(plugin, 'skills', 'setup-excalidraw-live', 'runtime', 'mcp.mjs')] });
    expect(existsSync(join(project, '.mcp.json'))).toBe(false);
    process.kill((await findServer(project))!.pid, 'SIGTERM');
  }, 30_000);

  // `npx skills add` without -a claude-code puts the skills in .agents/skills.
  describe('--harness', () => {
    let at: string;
    const script = '.agents/skills/setup-excalidraw-live/scripts/setup.mjs';
    const server = '.agents/skills/setup-excalidraw-live/runtime/mcp.mjs';
    const read = (p: string) => readFileSync(join(at, p), 'utf8');
    const setup = async (...harness: string[]) => {
      const r = await run(at, script, '', {}, harness.flatMap((h) => ['--harness', h]));
      expect(r.code, r.out).toBe(0);
      return r.out;
    };

    beforeAll(async () => {
      at = realpathSync(mkdtempSync(join(tmpdir(), 'xl-harness-')));
      for (const skill of ['setup-excalidraw-live', 'excalidraw-collab'])
        cpSync(join(tool, 'skills', skill), join(at, '.agents', 'skills', skill), { recursive: true });
    });
    afterAll(async () => {
      const s = await findServer(at);
      if (s) process.kill(s.pid, 'SIGTERM');
    });

    const cases = [
      { h: 'cursor', file: '.cursor/mcp.json', path: ['mcpServers'],
        ours: { type: 'stdio', command: 'node', args: [`\${workspaceFolder}/${server}`], env: { PROJECT_DIR: '${workspaceFolder}' } } },
      { h: 'gemini', file: '.gemini/settings.json', path: ['mcpServers'], ours: { command: 'node', args: [server] } },
      { h: 'vscode', file: '.vscode/mcp.json', path: ['servers'],
        ours: { type: 'stdio', command: 'node', args: [`\${workspaceFolder}/${server}`], cwd: '${workspaceFolder}' } },
      { h: 'opencode', file: 'opencode.json', path: ['mcp', 'servers'], ours: { type: 'local', command: ['node', server], cwd: '.' } }
    ];
    const nest = (path: string[], v: object): object => path.reduceRight((acc, k) => ({ [k]: acc }), v);

    for (const c of cases) {
      it(`${c.h}: creates, merges and reruns without change`, async () => {
        rmSync(join(at, c.file), { force: true });
        expect(await setup(c.h)).toContain(`created   ${c.file}`);
        expect(JSON.parse(read(c.file))).toEqual(nest(c.path, { 'excalidraw-live': c.ours }));

        // An existing file: other servers and settings stay, ours is added.
        writeFileSync(join(at, c.file), JSON.stringify({ theme: 'x', ...nest(c.path, { other: { command: 'x' } }) }));
        expect(await setup(c.h)).toContain(`updated   ${c.file}`);
        const merged = read(c.file);
        expect(JSON.parse(merged)).toEqual({ theme: 'x', ...nest(c.path, { other: { command: 'x' }, 'excalidraw-live': c.ours }) });

        expect(await setup(c.h)).toContain(`unchanged ${c.file}`);
        expect(read(c.file)).toBe(merged);
      }, 30_000);
    }

    it('codex: appends its table once and never rewrites the file', async () => {
      const file = '.codex/config.toml';
      const table = `[mcp_servers.excalidraw-live]\ncommand = "node"\nargs = ["${server}"]\n`;
      expect(await setup('codex')).toContain(`created   ${file}`);
      expect(read(file)).toBe(table);

      const mine = '# mine\nmodel = "x"\n\n[mcp_servers.other]\ncommand = "x"';
      writeFileSync(join(at, file), mine);
      expect(await setup('codex')).toContain(`updated   ${file}`);
      expect(read(file)).toBe(`${mine}\n\n${table}`);

      expect(await setup('codex')).toContain(`kept      ${file}`);
      expect(read(file)).toBe(`${mine}\n\n${table}`);
    }, 30_000);

    it('replaces only an entry of ours that points elsewhere, and takes several harnesses', async () => {
      // Another project's copy contains our path but is not it.
      writeFileSync(join(at, '.gemini/settings.json'), JSON.stringify({ mcpServers: { 'excalidraw-live': { command: 'node', args: [`/old-project/${server}`] } } }));
      writeFileSync(join(at, '.cursor/mcp.json'), JSON.stringify({ mcpServers: { 'excalidraw-live': { command: 'node', args: [`\${workspaceFolder}/${server}`], env: { MINE: '1' } } } }));
      // A full path to this project's server is ours too.
      const vscode = { 'excalidraw-live': { type: 'stdio', command: 'node', args: [join(at, server)], env: { MINE: '1' } } };
      writeFileSync(join(at, '.vscode/mcp.json'), JSON.stringify({ servers: vscode }));
      const out = await run(at, script, '', {}, ['--harness', 'gemini,cursor,vscode']);
      expect(out.code, out.out).toBe(0);
      expect(out.out).toContain('updated   .gemini/settings.json');
      expect(out.out).toContain('unchanged .cursor/mcp.json');
      expect(JSON.parse(read('.vscode/mcp.json')).servers).toEqual(vscode);
      expect(JSON.parse(read('.gemini/settings.json')).mcpServers['excalidraw-live'].args).toEqual([server]);
      // No Claude Code files on the --harness path.
      expect(existsSync(join(at, '.mcp.json'))).toBe(false);
      expect(existsSync(join(at, '.claude', 'skills'))).toBe(false);
    }, 30_000);

    it('refuses an unknown harness', async () => {
      expect(await run(at, script, '', {}, ['--harness', 'codex,emacs']))
        .toEqual({ code: 1, out: 'unknown harness: emacs (choose from claude, codex, cursor, gemini, vscode, opencode)\n' });
    });
  });

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
