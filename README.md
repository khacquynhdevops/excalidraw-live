# excalidraw-live

A live Excalidraw board shared between you (in the browser) and Claude Code (through an MCP server). Diagrams are plain `.excalidraw` files in `docs/diagrams/`, so they live in git. Each Claude session can play a Scrum-team role (`po`, `dev`, `tester`, `devops`, `security`) with its own boards, and the roles pass work to each other.

Credits: the sync and change-log ideas build on [yctimlin/mcp_excalidraw](https://github.com/yctimlin/mcp_excalidraw) and ldele's work (MIT).

## Requirements

- Node.js 22.12 or newer
- [Claude Code](https://claude.com/claude-code), or another harness that runs MCP servers (Codex, Cursor, Gemini CLI, VS Code Copilot, opencode)
- macOS or Linux, with a browser on the same machine

## Install

Pick one path:

- **Claude Code plugin** (recommended): MCP server, skills, and the band above the prompt.
- **Other harnesses** (Codex, Cursor, Gemini CLI, VS Code Copilot, opencode), or Claude Code without the plugin: MCP server and skills, no band.

Either way, the setup step runs **once per project**. Nothing works until it has run: it starts the canvas server the board tools talk to.

### Claude Code plugin

**1. Add the marketplace** (once per machine):

```sh
claude plugin marketplace add khacquynhdevops/excalidraw-live
```

**2. Install the plugin in your project.** From the project root, run **one** of these:

| Who should get it | Command |
|---|---|
| Only you, in this project | `claude plugin install excalidraw-live@excalidraw-live -s local` |
| Everyone who clones the project (written to `.claude/settings.json`, commit it) | `claude plugin install excalidraw-live@excalidraw-live -s project` |

Not sure? Use `-s local`. The plugin is on only in the projects you install it in.

**3. Run setup** (once per project). Start `claude` in the project root and type:

```text
/excalidraw-live:setup-excalidraw-live
```

It creates `docs/diagrams/`, adds `.excalidraw-live/` (server state and change logs) to `.gitignore` and starts the canvas server. Your existing files are kept. The first time, it asks whether to install role agents:

- none (the default): use plain `claude`;
- Scrum core: `po-diagram`, `dev-diagram`, `tester-diagram`;
- full team: those three plus `devops-diagram`, `security-diagram`.

Each role agent draws one role's diagrams and opens boards as that role (`po-diagram` as `po`).

**4. Restart Claude and start drawing.** Exit Claude so it loads the new agents, then from the project root:

```sh
claude --agent po-diagram   # any role agent you installed, or plain `claude`
```

Ask for a diagram. Open the board URL the agent gives you, or press **Open** on the band.

To update later: `/plugin update`, then restart Claude.

### Other agent harnesses

**1. Add the skills** from the project root:

```sh
npx skills add khacquynhdevops/excalidraw-live
```

**2. Run setup** (once per project), with the path `npx` printed and your harness:

```sh
node .agents/skills/setup-excalidraw-live/scripts/setup.mjs --harness codex
```

`--harness` takes `codex`, `cursor`, `gemini`, `vscode` (Copilot) or `opencode`, as a comma list or repeated. It writes the `excalidraw-live` MCP server into that harness's project config and keeps the other servers there:

| Harness | File |
|---|---|
| `codex` | `.codex/config.toml` (Codex reads it in trusted projects only) |
| `cursor` | `.cursor/mcp.json` |
| `gemini` | `.gemini/settings.json` |
| `vscode` | `.vscode/mcp.json` |
| `opencode` | `opencode.json` |

**3. Restart the harness** so it loads the server.

**Claude Code without the plugin:** after step 1, start `claude` and run `/setup-excalidraw-live` instead of step 2. It registers the server in `.mcp.json` and copies the `excalidraw-collab` skill into `.claude/skills/`. Approve the `excalidraw-live` MCP server when Claude asks. Role agents (`--agents`) are for Claude Code only.

**Any other MCP client:** register a stdio server that runs, from the project root,

```sh
node <skills folder>/setup-excalidraw-live/runtime/mcp.mjs
```

If the client cannot set the working directory, set `PROJECT_DIR` to the project root instead. Run `setup.mjs` once without `--harness` to create `docs/diagrams/` and start the canvas server (it also writes `.mcp.json`, which other clients ignore).

## Roles

| Role | Typical boards |
|---|---|
| `po` | `story-map`, `journey`, `overview`, `c4-context`, business `flow`, `wireframe`, `timeline` |
| `dev` | `c4-container`, `c4-component`, `sequence`, `erd`, `state`, technical `flow` |
| `tester` | `test-map`, `state`, decision flows |
| `devops` | `pipeline`, `deployment`, `network`, `health-model` |
| `security` | `threat-model`, auth sequences |

Every role can read every board. Before editing a board another role owns, the agent warns you ("this board is not yours, are you sure?") and writes only if you say yes. Roles share exact shapes as `dl://` refs, and `ask` leaves a question for a role that is not running.

With the plugin, check the band above the prompt before asking for a change: it shows which board and role the session is on and how many changes it has not read, so you do not edit the wrong one. `✏️ Shop · po` is your own board, `👀 Shop (po's) · dev read-only` is another role's board you can only read, and `⚠️ Shop (po's) · dev editing` means you are editing another role's board. Hide takes the band down; `/excalidraw-band` brings it back.

## Commands

| `/excalidraw-live:setup-excalidraw-live …` | What it does |
|---|---|
| (no flag) | Set up, or start the server if it is not running |
| `--agents devops-diagram,security-diagram` | Install more role agents |
| `--stop` / `--restart` | Stop or restart the server |
| `--update` | After an update, refresh the installed agents (and, without the plugin, the skills) |

To update: `claude plugin update excalidraw-live@excalidraw-live` (or `npx skills update`), then `--update`, `--restart`, and restart your Claude sessions.

## Develop

```sh
npm install
npm run build   # bundles into skills/setup-excalidraw-live/runtime/ (committed)
npm test
```

## Known limits

- Start `claude` from the project root, or the MCP server fails to connect.
- The server listens on `127.0.0.1` without authentication: one person, one machine.
- The port changes on each restart: reopen the board and the new URL.

## License

MIT, see [LICENSE](LICENSE).
