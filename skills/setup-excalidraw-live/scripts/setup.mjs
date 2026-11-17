#!/usr/bin/env node
// Set up excalidraw-live in the project in the working directory, then start
// its canvas server. Safe to run again: it adds what is missing and leaves
// everything else (including files you edited) as it is.
//   --agents <list>  also install these role agents (comma list, e.g. po-diagram,
//                    dev-diagram, or none); without it no new agent is installed.
//                    Role agents are Claude Code's.
//   --harness <list> register the MCP server for these harnesses (comma list or
//                    repeated: claude, codex, cursor, gemini, vscode, opencode);
//                    without it, claude
//   --update   also overwrite the role agents already installed and the skill
//              with the skill's current copies; docs/diagrams/ is never touched
//   --stop     only stop the canvas server (see stop.mjs)
//   --restart  stop the server, then set up and start it again
// Everything it needs ships inside this skill (runtime/ holds the bundled
// MCP server, canvas server and web app; agents/ the role agents), found
// through the realpath of this script. Installed as a Claude Code plugin, the
// plugin brings the MCP server and the skills for Claude Code; installed by
// `npx skills add`, this script writes .mcp.json and copies excalidraw-collab.
// Other harnesses get the MCP server in their own config file. Either way the
// project gets .gitignore lines, docs/diagrams/ and any role agents asked for.
import { spawnSync } from 'node:child_process';
import { appendFile, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const skill = join(dirname(fileURLToPath(import.meta.url)), '..');
const skills = dirname(skill);
const project = process.cwd();
const update = process.argv.includes('--update');
const stop = process.argv.includes('--stop');
const restart = process.argv.includes('--restart');
const agentsArg = process.argv[process.argv.indexOf('--agents') + 1];
const asked = process.argv.includes('--agents') && agentsArg && agentsArg !== 'none' ? agentsArg.split(',').map((a) => a.trim()) : [];
const harnessArgs = process.argv.flatMap((a, i) => (process.argv[i - 1] === '--harness' ? a.split(',').map((h) => h.trim()) : []));
const mcpEntry = join(skill, 'runtime', 'mcp.mjs');
// A plugin keeps the skills in <plugin>/skills/ next to <plugin>/.claude-plugin/.
const plugin = existsSync(join(skills, '..', '.claude-plugin', 'plugin.json'));
const scripts = join(skill, 'scripts');
// Config written into the project names the MCP server by a path relative to
// its root, so the files can be committed and work in any clone; a skill
// outside the project (a plugin, a global install) is named by its absolute
// path. Harnesses start the MCP server in the project root.
const fromRoot = relative(project, mcpEntry);
const mcpPath = fromRoot.startsWith('..') || isAbsolute(fromRoot) ? mcpEntry : fromRoot.split(sep).join('/');
// Without --harness: Claude Code, which the plugin already serves.
const harnesses = harnessArgs.length ? harnessArgs : plugin ? [] : ['claude'];
const claudeMcp = harnesses.includes('claude') && !plugin;
const report = [];
const note = (what, path) => report.push(`${what.padEnd(9)} ${relative(project, path) || '.'}`);

if (stop || restart) {
  const r = spawnSync(process.execPath, [join(scripts, 'stop.mjs')], { stdio: 'inherit' });
  if (stop || r.status !== 0) process.exit(r.status ?? 1);
}

for (const need of plugin ? [mcpEntry] : [mcpEntry, join(skills, 'excalidraw-collab')]) {
  if (!existsSync(need)) {
    console.error(`missing ${need}: ${plugin ? 'reinstall the plugin with `claude plugin install excalidraw-live@excalidraw-live -s local`' : 'install the skills with `npx skills add khacquynhdevops/excalidraw-live`'}`);
    process.exit(1);
  }
}

// Where each harness reads a project's MCP servers, and our entry in it.
// cwd and ${workspaceFolder} only where the harness documents them.
const inFolder = (p) => (isAbsolute(p) ? p : `\${workspaceFolder}/${p}`);
const HARNESSES = {
  claude: { file: '.mcp.json', keys: ['mcpServers'], entry: (p) => ({ command: 'node', args: [p] }) },
  codex: { file: '.codex/config.toml' },
  cursor: { file: '.cursor/mcp.json', keys: ['mcpServers'], entry: (p) => ({ type: 'stdio', command: 'node', args: [inFolder(p)], env: { PROJECT_DIR: '${workspaceFolder}' } }) },
  gemini: { file: '.gemini/settings.json', keys: ['mcpServers'], entry: (p) => ({ command: 'node', args: [p] }) },
  vscode: { file: '.vscode/mcp.json', keys: ['servers'], entry: (p) => ({ type: 'stdio', command: 'node', args: [inFolder(p)], cwd: '${workspaceFolder}' }) },
  opencode: { file: 'opencode.json', keys: ['mcp', 'servers'], entry: (p) => ({ type: 'local', command: ['node', p], cwd: '.' }) }
};
const badHarness = harnesses.filter((h) => !HARNESSES[h]);
if (badHarness.length) {
  console.error(`unknown harness: ${badHarness.join(', ')} (choose from ${Object.keys(HARNESSES).join(', ')})`);
  process.exit(1);
}

const roles = (await readdir(join(skill, 'agents'))).map((f) => f.replace(/\.md$/, '')).sort();
const unknown = asked.filter((r) => !roles.includes(r));
if (unknown.length) {
  console.error(`unknown role agent: ${unknown.join(', ')} (choose from ${roles.join(', ')})`);
  process.exit(1);
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`${relative(project, path)} is not valid JSON; fix it and run again`);
  }
}

// Write only when something changed, so a second run leaves files untouched.
async function writeJson(path, before, after) {
  if (JSON.stringify(before) === JSON.stringify(after)) return note('unchanged', path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(after, null, 2) + '\n');
  note(before === undefined ? 'created' : 'updated', path);
}

async function copyOne(src, dst) {
  if (!existsSync(dst)) {
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
    note('created', dst);
  } else if (!update) note('kept', dst);
  else if ((await readFile(src)).equals(await readFile(dst))) note('unchanged', dst);
  else {
    await copyFile(src, dst);
    note('updated', dst);
  }
}

async function copyFiles(from, to) {
  for (const name of await readdir(from, { withFileTypes: true })) {
    const src = join(from, name.name), dst = join(to, name.name);
    if (name.isDirectory()) await copyFiles(src, dst);
    else await copyOne(src, dst);
  }
}

// Our MCP server in each harness's config. Other servers are kept, and so is
// an entry of ours that still points at this mcp.mjs.
async function addServer(path, keys, entry) {
  const before = await readJson(path, undefined);
  const after = structuredClone(before ?? {});
  let at = after;
  for (const k of keys) at = at[k] ??= {};
  const old = at['excalidraw-live'];
  // Ours when a path in it leads to this server, however it is written.
  const ours = [old?.args, old?.command].flat()
    .some((s) => typeof s === 'string' && resolve(project, s.replace('${workspaceFolder}', project)) === mcpEntry);
  if (!ours) at['excalidraw-live'] = entry;
  await writeJson(path, before, after);
}

// TOML is appended to, never rewritten: our table goes in only when absent.
async function addCodexServer(path) {
  const text = existsSync(path) ? await readFile(path, 'utf8') : '';
  if (/^\s*\[\s*mcp_servers\.(?:excalidraw-live|"excalidraw-live"|'excalidraw-live')\s*\]/m.test(text)) {
    note('kept', path);
    if (!text.includes(mcpPath)) report.push(`note      the excalidraw-live server in ${relative(project, path)} points elsewhere: set its args to [${JSON.stringify(mcpPath)}]`);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}[mcp_servers.excalidraw-live]\ncommand = "node"\nargs = [${JSON.stringify(mcpPath)}]\n`);
  note(text ? 'updated' : 'created', path);
}

for (const h of harnesses) {
  if (h === 'claude' && plugin) continue; // the plugin brings its own
  const { file, keys, entry } = HARNESSES[h];
  // opencode also reads opencode.jsonc; use it when that is the one there.
  const name = h === 'opencode' && !existsSync(join(project, file)) && existsSync(join(project, 'opencode.jsonc')) ? 'opencode.jsonc' : file;
  if (h === 'codex') await addCodexServer(join(project, name));
  // JSON with comments would lose them if rewritten: say what to add instead.
  else if (name === 'opencode.jsonc') report.push(`note      add to opencode.jsonc under "mcp": { "servers": … }: "excalidraw-live": ${JSON.stringify(entry(mcpPath))}`);
  else await addServer(join(project, name), keys, entry(mcpPath));
}

// Role agents: only the ones asked for, plus (with --update) the ones the
// project already has. Any session can use the boards without them.
const claude = join(project, '.claude');
{
  const have = (r) => existsSync(join(claude, 'agents', `${r}.md`));
  // Earlier names of each agent (po.md before po-diagram.md, swe.md before
  // dev): --update installs the new name and leaves the old file to the user.
  const old = (r) => [r.replace(/-diagram$/, ''), ...(r === 'dev-diagram' ? ['swe'] : [])].filter(have);
  for (const r of roles.filter((r) => asked.includes(r) || (update && (have(r) || old(r).length)))) {
    await copyOne(join(skill, 'agents', `${r}.md`), join(claude, 'agents', `${r}.md`));
    if (update) for (const o of old(r)) report.push(`note      the ${o} agent is now ${r}: remove .claude/agents/${o}.md yourself`);
  }
}
// `npx skills add` usually installed it already; then it is kept. The plugin brings its own.
if (claudeMcp) await copyFiles(join(skills, 'excalidraw-collab'), join(claude, 'skills', 'excalidraw-collab'));

// docs/diagrams/ is the source of truth and goes into git.
{
  const path = join(project, 'docs', 'diagrams', 'diagrams.json');
  if (existsSync(path)) note('kept', path);
  else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '[]\n');
    note('created', path);
  }
}

// .claude/excalidraw-live/state/ holds runtime state (server.json, logs); the
// per-diagram change logs sit next to the drawings but are not worth keeping.
{
  const path = join(project, '.gitignore');
  const text = existsSync(path) ? await readFile(path, 'utf8') : '';
  const have = new Set(text.split('\n').map((l) => l.trim().replace(/^\//, '')));
  const missing = ['.claude/excalidraw-live/state/', '*.excalidraw.log.jsonl'].filter((l) => !have.has(l));
  if (!missing.length) note('unchanged', path);
  else {
    await appendFile(path, `${text && !text.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
    note(text ? 'updated' : 'created', path);
  }
}

// .claude/settings.json: older setups added a status line (statusline.mjs)
// and a prompt hook (unread-hint.mjs) whose scripts are gone; take them out.
// The plugin's band above the prompt shows the unread count now.
{
  const path = join(claude, 'settings.json');
  const before = await readJson(path, undefined);
  const after = structuredClone(before ?? {});
  const prompt = after.hooks?.UserPromptSubmit;
  if (prompt) {
    for (const m of prompt) m.hooks = m.hooks?.filter((h) => !h.command?.includes('unread-hint.mjs'));
    after.hooks.UserPromptSubmit = prompt.filter((m) => m.hooks?.length);
    if (!after.hooks.UserPromptSubmit.length) delete after.hooks.UserPromptSubmit;
    if (!Object.keys(after.hooks).length) delete after.hooks;
  }
  if (after.statusLine?.command?.includes('statusline.mjs')) delete after.statusLine;
  if (before) await writeJson(path, before, after);
}

const { ensureServer } = await import(join(skill, 'runtime', 'ensure-server.mjs'));
const server = await ensureServer(project);
console.log(report.join('\n'));
console.log(`\ncanvas server ${server.started ? 'started' : 'already running'}: ${server.url} (pid ${server.pid})`);
if (update && !server.started) {
  console.log('The running server and open Claude sessions still use the old code: run /setup-excalidraw-live --restart, and restart the Claude sessions.');
}
if (plugin) console.log('A Claude session opened before the plugin was installed must be restarted to load its MCP server and band (`claude`, or `claude --agent <role>-diagram` for an installed role agent).');
else if (claudeMcp) console.log('Start Claude again (`claude`, or `claude --agent <role>-diagram` for an installed role agent). A session that was already open must be restarted to load the MCP server.');
const others = harnesses.filter((h) => h !== 'claude');
if (others.length) console.log(`Restart ${others.join(', ')} so it loads the excalidraw-live MCP server.${others.includes('codex') ? ' Codex reads .codex/config.toml only in a trusted project.' : ''}`);
