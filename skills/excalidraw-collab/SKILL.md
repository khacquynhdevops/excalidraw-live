---
name: excalidraw-collab
description: Draw and think together with the user on a live Excalidraw board (excalidraw-live MCP tools). Use when the user mentions the board, a diagram or sketch, asks you to draw or change something on it, asks what they drew, or refers to another role's diagram (a dl:// ref or /d/<id> link).
---

# Drawing with the user on excalidraw-live

The board is a shared whiteboard the user draws on in the browser while you work through the `excalidraw-live` MCP tools. The `.excalidraw` files in `docs/diagrams/` are the source of truth and live in git. Each session is bound to one diagram as one role (`po`, `dev`, `tester`, `devops`, `security`). The diagram's owner role holds the **writer lease**; every other role reads, and writes only after the user confirms editing a board that is not theirs.

## Token rule: pull, don't poll

Read the board only when the user's request is about it.

- The user sees the unread count in the status line; you do not. When they say they changed the board or ask about it, call `get_changes_since`.
- Use `wait_for_changes` only when the user asks you to watch the board ("watch while I draw", "tell me when I am done"). After a `timeout`, ask the user whether to keep watching. Never loop on your own.
- `get_changes_since` without `since` marks the changes read. Use it once per question, not as a probe.

## 1. Start a session

1. `list_diagrams {audience?: <your role>}`.
2. Pick the diagram with the user, or `create_diagram {name, kind}` when nothing fits. Pick the `kind` from what the user is describing; use `free` only when no kind fits.
3. `open_diagram {id, as: <your role>}`. Give the user the URL it returns. Note the mode (writer or read-only) and the `rev`. To change another role's board, warn the user first ("This board belongs to <owner>, not <you>. Are you sure you want to edit it?") and only on yes call `open_diagram {id, as, edit: true}`.
4. If `open_diagram` lists unanswered questions for your role, raise them with the user before anything else.

Done when the user has the URL and you know your mode.

### Switching boards

A session works on one board at a time. When the conversation turns to another board, ask first, in the user's language, and wait for a yes:

> Switch to board `<name>` (`<id>`)?

- Call `open_diagram` for the new board, and draw or change anything on it, only after the user confirms.
- If several boards have the same or a similar name, list them with their ids and let the user pick.
- Reading another board with `read_diagram` needs no switch.

## 2. Understand what the user drew

1. `get_changes_since` (or `get_scene_summary` for the whole board, `{frameId}` for one frame).
2. **Mirror** it back in the user's language: "A calls B through C, and D stores the result". State your assumptions and ask 1–3 sharp questions. Talk business with `po`, technical with `dev`, risk with `security`.
3. Use element ids (`[abc]`) only when you are going to act on them. Use labels when you talk to the user.

## 3. Propose on the canvas

Everything you draw is blue (`customData.origin='agent'`). Where it lands depends on who asked for it:

- **A command** from the user ("connect A to B", "add X", "change Y"): draw it on the board directly with `frameId: null`. The user asked for exactly this, so it is not a proposal.
- **Your own proposal** (options, a suggested structure, something the user did not ask for by name): leave `frameId` out. It goes into the "Claude proposal" frame, which the server places in free space; arrows that reach the user's shapes stay outside the frame.

- `apply_changes {diagramId, ops}`. Always pass the id of the board you mean; the call is refused if another board is open. The result starts with `on "<name>" (<id>)`: check it is the board the user expects. Lay the elements out with real coordinates so they don't overlap: read the summary for free space first.
- Change or delete the user's own elements only after they agree in the conversation. Pass `expectedVersion` from your last read when you do.
- `conflicts` come back for elements the user is editing, has selected, changed in the last 5s, or that changed since you read them. Nothing else in that op was applied. Read again, then retry once or ask the user. Never force through.
- Connect with arrows: `{op:'create', type:'arrow', start:<id>, end:<id>, label?}`. Put text inside shapes with `label`. Font, size and colour given on a shape or arrow (`fontFamily`, `fontSize`, `strokeColor`) also style its label, on create and on update.
- When the user accepts a proposal, call `accept_proposal {diagramId, frameId}`, with `elementIds` for the part they accepted. The elements leave the frame and turn green; pass `keepColor: true` if the user wants them to stay blue. An empty frame is deleted. Record decisions in a frame named "Decisions" (a text per decision).

Element fields and op examples: [references/elements.md](references/elements.md).

## 4. Cross-role work

Diagrams refine each other: `story-map` → `journey`/`overview` → `c4-context` → `c4-container`/`sequence`/`erd` → `test-map`, `threat-model`, `pipeline`/`deployment`.

- Read another role's board with `read_diagram {id | ref}` and `trace {id, elementId}`. Translate what you read into your user's language. Point out where the two boards disagree.
- You write only on your own board. To change someone else's diagram, ask that role.
- When you create a diagram that details an element of another board, pass `refines: '<diagramId>#<elementId>'` so `trace` and `check_consistency` can follow it.
- **Refs**: `make_ref {elementId?}` gives `dl://<id>@<rev>#<element>` for agents and an http URL for people. The receiver opens it with `read_diagram {ref}`.
- **Asking another role**:
  - If their session is running (`ListAgents` shows it), SendMessage the question plus a ref. Answer with a description plus a ref to your own board.
  - Otherwise, `ask {ref, toRole, text}`. It waits in `docs/diagrams/questions.jsonl` until that role opens a diagram. Answer questions addressed to you with `answer {questionId, text, ref?}`.
- `check_consistency` lists parent elements no child diagram details yet and labels that drifted between boards. Report the findings to the user, who decides which board changes.

## Conventions

`open_diagram` and `create_diagram` return how to draw the board's kind (shapes and layout). Follow it; a `free` board has none.

Colours: blue `#1971c2` is Claude's proposal, red `#e03131` marks a risk or problem, green `#2f9e44` marks something done or agreed. Leave the user's own colours as they are.

## When it goes wrong

- `read-only` error: the board belongs to another role. Ask the owner (section 4), or warn the user and, if they confirm, reopen with `edit: true`. If the owner role's own session holds the lease, wait or ask it.
- `no browser has … open`: give the user the URL again.
- `unknown diagram`: call `list_diagrams`; ids are stable but names change.
