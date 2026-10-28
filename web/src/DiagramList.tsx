import { useEffect, useState, type FormEvent } from 'react';
import { DIAGRAM_KINDS, type DiagramEntry, type DiagramKind } from '@excalidraw-live/shared';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json' } });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body;
}

export default function DiagramList() {
  const [diagrams, setDiagrams] = useState<DiagramEntry[]>([]);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<DiagramKind>('free');
  const [owner, setOwner] = useState('');
  const [audience, setAudience] = useState('');

  const reload = () => call<DiagramEntry[]>('/api/diagrams').then(setDiagrams, (e) => setError(e.message));
  useEffect(() => { reload(); }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const d = await call<DiagramEntry>('/api/diagrams', {
        method: 'POST',
        body: JSON.stringify({ name, kind, owner, audience: audience.split(',').map((s) => s.trim()).filter(Boolean) })
      });
      location.href = `/d/${encodeURIComponent(d.id)}`;
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function rename(d: DiagramEntry) {
    const next = prompt('New name', d.name);
    if (!next || next === d.name) return;
    try {
      await call(`/api/diagrams/${encodeURIComponent(d.id)}`, { method: 'PATCH', body: JSON.stringify({ name: next }) });
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 760, margin: '32px auto', padding: '0 16px' }}>
      <h1>Diagrams</h1>
      {error && <p style={{ color: '#c92a2a' }}>{error}</p>}
      {diagrams.length === 0 ? <p>No diagrams yet.</p> : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left' }}><th>Name</th><th>Kind</th><th>Owner</th><th>Audience</th><th>Id</th><th /></tr>
          </thead>
          <tbody>
            {diagrams.map((d) => (
              <tr key={d.id} style={{ borderTop: '1px solid #ddd' }}>
                <td><a href={`/d/${encodeURIComponent(d.id)}`}>{d.name}</a></td>
                <td>{d.kind}</td>
                <td>{d.owner}</td>
                <td>{d.audience.join(', ')}</td>
                <td><code>{d.id}</code></td>
                <td><button onClick={() => rename(d)}>Rename</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>New diagram</h2>
      <form onSubmit={create} style={{ display: 'grid', gap: 8, maxWidth: 360 }}>
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <select value={kind} onChange={(e) => setKind(e.target.value as DiagramKind)}>
          {DIAGRAM_KINDS.map((k) => <option key={k}>{k}</option>)}
        </select>
        <input placeholder="Owner role (e.g. po)" value={owner} onChange={(e) => setOwner(e.target.value)} required />
        <input placeholder="Audience roles, comma separated" value={audience} onChange={(e) => setAudience(e.target.value)} />
        <button type="submit">Create</button>
      </form>
    </main>
  );
}
