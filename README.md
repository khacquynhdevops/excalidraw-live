# excalidraw-live

A live Excalidraw board shared between you (in the browser) and Claude Code (through an MCP server). Diagrams are plain `.excalidraw` files in `docs/diagrams/`, so they live in git. Each Claude session can play a Scrum-team role (`po`, `dev`, `tester`, `devops`, `security`) with its own boards, and the roles pass work to each other.

Credits: the sync and change-log ideas build on [yctimlin/mcp_excalidraw](https://github.com/yctimlin/mcp_excalidraw) and ldele's work (MIT).

## Requirements

- Node.js 22.12 or newer
- [Claude Code](https://claude.com/claude-code)
- macOS or Linux, with a browser on the same machine

## Install

From the project root:

```sh
npx skills add khacquynhdevops/excalidraw-live -a claude-code --copy
```

Then start `claude` and run `/setup-excalidraw-live-multiagent`. The first time, it asks whether to add an unread-count status line and which role agents to install (Scrum core `po-diagram`, `dev-diagram`, `tester-diagram`; all five; or none). Each agent draws the diagrams of one role and opens boards as that role (`po-diagram` as `po`). It registers the MCP server in `.mcp.json`, creates `docs/diagrams/`, adds two `.gitignore` lines and starts the canvas server. Your existing files are kept.

Exit Claude, then start a role from the project root:

```sh
claude --agent po-diagram  # or any role agent you installed; plain `claude` works too
```

Approve the `excalidraw-live` MCP server when asked, and open the board URL the agent gives you.

## Roles

| Role | Typical boards |
|---|---|
| `po` | `story-map`, `journey`, `overview`, `c4-context`, business `flow`, `wireframe`, `timeline` |
| `dev` | `c4-container`, `c4-component`, `sequence`, `erd`, `state`, technical `flow` |
| `tester` | `test-map`, `state`, decision flows |
| `devops` | `pipeline`, `deployment`, `network`, `health-model` |
| `security` | `threat-model`, auth sequences |

Every role can read every board. Before editing a board another role owns, the agent warns you ("this board is not yours, are you sure?") and writes only if you say yes. Roles share exact shapes as `dl://` refs, and `ask` leaves a question for a role that is not running.

Turn on the status line during setup and always check it before asking for a change: it shows which board and role the session is on, so you do not edit the wrong one. `✏️ Shop · po` is your own board, `👀 Shop (po's) · dev read-only` is another role's board you can only read, and `⚠️ Shop (po's) · dev editing` means you are editing another role's board.

## Commands

| `/setup-excalidraw-live-multiagent …` | What it does |
|---|---|
| (no flag) | Set up, or start the server if it is not running |
| `--agents devops-diagram,security-diagram` | Install more role agents |
| `--stop` / `--restart` | Stop or restart the server |
| `--update` | After `npx skills update`, refresh the installed agents and skills |

To update: `--stop`, `npx skills update`, `--update`, `--restart`, then restart your Claude sessions.

## Develop

```sh
npm install
npm run build   # bundles into skills/setup-excalidraw-live-multiagent/runtime/ (committed)
npm test
```

## Known limits

- Start `claude` from the project root, or the MCP server fails to connect.
- The server listens on `127.0.0.1` without authentication: one person, one machine.
- The port changes on each restart: reopen the board and the new URL.

## License

MIT, see [LICENSE](LICENSE).
