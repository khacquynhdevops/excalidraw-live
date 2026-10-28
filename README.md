# excalidraw-live

A live Excalidraw board shared between you (in the browser) and Claude Code (through an MCP server). Diagrams are plain `.excalidraw` files in your project's `docs/diagrams/` folder, so they live in git. One person can play several roles (`po`, `swe`, `tester`, `devops`, `security`), each in its own Claude session with its own board, and the roles pass work to each other.

Credits: the sync and change-log ideas build on [yctimlin/mcp_excalidraw](https://github.com/yctimlin/mcp_excalidraw) and ldele's work (MIT).

## Requirements

- Node.js 22.12 or newer (tested on 24). Check with `node -v`.
- [Claude Code](https://claude.com/claude-code) (`claude` on your PATH).
- macOS or Linux. A browser on the same machine: the server listens on `127.0.0.1` only.

## 1. Install the skills

From the project root (an existing repo or an empty folder):

```sh
npx skills add khacquynhdevops/excalidraw-live -a claude-code --copy
```

This puts two skills in `.claude/skills/`:

- `setup-excalidraw-live-multiagent`: sets the project up and starts, stops, restarts or updates the canvas server. The MCP server, the canvas server and the web app ship inside it (`runtime/`), already built: there is nothing to `npm install`.
- `excalidraw-collab`: how Claude works on a board.

The skills CLI also writes `skills-lock.json` at the project root to track what it installed. Commit `.claude/skills/` with your project: teammates then get the same version, but note that `runtime/` adds about 10 MB.

## 2. Set up the project

Start `claude` in the project root and run `/setup-excalidraw-live-multiagent`. Nothing works until this has run: it registers the MCP server and starts the canvas server. It adds only what is missing:

- the `excalidraw-live` entry in `.mcp.json`
- the five role agents in `.claude/agents/`
- `docs/diagrams/diagrams.json`, the index of your boards (the server adds `docs/diagrams/.gitignore` for the change logs when it first writes there)
- `.gitignore` lines for `.claude/skills/setup-excalidraw-live-multiagent/state/` (server state, kept inside the skill) and `*.excalidraw.log.jsonl` (change logs)
- in `.claude/settings.json`: a status line with the open board's unread count, refreshed every 2 seconds. It is only shown to you; nothing is added to Claude's context

It then starts the canvas server and prints its URL. Running it again is safe: existing files are kept. Apart from `docs/diagrams/`, everything goes into the usual Claude Code places (`.claude/`, `.mcp.json`). The paths it writes are relative to the project root, so these files can be committed and work in any clone.

Then exit Claude. MCP servers load when a session starts. Always start `claude` from the project root: the MCP server is found relative to it.

## 3. Start a role

```sh
claude --agent po          # or swe, tester, devops, security
```

The first time, Claude Code asks you to approve the project's MCP server `excalidraw-live`: approve it. The agent lists its boards, opens one (or creates one with you), and gives you the board URL. Open the URL in the browser and draw.

What each role owns:

| Role | Typical boards |
|---|---|
| `po` | `story-map`, `journey`, `overview`, `c4-context`, business `flow`, `wireframe`, `timeline` |
| `swe` | `c4-container`, `c4-component`, `sequence`, `erd`, `state`, technical `flow` |
| `tester` | `test-map`, `state`, decision flows |
| `devops` | `pipeline`, `deployment`, rollback and runbook flows |
| `security` | `threat-model` (data flows with trust boundaries), auth sequences |

Each diagram has exactly one **owner** role, the only one that can write to it. Other roles read it and ask the owner for changes.

### Working with Claude on a board

- Claude reads the board only when you ask ("xem board đi", "what changed?"). The status line shows how many changes it has not read yet.
- When you tell Claude what to draw ("connect A and B", "add a cache", "rename X"), it draws on the board directly, in blue.
- When Claude proposes something on its own (options, a suggested structure), it puts it in a blue **Claude proposal** frame placed in free space, so it never covers your shapes. Say "accept" (or "accept only X", or "keep it blue") and Claude calls `accept_proposal`: the elements leave the frame and turn green, and an empty frame is removed.
- Elements you are editing, have selected, or changed in the last 5 seconds are never overwritten; Claude reads again or asks.
- One board per session at a time. Before moving to another board, Claude asks "Chuyển sang board `<name>` (`<id>`)?" and waits for your yes; when names are similar it lists the ids for you to pick.

## 4. Several roles at once

Open one terminal per role, each with `claude --agent <role>` in the same project. Each role has its own board and its own read position.

- **Messages between running sessions**: a role uses SendMessage to another running session. You can also mention one in your prompt, e.g. "ask @swe whether checkout needs login", and your session sends it.
- **References**: `make_ref` gives `dl://<diagram>@<rev>#<element>` for agents and an http URL for you. A role opens a ref from another role with `read_diagram`, so messages point at exact shapes.
- **When the other role is not running**: `ask {ref, toRole, text}` leaves the question in `docs/diagrams/questions.jsonl`. That role sees it the next time it opens a board and replies with `answer`; the asker sees the answer the next time it opens one.
- **Across boards**: `trace` follows one element across boards that refine each other; `check_consistency` lists labels that drifted and parent shapes no child board details yet. Each owner decides what changes on its own board.

## 5. Stop, restart and update

| Command (in any `claude` session in the project) | What it does |
|---|---|
| `/setup-excalidraw-live-multiagent --stop` | Stops the server. Drawings are saved to `docs/diagrams/` as you go; stop flushes the last ones. |
| `/setup-excalidraw-live-multiagent --restart` | Stops the server if one runs and starts it again. |
| `/setup-excalidraw-live-multiagent` | Starts the server if it is not running (`claude --agent <role>` also starts it when needed). |

To update to a new version:

1. `/setup-excalidraw-live-multiagent --stop`: the update replaces the skill folder, server state included.
2. `npx skills update` (or run the `npx skills add` command from step 1 again).
3. `/setup-excalidraw-live-multiagent --update`: overwrites the installed agents and skills with the new copies; `docs/diagrams/` is left alone.
4. `/setup-excalidraw-live-multiagent --restart`, and restart every Claude session in the project.

## Develop

The source is an npm workspace: `shared`, `server`, `mcp`, `web`. `npm run build` compiles it and bundles it with esbuild into `skills/setup-excalidraw-live-multiagent/runtime/`, which is committed so the skill installs without a build. Rebuild and commit `runtime/` with any source change.

```sh
npm install
npm run build
npm test
```

## Known limits

- `claude` must be started from the project root. Started from a subfolder, the `excalidraw-live` MCP server fails to connect.
- Text inside a shape takes the shape's colour; it cannot be coloured on its own. For a differently coloured caption, use a separate text element and group it with the shape.
- The server picks a free port each time it starts. After a restart, each session must open its board again (`open_diagram`) and you must open the new URL in the browser.
- The server listens on `127.0.0.1` without authentication: it is for one person on one machine.
- Images are stored inline in the `.excalidraw` file, up to 2 MB each.
- Change logs (`<diagram>.excalidraw.log.jsonl`) are git-ignored and capped at about 2 MB; reports older than that cannot be replayed.

## License

MIT, see [LICENSE](LICENSE).
