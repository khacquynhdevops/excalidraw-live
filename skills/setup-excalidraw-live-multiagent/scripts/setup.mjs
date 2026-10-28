#!/usr/bin/env node
// Set up excalidraw-live in the project in the working directory, then start
// its canvas server. Safe to run again: it adds what is missing and leaves
// everything else (including files you edited) as it is.
//   --update   also overwrite the role agents and skills it installed with the
//              skill's current copies; docs/diagrams/ is never touched
//   --stop     only stop the canvas server (see stop.mjs)
//   --restart  stop the server, then set up and start it again
// Everything it needs ships inside this skill (runtime/ holds the bundled
// MCP server, canvas server and web app; agents/ the role agents), found
// through the realpath of this script. The project gets only config under
// .claude/, .mcp.json, .gitignore lines and docs/diagrams/.
import { spawnSync } from 'node:child_process';
import { appendFile, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const skill = join(dirname(fileURLToPath(import.meta.url)), '..');
const skills = dirname(skill);
const project = process.cwd();
const update = process.argv.includes('--update');
const stop = process.argv.includes('--stop');
const restart = process.argv.includes('--restart');
const mcpEntry = join(skill, 'runtime', 'mcp.mjs');
const scripts = join(skill, 'scripts');
// Config written into the project uses paths relative to its root, so the
// files can be committed and work in any clone. Claude Code starts the MCP
// server in the folder `claude` was started from: the project root.
const rel = '.claude/skills/setup-excalidraw-live-multiagent';
const report = [];
const note = (what, path) => report.push(`${what.padEnd(9)} ${relative(project, path) || '.'}`);

if (stop || restart) {
  const r = spawnSync(process.execPath, [join(scripts, 'stop.mjs')], { stdio: 'inherit' });
  if (stop || r.status !== 0) process.exit(r.status ?? 1);
}

for (const need of [mcpEntry, join(skills, 'excalidraw-collab')]) {
  if (!existsSync(need)) {
    console.error(`missing ${need}: install the skills with \`npx skills add khacquynhdevops/excalidraw-live\``);
    process.exit(1);
  }
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

async function copyFiles(from, to) {
  for (const name of await readdir(from, { withFileTypes: true })) {
    const src = join(from, name.name), dst = join(to, name.name);
    if (name.isDirectory()) await copyFiles(src, dst);
    else if (!existsSync(dst)) {
      await mkdir(to, { recursive: true });
      await copyFile(src, dst);
      note('created', dst);
    } else if (!update) note('kept', dst);
    else if ((await readFile(src)).equals(await readFile(dst))) note('unchanged', dst);
    else {
      await copyFile(src, dst);
      note('updated', dst);
    }
  }
}

// .mcp.json: our entry, other servers kept.
{
  const path = join(project, '.mcp.json');
  const before = await readJson(path, undefined);
  const after = structuredClone(before ?? {});
  after.mcpServers = { ...after.mcpServers, 'excalidraw-live': { command: 'node', args: [`${rel}/runtime/mcp.mjs`] } };
  await writeJson(path, before, after);
}

// Role agents and skills.
const claude = join(project, '.claude');
await copyFiles(join(skill, 'agents'), join(claude, 'agents'));
// `npx skills add` usually installed it already; then it is kept.
await copyFiles(join(skills, 'excalidraw-collab'), join(claude, 'skills', 'excalidraw-collab'));

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

// The skill's state/ holds runtime state (server.json, sessions, logs); the
// per-diagram change logs sit next to the drawings but are not worth keeping.
{
  const path = join(project, '.gitignore');
  const text = existsSync(path) ? await readFile(path, 'utf8') : '';
  const have = new Set(text.split('\n').map((l) => l.trim().replace(/^\//, '')));
  const missing = ['.claude/skills/setup-excalidraw-live-multiagent/state/', '*.excalidraw.log.jsonl'].filter((l) => !have.has(l));
  if (!missing.length) note('unchanged', path);
  else {
    await appendFile(path, `${text && !text.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
    note(text ? 'updated' : 'created', path);
  }
}

// .claude/settings.json: the status line with the unread count, refreshed
// every 2 s so it moves while the user draws. Nothing goes into Claude's
// context: Claude reads the board only when asked. A status line the
// project already has is left alone.
{
  const path = join(claude, 'settings.json');
  const before = await readJson(path, undefined);
  const after = structuredClone(before ?? {});
  const status = `node "\${CLAUDE_PROJECT_DIR:-.}/${rel}/scripts/statusline.mjs"`;
  // Older setups added a prompt hook (unread-hint.mjs); take it out again.
  const prompt = after.hooks?.UserPromptSubmit;
  if (prompt) {
    for (const m of prompt) m.hooks = m.hooks?.filter((h) => !h.command?.includes('unread-hint.mjs'));
    after.hooks.UserPromptSubmit = prompt.filter((m) => m.hooks?.length);
    if (!after.hooks.UserPromptSubmit.length) delete after.hooks.UserPromptSubmit;
    if (!Object.keys(after.hooks).length) delete after.hooks;
  }
  // Ours is recognised by the script name, so an older absolute path is replaced.
  if (!after.statusLine || after.statusLine.command?.includes('statusline.mjs')) after.statusLine = { type: 'command', command: status, refreshInterval: 2 };
  else report.push('note      .claude/settings.json already has a statusLine; kept it');
  await writeJson(path, before, after);
}

const { ensureServer } = await import(join(skill, 'runtime', 'ensure-server.mjs'));
const server = await ensureServer(project);
console.log(report.join('\n'));
console.log(`\ncanvas server ${server.started ? 'started' : 'already running'}: ${server.url} (pid ${server.pid})`);
if (update && !server.started) {
  console.log('The running server and open Claude sessions still use the old code: run /setup-excalidraw-live-multiagent --restart, and restart the Claude sessions.');
}
console.log('Start a role with `claude --agent po` (or swe, tester, devops, security). A session that was already open must be restarted to load the MCP server.');
