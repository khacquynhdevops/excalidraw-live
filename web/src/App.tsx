import { useEffect, useRef, useState } from 'react';
import { Excalidraw, CaptureUpdateAction, reconcileElements } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI, AppState, BinaryFileData } from '@excalidraw/excalidraw/types';
import type { RemoteExcalidrawElement } from '@excalidraw/excalidraw/data/reconcile';
import type { ClientMsg, DiagramEntry, Presence, SceneEl, SceneFiles, ServerMsg } from '@excalidraw-live/shared';

const THROTTLE_MS = 250;
const clientId = crypto.randomUUID();

type Status = 'connecting' | 'live' | 'offline' | 'unknown';

export default function App({ diagramId }: { diagramId: string }) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [rev, setRev] = useState(0);
  const [entry, setEntry] = useState<DiagramEntry | null>(null);
  const sync = useRef<Sync | null>(null);

  useEffect(() => {
    fetch(`/api/diagrams/${encodeURIComponent(diagramId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setEntry(d);
        if (d) document.title = `${d.name} · excalidraw-live`;
        else setStatus('unknown');
      });
  }, [diagramId]);

  useEffect(() => {
    if (!api || !entry) return;
    const s = new Sync(api, entry.id, setStatus, setRev);
    sync.current = s;
    return () => s.stop();
  }, [api, entry]);

  return (
    <>
      <a href="/" title="All diagrams" aria-label="All diagrams" style={homeStyle}>
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10" />
        </svg>
      </a>
      <div title={entry ? `${entry.name} · ${entry.id} · ${entry.kind}` : diagramId} style={titleStyle}>
        <div style={{ fontSize: 16, fontWeight: 600, lineHeight: '20px', color: '#1b1b1f', ...ellipsis }}>{entry ? entry.name : diagramId}</div>
        {entry && <div style={{ fontSize: 12, lineHeight: '16px', ...ellipsis }}>{`${entry.id} · ${entry.kind}`}</div>}
      </div>
      <Excalidraw
        excalidrawAPI={setApi}
        onChange={(_els, appState) => sync.current?.onChange(appState)}
        renderTopRightUI={() => (
          <div style={{ height: 36, lineHeight: '36px', padding: '0 10px', fontFamily: UI_FONT, fontSize: 12, whiteSpace: 'nowrap', color: status === 'live' ? '#2b8a3e' : '#c92a2a' }}>
            ● {status} · rev {rev}
          </div>
        )}
      />
    </>
  );
}

// The home button and title sit outside Excalidraw (it has no top-left slot),
// so they set their own font and line up with its 36px menu button by hand.
const UI_FONT = 'Assistant, system-ui, sans-serif';
const ellipsis = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as const;
const homeStyle = {
  position: 'fixed', top: 60, left: 16, zIndex: 10, width: 36, height: 36, boxSizing: 'border-box',
  display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: '#ececf4', color: '#1b1b1f',
} as const;
const titleStyle = {
  position: 'fixed', top: 16, left: 64, zIndex: 10, minHeight: 36, maxWidth: 'calc(50vw - 360px)', padding: '0 10px',
  display: 'flex', flexDirection: 'column', justifyContent: 'center', fontFamily: UI_FONT, color: '#495057',
} as const;

// Keeps one tab in step with the canvas server.
//
// Echo suppression: `localSent` holds, per element, the local version last
// sent to or received from the server; only elements whose version differs
// are sent. `serverKnown` holds the highest version the server is known to
// have, and an outgoing element always carries a version above it, so an
// edit made after seeing a remote change wins over that change.
class Sync {
  private ws: WebSocket | null = null;
  private stopped = false;
  private rev = 0;
  private localSent = new Map<string, number>();
  private serverKnown = new Map<string, number>();
  private sentFiles = new Set<string>();
  private flushTimer: number | null = null;
  private lastPresence = '';

  constructor(
    private api: ExcalidrawImperativeAPI,
    private diagramId: string,
    private setStatus: (s: Status) => void,
    private setRev: (r: number) => void
  ) {
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }

  onChange(appState: AppState) {
    if (this.flushTimer === null) this.flushTimer = window.setTimeout(() => this.flush(), THROTTLE_MS);
    this.sendPresence(appState);
  }

  private connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${encodeURIComponent(this.diagramId)}`);
    this.ws = ws;
    ws.onmessage = (e) => this.receive(JSON.parse(e.data));
    ws.onclose = () => {
      this.ws = null;
      if (this.stopped) return;
      this.setStatus('offline');
      setTimeout(() => this.connect(), 1000);
    };
  }

  private receive(msg: ServerMsg) {
    if (msg.t === 'scene_init') {
      // The server may have restarted and lost changes: forget what we
      // think it has, so anything it is missing gets sent again.
      this.localSent.clear();
      this.serverKnown.clear();
      this.setStatus('live');
    }
    if (msg.t !== 'patch_rejected' && msg.files) this.addFiles(msg.files);
    this.merge(msg.elements);
    if (msg.t === 'scene_init') this.onChange(this.api.getAppState());
    this.rev = Math.max(this.rev, msg.rev);
    this.setRev(this.rev);
  }

  private addFiles(files: SceneFiles) {
    for (const id of Object.keys(files)) this.sentFiles.add(id);
    this.api.addFiles(Object.values(files) as unknown as BinaryFileData[]);
  }

  private merge(remote: SceneEl[]) {
    if (!remote.length) return;
    const local = this.api.getSceneElementsIncludingDeleted();
    const merged = reconcileElements(
      local,
      remote as unknown as RemoteExcalidrawElement[],
      this.api.getAppState()
    );
    this.api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });

    const kept = new Map(merged.map((e) => [e.id, e]));
    let keptLocal = false;
    for (const r of remote) {
      this.serverKnown.set(r.id, Math.max(this.serverKnown.get(r.id) ?? 0, r.version));
      const now = kept.get(r.id);
      if ((now as unknown) === r || (now?.version === r.version && now.versionNonce === r.versionNonce)) {
        this.localSent.set(r.id, r.version);
      } else {
        // reconcile kept ours (being edited, or newer): push ours so the
        // server and other tabs converge on it.
        this.localSent.delete(r.id);
        keptLocal = true;
      }
    }
    if (keptLocal) this.onChange(this.api.getAppState());
  }

  private flush() {
    this.flushTimer = null;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const elements: SceneEl[] = [];
    for (const el of this.api.getSceneElementsIncludingDeleted()) {
      if (this.localSent.get(el.id) === el.version) continue;
      const version = Math.max(el.version, (this.serverKnown.get(el.id) ?? 0) + 1);
      elements.push({ ...(el as unknown as SceneEl), version });
      this.localSent.set(el.id, el.version);
      this.serverKnown.set(el.id, version);
    }

    const files: SceneFiles = {};
    for (const [id, f] of Object.entries(this.api.getFiles())) {
      if (this.sentFiles.has(id)) continue;
      files[id] = f as unknown as SceneFiles[string];
      this.sentFiles.add(id);
    }

    if (!elements.length && !Object.keys(files).length) return;
    this.send({ t: 'client_patch', clientId, baseRev: this.rev, elements, files });
  }

  private sendPresence(appState: AppState) {
    const presence: Presence = {
      editingId: appState.editingTextElement?.id ?? null,
      selectedIds: Object.keys(appState.selectedElementIds),
      idle: !(appState.editingTextElement || appState.newElement || appState.resizingElement || appState.selectedElementsAreBeingDragged)
    };
    const key = JSON.stringify(presence);
    if (key === this.lastPresence) return;
    this.lastPresence = key;
    this.send({ t: 'presence', clientId, ...presence });
  }

  private send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
