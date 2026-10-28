#!/usr/bin/env node
// Bundle the MCP server, the canvas server and the web app into the init
// skill's runtime/, so `npx skills add` installs a skill that runs with Node
// alone: no npm install, no build, no tool folder in the user's project.
// runtime/ is committed. Run after `tsc -b` and the web build (npm run build).
import { build } from 'esbuild';
import { cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const out = root('skills/setup-excalidraw-live-multiagent/runtime');

rmSync(out, { recursive: true, force: true });
await build({
  entryPoints: {
    'mcp': root('mcp/src/index.ts'),
    'server': root('server/src/index.ts'),
    'ensure-server': root('shared/src/ensureServer.ts')
  },
  outdir: out,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // ws loads these native speed-ups when present and works without them.
  external: ['bufferutil', 'utf-8-validate'],
  // CommonJS dependencies call require() on Node built-ins.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  legalComments: 'eof',
  logLevel: 'warning'
});
cpSync(root('web/dist'), `${out}/web`, { recursive: true });
console.log(`bundled into ${out}`);
