---
name: setup-excalidraw-live-multiagent
description: Set up excalidraw-live (live Excalidraw boards shared by Claude sessions playing Scrum-team roles po/dev/tester/devops/security) in this project and start, stop, restart or update its canvas server. Required before the board tools work. Run by the user as /setup-excalidraw-live-multiagent [--update|--stop|--restart]; a first setup asks which role agents to install and whether to add a status line.
disable-model-invocation: true
---

# Set up excalidraw-live in this project

Nothing works until this has run once in the project: it registers the MCP server and starts the canvas server the board tools talk to.

1. Ask first, only when $ARGUMENTS is empty and `.mcp.json` has no `excalidraw-live` entry yet (a first setup). Ask with AskUserQuestion, both questions in one call, and wait for the answers:
   - "Add a status line with the open board's unread change count to `.claude/settings.json`?" Options: Yes (shown to you only, refreshed every 2 s, nothing goes into Claude's context) / No.
   - "Which role agents should go into `.claude/agents/`? They are optional: any Claude session can open a board with `as: <role>`." Options: Scrum core: po, dev, tester / All five: po, dev, tester, devops, security / None. A custom list comes back as Other.
   Turn the answers into `--statusline` and `--agents <comma list>` (`--agents none` for none). Otherwise pass $ARGUMENTS as they are and ask nothing: a project already set up only needs the server up, and `--update`, `--stop`, `--restart` never ask.
2. From the project root, run the script with those flags:
   ```sh
   node .claude/skills/setup-excalidraw-live-multiagent/scripts/setup.mjs [--agents po,dev,tester] [--statusline] [--update|--stop|--restart]
   ```
   - Always adds what is missing, then starts the server (running it again just makes sure the server is up):
     - the `excalidraw-live` entry in `.mcp.json`, pointing at the server bundled in this skill's `runtime/` by a path relative to the project root
     - the skill `excalidraw-collab` in `.claude/skills/` (an existing copy is kept)
     - `docs/diagrams/diagrams.json`, the index of the boards; the drawings live in `docs/diagrams/` and go into git
     - `.gitignore` lines for this skill's `state/` (server state, kept inside the skill) and `*.excalidraw.log.jsonl`
   - `--agents <list>`: also installs those role agents (`po`, `dev`, `tester`, `devops`, `security`) in `.claude/agents/`; existing files are kept. Without it no agent is installed.
   - `--statusline`: also adds the unread-count status line to `.claude/settings.json`, unless the project has a status line of its own. Without it the status line is only refreshed if this skill added it before. A prompt hook from an older setup is always removed.
   - `--update`: overwrites the agents already installed and the skill with this skill's current copies. `docs/diagrams/` is left alone.
   - `--stop`: only stops the server. Drawings are saved as the user goes; stop flushes the last ones and lists the files.
   - `--restart`: stops the server if one runs, then sets up and starts it again.
   Before `npx skills update` the user must run `--stop`: the update replaces this skill folder, server state included.
3. Show the user the script's report, the board URL and any note it prints.
4. If `.mcp.json` was created or updated, tell the user to exit and start `claude` again, or `claude --agent <role>` for a role agent they installed. MCP servers load when a session starts, and Claude Code asks once to approve the project's server. After `--restart` the port changes: each open session must open its board again and the user must open the new URL.

Done when the script exits 0 and the user has its output (the URL and restart note, or the saved files after `--stop`). If it reports a missing file, give the user the `npx skills add` command it printed.
