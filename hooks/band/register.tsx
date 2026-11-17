// The band above the prompt: the board this session opened, its role and
// mode, and how many changes the role has not read yet. It follows
// open_diagram calls and asks the project's canvas server every 2 s.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board } from './types'

const board = atom({ plugin: 'excalidraw-live', key: 'board' } as const, null)
const isHidden = atom({ plugin: 'excalidraw-live', key: 'isHidden' } as const, false)

// The MCP server is `excalidraw-live` in a project's .mcp.json (the npx
// install) and `plugin_excalidraw-live_excalidraw-live` from this plugin.
const OPEN = /^mcp__(?:plugin_excalidraw-live_)?excalidraw-live__open_diagram$/
// Where the canvas server records its port (shared/src/ensureServer.ts).
const SERVER_JSON = '.claude/excalidraw-live/state/server.json'

// Refreshes the open board's name, owner and unread count. A board the
// server no longer knows (deleted) is dropped; without a server, port is 0.
async function poll($: EngineInterface) {
  const b = await read($, board)
  if (!b) return
  const root = await $.session.root()
  const port = await $.fs.read(`${root}/${SERVER_JSON}`).then((t) => Number(JSON.parse(t).port) || 0, () => 0)
  const res = port
    ? await $.http.fetch(`http://127.0.0.1:${port}/api/diagrams/${encodeURIComponent(b.id)}/status?as=${encodeURIComponent(b.as)}`).catch(() => undefined)
    : undefined
  const s = res?.ok ? (JSON.parse(res.text) as { name: string; owner: string; unread: number }) : undefined
  await update($, board, (x) => {
    if (x?.id !== b.id || x.as !== b.as) return x
    if (res?.status === 404) return null
    return s ? { ...x, port, name: s.name, owner: s.owner, unread: s.unread } : { ...x, port: 0 }
  })
}

async function openUrl($: EngineInterface, url: string) {
  const windows = (await $.env.get('OS')) === 'Windows_NT'
  const mac = !windows && (await $.process.run(['uname'])).stdout.trim() === 'Darwin'
  await $.process.run(windows ? ['cmd', '/c', 'start', '', url] : [mac ? 'open' : 'xdg-open', url])
}

export function line(b: Board): string {
  const mine = !b.owner || b.as === b.owner
  const writer = b.mode === 'writer'
  const icon = !writer ? '👀' : mine ? '✏️' : '⚠️'
  const doing = !writer ? ' read-only' : mine ? '' : ' editing'
  const count = b.port ? `${b.unread} unread` : 'canvas server not running'
  return `${icon} ${b.name}${mine ? '' : ` (${b.owner}'s)`} · ${b.as}${doing}: ${count}`
}

export const register: Register = (on) => {
  let timer: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    timer?.cancel()
    timer = $.clock.every(2000, () => void poll($).catch(() => {}))
    await $.command.register({ name: 'excalidraw-band', description: 'Show or hide the excalidraw-live band' })
    return next(e)
  }).catch(($, e, next) => next(e))

  // Hide has no button to undo it: the band is gone, so a command brings it back.
  on('command.run', { command: 'excalidraw-band' }, async ($) => {
    const hidden = await update($, isHidden, (h) => !h)
    return { text: hidden ? 'Band hidden.' : 'Band shown.' }
  })

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (!OPEN.test(e.tool) || 'deny' in r && r.deny !== undefined || r.isError) return r
    const { id, as } = e as unknown as { id: string; as: string }
    // The first line of the result: `opened <id> "<name>" as <as> (writer…|read-only…)`.
    const mode = / \(writer/.test(r.text ?? '') ? 'writer' : 'reader'
    await update($, board, () => ({ id, as, mode, name: id, owner: '', unread: 0, port: 0 }))
    await update($, isHidden, () => false)
    await poll($).catch(() => {})
    return r
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const b = await read($, board)
    if (e.props.hasSurvey || !b || (await read($, isHidden))) return next(e)
    // Other mods share this slot: theirs goes below ours. next(e) rejects
    // only when nothing answers beneath (a test).
    const below = await next(e).catch(() => undefined)
    const { Box, Text, Button } = $.ui.resolve(e)
    const url = `http://127.0.0.1:${b.port}/d/${encodeURIComponent(b.id)}`
    const mine = (
      <Box>
        <Box flexGrow={1}>
          <Text wrap="truncate">{line(b)}</Text>
        </Box>
        {b.port ? <Button key="open" label="Open" onPress={() => openUrl($, url)} /> : null}
        <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
    return below ? (
      <Box flexDirection="column">
        {mine}
        {below}
      </Box>
    ) : (
      mine
    )
  })
}
