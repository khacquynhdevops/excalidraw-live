import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'excalidraw-live',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const

const OPEN = 'mcp__plugin_excalidraw-live_excalidraw-live__open_diagram'

type Stubs = { status?: number; body?: object; mode?: string }

// Stands for the engine and the canvas server: server.json gives the port,
// the status endpoint answers for the board, open_diagram answers with the
// result's first line.
function stub(on: On, s: Stubs = {}) {
  const body = s.body ?? { unread: 3, fromRev: 1, toRev: 4, name: 'Checkout flow', owner: 'po' }
  on('session.root', () => ({ value: '/p' }))
  on('fs.read', () => ({ value: JSON.stringify({ port: 4321 }) }))
  on('http.fetch', () => ({
    value: { status: s.status ?? 200, ok: (s.status ?? 200) < 300, headers: {}, text: JSON.stringify(body) },
  }))
  on('tool.call', (_, e) => ({
    result: {},
    text: `opened d1 "Checkout flow" as ${(e as { as?: string }).as} (${s.mode ?? 'writer'}) · rev 4 · http://127.0.0.1:4321/d/d1`,
  }))
}

test('nothing shows before a board is opened', async ($, on) => {
  stub(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /unread/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('the owner sees their board and its unread count, on every surface', async ($, on) => {
  stub(on)
  await $.tool.call({ tool: OPEN, id: 'd1', as: 'po' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /unread/ }))?.text).toBe('✏️ Checkout flow · po: 3 unread')
    expect(await ui.find({ key: 'open' })).toBeDefined()
    await ui.unmount()
  }
})

test("another role reading sees whose board it is", async ($, on) => {
  stub(on, { mode: "read-only: po holds the writer lease" })
  await $.tool.call({ tool: 'mcp__excalidraw-live__open_diagram', id: 'd1', as: 'dev' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /unread/ }))?.text).toBe("👀 Checkout flow (po's) · dev read-only: 3 unread")
  await ui.unmount()
})

test('another mod in the slot stays below the band', async ($, on) => {
  stub(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.tool.call({ tool: OPEN, id: 'd1', as: 'po' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /unread/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('Hide takes the band down', async ($, on) => {
  stub(on)
  await $.tool.call({ tool: OPEN, id: 'd1', as: 'po' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'hide' })
  expect(await ui.find({ type: 'Text', text: /unread/ })).toBeUndefined()
  await ui.unmount()
})

test('a board the server no longer has is dropped', async ($, on) => {
  stub(on, { status: 404, body: { error: 'not found' } })
  await $.tool.call({ tool: OPEN, id: 'd1', as: 'po' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /unread/ })).toBeUndefined()
  await ui.unmount()
})

test('other tools leave the band alone', async ($, on) => {
  stub(on)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /unread/ })).toBeUndefined()
  await ui.unmount()
})
