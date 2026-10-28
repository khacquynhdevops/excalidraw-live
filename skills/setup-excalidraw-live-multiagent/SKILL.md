---
name: setup-excalidraw-live-multiagent
description: Set up excalidraw-live (live Excalidraw boards shared by role agents po/swe/tester/devops/security) in this project and start, stop, restart or update its canvas server. Required before the board tools work. Run by the user as /setup-excalidraw-live-multiagent [--update|--stop|--restart].
disable-model-invocation: true
---

# Set up excalidraw-live in this project

Nothing works until this has run once in the project: it registers the MCP server and starts the canvas server the board tools talk to.

1. From the project root, run the script with the flag the user passed in $ARGUMENTS (none, `--update`, `--stop` or `--restart`):
   ```sh
   node .claude/skills/setup-excalidraw-live-multiagent/scripts/setup.mjs [--update|--stop|--restart]
   ```
   - No flag: adds only what is missing, then starts the server (running it again just makes sure the server is up):
     - the `excalidraw-live` entry in `.mcp.json`, pointing at the server bundled in this skill's `runtime/` by a path relative to the project root
     - the role agents in `.claude/agents/` and the skill `excalidraw-collab` in `.claude/skills/` (existing files are kept)
     - `docs/diagrams/diagrams.json`, the index of the boards; the drawings live in `docs/diagrams/` and go into git
     - `.gitignore` lines for this skill's `state/` (server state, kept inside the skill) and `*.excalidraw.log.jsonl`
     - in `.claude/settings.json`: a status line with the open board's unread count, refreshed every 2 s (shown to the user only; a prompt hook from an older setup is removed)
   - `--update`: the same, and overwrites the installed agents and skill with this skill's current copies. `docs/diagrams/` is left alone.
   - `--stop`: only stops the server. Drawings are saved as the user goes; stop flushes the last ones and lists the files.
   - `--restart`: stops the server if one runs, then sets up and starts it again.
   Before `npx skills update` the user must run `--stop`: the update replaces this skill folder, server state included.
2. Show the user the script's report, the board URL and any restart note it prints.
3. If `.mcp.json` was created or updated, tell the user to exit and start `claude --agent <role>` (`po`, `swe`, `tester`, `devops`, `security`). MCP servers load when a session starts, and Claude Code asks once to approve the project's server. After `--restart` the port changes: each open session must open its board again and the user must open the new URL.

Done when the script exits 0 and the user has its output (the URL and restart note, or the saved files after `--stop`). If it reports a missing file, give the user the `npx skills add` command it printed.
