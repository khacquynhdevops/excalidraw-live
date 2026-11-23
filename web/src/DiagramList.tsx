import { useEffect, useRef, useState, type FormEvent, type SyntheticEvent } from 'react';
import { DIAGRAM_KINDS, type DiagramEntry } from '@excalidraw-live/shared';
import './home.css';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json' } });
  if (res.status === 204) return undefined as T;
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body;
}

const url = (d: DiagramEntry) => `/d/${encodeURIComponent(d.id)}`;
const api = (d: DiagramEntry) => `/api/diagrams/${encodeURIComponent(d.id)}`;
// React's autoFocus focuses on mount; a dialog needs the real attribute, read on showModal().
const autofocus = (el: HTMLElement | null) => el?.setAttribute('autofocus', '');

// Keep aria-invalid and the error link in step with :user-invalid.
function syncInvalid(el: EventTarget | null) {
  if (!(el instanceof HTMLInputElement) || !el.dataset.error) return;
  const bad = el.matches(':user-invalid');
  el.setAttribute('aria-invalid', String(bad));
  const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((i) => i && i !== el.dataset.error);
  if (bad) ids.push(el.dataset.error);
  if (ids.length) el.setAttribute('aria-describedby', ids.join(' '));
  else el.removeAttribute('aria-describedby');
}

function Role({ role }: { role: string }) {
  return <span className="badge role" data-role={role}>{role}</span>;
}

export default function DiagramList() {
  const [diagrams, setDiagrams] = useState<DiagramEntry[] | null>(null);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState<DiagramEntry | null>(null);
  const createDlg = useRef<HTMLDialogElement>(null);
  const createForm = useRef<HTMLFormElement>(null);
  const renameDlg = useRef<HTMLDialogElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const deleteDlg = useRef<HTMLDialogElement>(null);

  const reload = () => call<DiagramEntry[]>('/api/diagrams').then(setDiagrams, (e) => setError(e.message));
  useEffect(() => { reload(); }, []);
  useEffect(() => {
    const on = (e: Event) => syncInvalid(e.target);
    const types = ['blur', 'input', 'invalid'];
    types.forEach((t) => document.addEventListener(t, on, true));
    return () => types.forEach((t) => document.removeEventListener(t, on, true));
  }, []);

  function openCreate() {
    setFormError('');
    createForm.current?.reset();
    createDlg.current?.showModal();
  }
  function openRename(d: DiagramEntry) {
    setFormError('');
    setCurrent(d);
    renameInput.current!.value = d.name;
    renameDlg.current?.showModal();
  }
  function openDelete(d: DiagramEntry) {
    setCurrent(d);
    deleteDlg.current?.showModal();
  }

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setFormError('');
    try {
      const d = await call<DiagramEntry>('/api/diagrams', {
        method: 'POST',
        body: JSON.stringify({
          name: f.get('name'), kind: f.get('kind'), owner: f.get('owner'),
          audience: String(f.get('audience')).split(',').map((s) => s.trim()).filter(Boolean)
        })
      });
      location.href = url(d);
    } catch (err) {
      setFormError((err as Error).message);
      setBusy(false);
    }
  }

  async function rename(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = renameInput.current!.value.trim();
    if (!current || name === current.name) return renameDlg.current?.close();
    setBusy(true);
    setFormError('');
    try {
      await call(api(current), { method: 'PATCH', body: JSON.stringify({ name }) });
      renameDlg.current?.close();
      await reload();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // The delete dialog is a yes/no question: only the Delete button sets returnValue.
  async function onDeleteClose(e: SyntheticEvent<HTMLDialogElement>) {
    const dlg = e.currentTarget;
    const yes = dlg.returnValue === 'delete';
    dlg.returnValue = '';
    if (!yes || !current) return;
    setError('');
    try {
      await call(api(current), { method: 'DELETE' });
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const count = diagrams?.length ?? 0;
  return (
    <div className="home">
      <main>
        <header>
          <h1>Diagrams</h1>
          {diagrams && <span className="count">{count} board{count === 1 ? '' : 's'}</span>}
          <span className="spacer" />
          <button type="button" className="primary" onClick={openCreate}>+ New diagram</button>
        </header>
        {error && <p className="page-error" role="alert">{error}</p>}

        {diagrams && count === 0 && (
          <div className="empty">
            <h2>No diagrams yet</h2>
            <p>Create the first board, or ask an agent to draw one.</p>
            <button type="button" className="primary" onClick={openCreate}>+ New diagram</button>
          </div>
        )}
        {diagrams && count > 0 && (
          <div className="table-wrapper" tabIndex={0} role="region" aria-labelledby="diagrams-caption">
            <table>
              <caption id="diagrams-caption">All boards in this workspace</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th><th scope="col">Kind</th><th scope="col">Owner</th>
                  <th scope="col">Audience</th><th scope="col">Id</th>
                  <th scope="col"><span className="visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {diagrams.map((d) => (
                  <tr key={d.id}>
                    <th scope="row"><a href={url(d)}>{d.name}</a></th>
                    <td><span className="badge">{d.kind}</span></td>
                    <td><Role role={d.owner} /></td>
                    <td>
                      <span className="chips">
                        {d.audience.length ? d.audience.map((r) => <Role key={r} role={r} />) : <span className="hint">—</span>}
                      </span>
                    </td>
                    <td><code>{d.id}</code></td>
                    <td className="actions">
                      <button type="button" onClick={() => openRename(d)} aria-label={`Rename ${d.name}`}>Rename</button>
                      <button type="button" className="ghost-danger" onClick={() => openDelete(d)} aria-label={`Delete ${d.name}`}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      <dialog ref={createDlg} aria-labelledby="create-title">
        <h2 id="create-title">New diagram</h2>
        <form ref={createForm} method="dialog" onSubmit={create}>
          <div className="field">
            <label htmlFor="c-name">Name</label>
            <input id="c-name" name="name" required ref={autofocus} data-error="c-name-error" />
            <div id="c-name-error" className="error-msg"><span role="img" aria-label="Error">⚠</span> Enter a name for the diagram.</div>
          </div>
          <div className="field">
            <label htmlFor="c-kind">Kind</label>
            <select id="c-kind" name="kind" defaultValue="free">
              {DIAGRAM_KINDS.map((k) => <option key={k}>{k}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="c-owner">Owner role</label>
            <span id="c-owner-hint" className="hint">The role that writes to this board, e.g. po, dev, tester.</span>
            <input id="c-owner" name="owner" required list="roles" aria-describedby="c-owner-hint" data-error="c-owner-error" />
            <div id="c-owner-error" className="error-msg"><span role="img" aria-label="Error">⚠</span> Enter the owner role, e.g. dev.</div>
          </div>
          <div className="field">
            <label htmlFor="c-aud">Audience</label>
            <span id="c-aud-hint" className="hint">Roles that read it, comma separated. Optional.</span>
            <input id="c-aud" name="audience" aria-describedby="c-aud-hint" />
          </div>
          <datalist id="roles">{['po', 'dev', 'tester', 'devops', 'security'].map((r) => <option key={r}>{r}</option>)}</datalist>
          {formError && <p className="form-error" role="alert">{formError}</p>}
          <div className="row">
            <button type="button" onClick={() => createDlg.current?.close()}>Cancel</button>
            <button className="primary" disabled={busy}>Create</button>
          </div>
        </form>
      </dialog>

      <dialog ref={renameDlg} aria-labelledby="rename-title">
        <h2 id="rename-title">Rename diagram</h2>
        <form method="dialog" onSubmit={rename}>
          <div className="field">
            <label htmlFor="r-name">New name</label>
            <input id="r-name" required ref={(el) => { renameInput.current = el; autofocus(el); }} data-error="r-name-error" />
            <div id="r-name-error" className="error-msg"><span role="img" aria-label="Error">⚠</span> The name cannot be empty.</div>
          </div>
          {formError && <p className="form-error" role="alert">{formError}</p>}
          <div className="row">
            <button type="button" onClick={() => renameDlg.current?.close()}>Cancel</button>
            <button className="primary" disabled={busy}>Save</button>
          </div>
        </form>
      </dialog>

      <dialog ref={deleteDlg} aria-labelledby="delete-title" aria-describedby="delete-desc" onClose={onDeleteClose}>
        <h2 id="delete-title">Delete “{current?.name}”?</h2>
        <p id="delete-desc" className="warn">
          The diagram is removed from the list, and its board file and change log are deleted.
          Boards that refine it keep a link to it that no longer opens. This cannot be undone from the app.
        </p>
        <form method="dialog">
          <div className="row">
            <button value="cancel" ref={autofocus}>Cancel</button>
            <button className="danger" value="delete">Delete</button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
