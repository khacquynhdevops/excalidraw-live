---
name: setup-excalidraw-live
description: Set up excalidraw-live (live Excalidraw boards shared by Claude sessions playing Scrum-team roles po/dev/tester/devops/security) in this project and start, stop, restart or update its canvas server. Required before the board tools work. Run by the user as /setup-excalidraw-live [--harness codex|cursor|gemini|vscode|opencode] [--update|--stop|--restart]; a first setup in Claude Code asks which role agents to install.
disable-model-invocation: true
---

# Set up excalidraw-live in this project

Nothing works until this has run once in the project: it starts the canvas server the board tools talk to and, for an `npx skills add` install, registers the MCP server (in `.mcp.json` for Claude Code, in each `--harness` config for the others). Installed as the Claude Code plugin, the plugin brings the MCP server, the skills and a band above the prompt with the open board's unread count.

1. In a harness other than Claude Code, add `--harness <its name>` (codex, cursor, gemini, vscode, opencode) unless $ARGUMENTS names one, and ask nothing: role agents are Claude Code's.
   In Claude Code, ask first, only when $ARGUMENTS is empty and `docs/diagrams/diagrams.json` does not exist yet (a first setup). Ask with AskUserQuestion and wait for the answer:
   - "Install role agents in `.claude/agents/`? Any Claude session can already open a board with `as: <role>`; a role agent adds a session that starts as that role." Options, in this order: None (Recommended) / Scrum core: po-diagram, dev-diagram, tester-diagram / Full team: all five, adding devops-diagram and security-diagram. A custom list comes back as Other.
   Turn the answer into `--agents <comma list>` (`--agents none` for None). Otherwise pass $ARGUMENTS as they are and ask nothing: a project already set up only needs the server up, and `--harness`, `--update`, `--stop`, `--restart` never ask.
2. From the project root, run the script in this skill's base directory with those flags:
   ```sh
   node <this skill's base directory>/scripts/setup.mjs [--agents po-diagram,dev-diagram,tester-diagram] [--harness codex,cursor] [--update|--stop|--restart]
   ```
   - Always adds what is missing, then starts the server (running it again just makes sure the server is up):
     - `npx skills add` install without `--harness`: the `excalidraw-live` entry in `.mcp.json`, pointing at the server bundled in this skill's `runtime/` by a path relative to the project root, and the skill `excalidraw-collab` in `.claude/skills/` (an existing copy is kept)
     - `docs/diagrams/diagrams.json`, the index of the boards; the drawings live in `docs/diagrams/` and go into git
     - `.gitignore` lines for `.claude/excalidraw-live/state/` (server state) and `*.excalidraw.log.jsonl`
   - `--agents <list>`: also installs those role agents (`po-diagram`, `dev-diagram`, `tester-diagram`, `devops-diagram`, `security-diagram`; each plays the board role named before `-diagram`) in `.claude/agents/`; existing files are kept. Without it no agent is installed. Claude Code only.
   - `--harness <list>` (comma list or repeated): registers the `excalidraw-live` MCP server in each harness's project config instead of `.mcp.json`: `codex` `.codex/config.toml` (read in trusted projects only), `cursor` `.cursor/mcp.json`, `gemini` `.gemini/settings.json`, `vscode` `.vscode/mcp.json`, `opencode` `opencode.json`; `claude` is `.mcp.json`. Other servers are kept; our entry is replaced only when it points at another path.
   - A status line or prompt hook an older setup added to `.claude/settings.json` is always removed: their scripts are gone.
   - `--update`: overwrites the agents already installed and the skill with this skill's current copies; an agent installed under its old name (`po.md`) gets the new one (`po-diagram.md`) and the script notes the old file for the user to remove. `docs/diagrams/` is left alone.
   - `--stop`: only stops the server. Drawings are saved as the user goes; stop flushes the last ones and lists the files.
   - `--restart`: stops the server if one runs, then sets up and starts it again.
   After `npx skills update` or a plugin update, run `--restart` so the server runs the new code.
3. Show the user the script's report, the board URL and any note it prints.
4. For `--harness`, tell the user to restart that harness so it loads the MCP server. If `.mcp.json` was created or updated, or the plugin was installed while this session was open, tell the user to exit and start `claude` again, or `claude --agent <role>-diagram` for a role agent they installed. MCP servers load when a session starts, and Claude Code asks once to approve the project's server. After `--restart` the port changes: each open session must open its board again and the user must open the new URL.

Done when the script exits 0 and the user has its output (the URL and restart note, or the saved files after `--stop`). If it reports a missing file, give the user the `npx skills add` command it printed.
