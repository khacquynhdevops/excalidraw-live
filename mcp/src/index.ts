#!/usr/bin/env node
// stdio entry for Claude Code: bundled as runtime/mcp.mjs in the init skill, which writes it into .mcp.json.
// PROJECT_DIR defaults to the working directory; DIAGRAM_ID and DIAGRAM_AS
// bind the session up front instead of waiting for open_diagram.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBoardServer } from './tools.js';

const board = createBoardServer({
  projectDir: process.env.PROJECT_DIR || process.cwd(),
  sessionId: `mcp-${process.pid}`,
  claudePid: process.ppid,
  diagramId: process.env.DIAGRAM_ID || undefined,
  as: process.env.DIAGRAM_AS || undefined
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await board.close().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.stdin.on('end', shutdown);

await board.server.connect(new StdioServerTransport());
