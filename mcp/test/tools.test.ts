import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { DiagramEntry, SceneEl } from '@excalidraw-live/shared';
import { findServer } from '@excalidraw-live/shared/ensureServer';
import { createBoardServer, type BoardServerOptions } from '../src/tools.js';

const serverEntry = fileURLToPath(new URL('../../skills/setup-excalidraw-live-multiagent/runtime/server.mjs', import.meta.url));

function el(id: string, over: Partial<SceneEl> = {}): SceneEl {
  return { id, type: 'rectangle', x: 0, y: 0, width: 100, height: 50, version: 1, versionNonce: 1, isDeleted: false, updated: Date.now(), ...over };
}
const labelled = (id: string, text: string, over: Partial<SceneEl> = {}): SceneEl[] => [
  el(id, { boundElements: [{ id: `${id}-t`, type: 'text' }], ...over }),
  el(`${id}-t`, { type: 'text', text, originalText: text, containerId: id })
];

// A project as `git clone` leaves it: diagrams on disk, no server running.
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'xl-mcp-'));
  const diagrams = join(dir, 'docs', 'diagrams');
  mkdirSync(diagrams, { recursive: true });
  const index: DiagramEntry[] = [
    { id: 'd_over', name: 'Overview', file: 'overview.excalidraw', kind: 'overview', owner: 'po', audience: ['dev'] },
    { id: 'd_seq', name: 'Checkout sequence', file: 'checkout.excalidraw', kind: 'sequence', owner: 'dev', audience: [], refines: 'd_over#checkout' }
  ];
  writeFileSync(join(diagrams, 'diagrams.json'), JSON.stringify(index));
  const scene = (elements: SceneEl[]) => JSON.stringify({ type: 'excalidraw', version: 2, elements, appState: {}, files: {} });
  writeFileSync(join(diagrams, 'overview.excalidraw'), scene(labelled('checkout', 'Checkout', { link: '/d/d_seq#pay' })));
  writeFileSync(join(diagrams, 'overview.excalidraw.log.jsonl'), '{"rev":4}\n');
  writeFileSync(join(diagrams, 'checkout.excalidraw'), scene(labelled('pay', 'Pay')));
  return dir;
}

async function connect(opts: BoardServerOptions) {
  const board = createBoardServer({ serverEntry, ...opts });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([board.server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[]).map((c) => c.text).join('\n');
    return { text, isError: !!r.isError };
  };
  return { board, client, call };
}

describe('reading without a server', () => {
  let dir: string;
  let call: Awaited<ReturnType<typeof connect>>['call'];
  beforeAll(async () => {
    dir = project();
    ({ call } = await connect({ projectDir: dir, sessionId: 'mcp-test-a', claudePid: 1 }));
  });

  it('lists diagrams with their revision, filtered by kind or audience', async () => {
    const all = (await call('list_diagrams')).text.split('\n');
    expect(all).toHaveLength(2);
    expect(all[0]).toMatch(/^d_over "Overview" \(overview\) owner po, audience dev · rev 4 · updated /);
    expect(all[1]).toMatch(/^d_seq "Checkout sequence" \(sequence\) owner dev · refines d_over#checkout · rev 0/);
    // A role sees the boards it owns and the ones it reads.
    expect((await call('list_diagrams', { audience: 'dev' })).text.split('\n').map((l) => l.split(' ')[0])).toEqual(['d_over', 'd_seq']);
    expect((await call('list_diagrams', { audience: 'po' })).text).toMatch(/^d_over[^\n]*$/);
    expect((await call('list_diagrams', { kind: 'erd' })).text).toBe('no diagrams');
  });

  it('reads a diagram by id, dl:// ref or browser URL', async () => {
    const byId = (await call('read_diagram', { id: 'd_over' })).text;
    expect(byId.split('\n')[0]).toBe('board "Overview" (overview) · rev 4 · 1 shape');
    expect(byId).toContain('rectangle "Checkout" [checkout] @(0,0) 100x50 → /d/d_seq#pay');
    expect((await call('read_diagram', { ref: 'dl://d_seq@3#pay' })).text).toMatch(/^board "Checkout sequence"/);
    expect((await call('read_diagram', { ref: 'http://127.0.0.1:9/d/d_seq' })).text).toMatch(/^board "Checkout sequence"/);
    expect(await call('read_diagram', { id: 'd_nope' })).toMatchObject({ isError: true, text: 'unknown diagram: d_nope' });
    expect(await call('read_diagram')).toMatchObject({ isError: true, text: expect.stringMatching(/open_diagram/) });
  });

  it('traces an element to the diagrams that detail it, and back', async () => {
    expect((await call('trace', { id: 'd_over', elementId: 'checkout' })).text.split('\n')).toEqual([
      '"Checkout" [checkout] on d_over "Overview"',
      'links to: d_seq "Checkout sequence" → "Pay" [pay]',
      'detailed by: d_seq "Checkout sequence" (sequence)'
    ]);
    expect((await call('trace', { id: 'd_seq', elementId: 'pay' })).text.split('\n')).toEqual([
      '"Pay" [pay] on d_seq "Checkout sequence"',
      'this diagram refines: d_over "Overview" → "Checkout" [checkout]',
      'linked from: d_over "Overview" "Checkout" [checkout]'
    ]);
  });

  it('checks consistency across boards from the files', async () => {
    // d_over "Checkout" links to d_seq#pay "Pay" and d_seq refines it: consistent.
    expect((await call('check_consistency')).text).toBe('consistent: 2 diagrams checked');
    writeFileSync(join(dir, 'docs', 'diagrams', 'checkout.excalidraw'), JSON.stringify({ type: 'excalidraw', version: 2, elements: labelled('pay', 'Checkouts'), appState: {}, files: {} }));
    expect((await call('check_consistency', { ids: ['d_seq'] })).text.split('\n')).toEqual([
      'drift: d_over "Checkout" [checkout] links to d_seq "Checkouts" [pay]',
      'drift: d_seq refines d_over "Checkout" [checkout] but names it "Checkouts" [pay]'
    ]);
  });

  it('did not start a server for any of that', async () => {
    expect(await findServer(dir)).toBeNull();
  });

  it('needs a bound diagram for summaries and changes', async () => {
    expect(await call('get_changes_since')).toMatchObject({ isError: true, text: expect.stringMatching(/open_diagram/) });
  });
});

describe('a bound session', () => {
  let dir: string;
  let po: Awaited<ReturnType<typeof connect>>;
  let dev: Awaited<ReturnType<typeof connect>>;
  let url: string;

  beforeAll(async () => {
    dir = project();
    po = await connect({ projectDir: dir, sessionId: 'mcp-test-po', claudePid: 111 });
    dev = await connect({ projectDir: dir, sessionId: 'mcp-test-dev', claudePid: 222 });
  }, 30_000);
  afterAll(async () => {
    const s = await findServer(dir);
    if (s) process.kill(s.pid, 'SIGTERM');
  });

  const status = async (as: string) => (await fetch(`${url}/api/diagrams/d_over/status?as=${as}`)).json();

  it('opens as writer for the owner role and starts the server', async () => {
    const r = await po.call('open_diagram', { id: 'd_over', as: 'po' });
    expect(r.isError).toBe(false);
    const lines = r.text.split('\n');
    expect(lines[0]).toMatch(/^opened d_over "Overview" as po \(writer\) · rev 4 · http:\/\/127\.0\.0\.1:\d+\/d\/d_over$/);
    expect(lines[1]).toBe('board "Overview" (overview) · rev 4 · 1 shape');
    // The board's kind brings its drawing rules; `free` brings none.
    expect(r.text).toContain('overview conventions: impact map:');
    expect((await po.call('read_diagram')).text).toMatch(/^board "Overview"/);
    url = (await findServer(dir))!.url;
    expect(JSON.parse(readFileSync(join(dir, '.claude', 'skills', 'setup-excalidraw-live-multiagent', 'state', 'sessions', '111.json'), 'utf8')))
      .toEqual({ diagramId: 'd_over', as: 'po', mode: 'writer', session: 'mcp-test-po' });
  });

  it('opens read-only for any other role', async () => {
    expect((await dev.call('open_diagram', { id: 'd_over', as: 'dev' })).text)
      .toMatch(/^opened d_over "Overview" as dev \(read-only: owner is po\. To change it, first ask the user .* call open_diagram \{id, as, edit: true\}\)/);
    // Confirmed, but the owner's session still holds the lease.
    expect((await dev.call('open_diagram', { id: 'd_over', as: 'dev', edit: true })).text)
      .toMatch(/^opened d_over "Overview" as dev \(read-only: mcp-test-po holds the writer lease\)/);
    await dev.call('open_diagram', { id: 'd_over', as: 'dev' });
  });

  it('counts three drawings as unread, and clears them once read', async () => {
    const ws = new WebSocket(`${url.replace('http', 'ws')}/ws/d_over`);
    await new Promise((r) => ws.on('open', r));
    const draw = (els: SceneEl[]) => ws.send(JSON.stringify({ t: 'client_patch', clientId: 'tab', baseRev: 0, elements: els }));
    draw([el('a', { x: 200 })]);
    draw([el('b', { x: 400 })]);
    draw([el('a', { x: 260, version: 2 })]);
    await new Promise((r) => setTimeout(r, 200));
    ws.close();

    expect(await status('po')).toEqual({ unread: 2, fromRev: 4, toRev: 7, name: 'Overview', owner: 'po' });
    const read = await po.call('get_changes_since');
    expect(read.text.split('\n')[0]).toBe('rev 4→7: 2 elements changed (human 2)');
    expect(await status('po')).toMatchObject({ unread: 0, fromRev: 7, toRev: 7 });
    // The other role has its own read position.
    expect((await status('dev')).unread).toBe(2);
  });

  it('summarizes the bound board, or one frame of it', async () => {
    expect((await po.call('get_scene_summary')).text.split('\n')[0]).toBe('board "Overview" (overview) · rev 7 · 3 shapes');
    expect((await po.call('get_scene_summary', { frameId: 'nope' })).text).toBe('no frame [nope] on this board (rev 7)');
  });

  it('reports no browser when waiting with no tab open', async () => {
    expect((await po.call('wait_for_changes', { timeoutSeconds: 1 })).text).toMatch(/^no browser has d_over open/);
  });

  it('writes to the board as the writer, and reports conflicts', async () => {
    const r = await po.call('apply_changes', { diagramId: 'd_over', ops: [
      { op: 'create', type: 'rectangle', id: 'n', label: 'Refund', x: 0, y: 200 },
      { op: 'update', id: 'checkout', patch: { x: 5 }, expectedVersion: 9 }
    ] });
    expect(r.isError).toBe(false);
    const lines = r.text.split('\n');
    expect(lines[0]).toMatch(/^on "Overview" \(d_over\) rev 8 · applied 1 \(create 1\) · frame \[[\w-]+\]$/);
    expect(lines[1]).toBe('created [n]');
    expect(lines[2]).toBe('conflict op 1 [checkout]: it changed since you read it (now v1)');
    const scene = await (await fetch(`${url}/api/diagrams/d_over/scene`)).json();
    expect(scene.elements.find((e: SceneEl) => e.id === 'n')).toMatchObject({ strokeColor: '#1971c2', customData: { origin: 'agent' } });
  });

  it('refuses a write meant for another board and leaves both files unchanged', async () => {
    await new Promise((r) => setTimeout(r, 800)); // let earlier saves land
    const files = ['overview.excalidraw', 'checkout.excalidraw'].map((f) => join(dir, 'docs', 'diagrams', f));
    const before = files.map((f) => (existsSync(f) ? readFileSync(f, 'utf8') : ''));
    const r = await po.call('apply_changes', { diagramId: 'd_seq', ops: [{ op: 'delete', id: 'checkout' }] });
    expect(r).toEqual({ isError: true, text: 'this session has "Overview" (d_over) open, not "Checkout sequence" (d_seq); ask the user before switching with open_diagram' });
    await new Promise((r) => setTimeout(r, 800));
    expect(files.map((f) => (existsSync(f) ? readFileSync(f, 'utf8') : ''))).toEqual(before);
  });

  it('refuses a read-only session and leaves the file unchanged', async () => {
    const file = join(dir, 'docs', 'diagrams', 'overview.excalidraw');
    await new Promise((r) => setTimeout(r, 800)); // let the writer's save land
    const before = readFileSync(file, 'utf8');
    const r = await dev.call('apply_changes', { ops: [{ op: 'delete', id: 'checkout' }] });
    expect(r).toEqual({ isError: true, text: 'd_over is read-only for this session' });
    await new Promise((r) => setTimeout(r, 800));
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(before).toContain('"id": "checkout"');
  });

  it('makes refs to the bound board for agents and people', async () => {
    expect((await dev.call('make_ref', { elementId: 'checkout' })).text.split('\n')).toEqual([
      'dl://d_over@8#checkout',
      `${url}/d/d_over?rev=8#checkout`
    ]);
    expect(await dev.call('make_ref', { elementId: 'nope' })).toMatchObject({ isError: true, text: 'no element [nope] on d_over' });
  });

  it('accepts a proposal: its elements leave the frame in green and the empty frame goes', async () => {
    const before = (await (await fetch(`${url}/api/diagrams/d_over/scene`)).json()).elements as SceneEl[];
    const frameId = before.find((e) => e.id === 'n')!.frameId as string;
    expect(await dev.call('accept_proposal', { frameId })).toEqual({ isError: true, text: 'd_over is read-only for this session' });
    expect((await po.call('accept_proposal', { frameId, diagramId: 'd_seq' })).isError).toBe(true);
    expect((await po.call('accept_proposal', { frameId, diagramId: 'd_over' })).text).toBe('on "Overview" (d_over) rev 10 · accepted 1 [n] · frame deleted');
    const after = (await (await fetch(`${url}/api/diagrams/d_over/scene`)).json()).elements as SceneEl[];
    expect(after.find((e) => e.id === 'n')).toMatchObject({ frameId: null, strokeColor: '#2f9e44' });
    expect(after.some((e) => e.id === frameId)).toBe(false);
  });

  it('leaves a question for a role that is not running, shown when it opens a board', async () => {
    const q = await dev.call('ask', { ref: 'dl://d_over@8#checkout', toRole: 'po', text: 'Does checkout need login?' });
    const id = /^asked po: (q_[0-9a-f]+)/.exec(q.text)![1];
    expect(await dev.call('ask', { ref: 'dl://d_nope', toRole: 'po', text: 'x' })).toMatchObject({ isError: true, text: 'unknown diagram: d_nope' });

    const po2 = await connect({ projectDir: dir, sessionId: 'mcp-test-po3', claudePid: 444 });
    const opened = (await po2.call('open_diagram', { id: 'd_over', as: 'po' })).text;
    expect(opened).toContain(`question ${id} from dev: "Does checkout need login?" · dl://d_over@8#checkout`);
    expect(await po2.call('answer', { questionId: id, text: 'Guests too', ref: 'dl://d_over#checkout' })).toMatchObject({ isError: false, text: `answered ${id}` });
    expect((await po2.call('answer', { questionId: id, text: 'again' })).isError).toBe(true);

    // The asker sees the answer once, the next time it opens a board.
    const seen = (await dev.call('open_diagram', { id: 'd_seq', as: 'dev' })).text;
    expect(seen).toContain(`answer to ${id} from po: "Guests too" · dl://d_over#checkout`);
    expect((await dev.call('open_diagram', { id: 'd_seq', as: 'dev' })).text).not.toContain(id);
    await po2.board.close();
  });

  it('creates a diagram with the conventions of its kind, none for free', async () => {
    expect((await po.call('create_diagram', { name: 'Scratch', kind: 'free' })).text).not.toContain('conventions');
    expect((await po.call('create_diagram', { name: 'API', kind: 'c4-component' })).text)
      .toMatch(/\nc4-component conventions: rectangle = system\/container/);
  });

  it('releases the lease and its session file on close', async () => {
    await po.board.close();
    expect(existsSync(join(dir, '.claude', 'skills', 'setup-excalidraw-live-multiagent', 'state', 'sessions', '111.json'))).toBe(false);
    const again = await connect({ projectDir: dir, sessionId: 'mcp-test-po2', claudePid: 333 });
    expect((await again.call('open_diagram', { id: 'd_over', as: 'po' })).text).toMatch(/\(writer\)/);
  });
});
