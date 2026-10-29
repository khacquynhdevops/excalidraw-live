# Drawing feedback

The model already knows how to draw each notation well, and gets better with every release. Feedback on a drawing makes the skill lighter, not heavier: name the notation, show the model its mistakes, and leave the drawing to it.

When a user reports something wrong on a board (in an issue or in the conversation), place the fix at the first place it fits:

1. **A tool bug** (a label left behind, an id refused): fix the server.
2. **Something code can see** (overlap, overflow, an arrow crossing a box): add a check to `layoutIssues` in `shared/src/layout.ts`. The model reads the report and fixes the board itself.
3. **A mistake in meaning for one kind**: add one line to that kind's `avoid` in `mcp/src/conventions.ts`, saying the mistake and why it hurts the reader, with a dated comment naming the feedback. Pixel sizes and step-by-step recipes belong to none of these.
4. **A mistake on every kind**: one line in the Conventions section of `skills/excalidraw-collab/SKILL.md`.

After a code change, `npm run build` (the runtime bundle is committed) and `npm test`.

Prune: when a newer model stops making a mistake, delete its line. An `avoid` list longer than three lines is a sign some of it is stale.
