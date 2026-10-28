import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { useRuntime } from '../app/runtime';
import '../styles/features/workspace-map.css';

type SearchStatus = { documents: number; vectors: number; items: Record<string, number>; semantic: { enabled: boolean; installed: boolean; active: boolean; error?: string | null } };
type Digest = { ref: string; title: string; summary: string; fresh: boolean; sections: number; updated_at: string; author?: { kind?: string; engine?: string; model?: string } };

function authorLabel(digest: Digest) {
  const author = digest.author || {};
  if (author.kind !== 'agent') return 'You';
  return [author.engine, author.model].filter(Boolean).join(' · ') || 'Agent';
}

/** Search index, semantic search and the summaries agents keep to avoid rereading sources. */
export function WorkspaceMapSettings() {
  const runtime = useRuntime();
  const [status, setStatus] = useState<SearchStatus | null>(null);
  const [digests, setDigests] = useState<Digest[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    try {
      const [nextStatus, nextDigests] = await Promise.all([api<SearchStatus>('/search/status'), api<Digest[]>('/digests')]);
      setStatus(nextStatus); setDigests(nextDigests); setError('');
    } catch (reason) { setError((reason as Error).message); }
  }
  useEffect(() => { void load(); }, []);

  async function run(key: string, action: () => Promise<unknown>, done: string) {
    setBusy(key); setError('');
    try { await action(); await load(); runtime.toast(done); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(null); }
  }

  const semantic = status?.semantic;
  return <>
    <article className="settings-card workspace-map-card">
      <h3>Workspace map</h3>
      <p>Agents search and explore a local index of your notes, articles, PDF pages, files and collections, and open only the passages they need.</p>
      {error && <p role="alert">{error}</p>}
      {status && <dl className="workspace-map-stats">
        <div><dt>Indexed passages</dt><dd>{status.documents.toLocaleString('en-US')}</dd></div>
        <div><dt>Items</dt><dd>{Object.values(status.items).reduce((sum, count) => sum + count, 0).toLocaleString('en-US')}</dd></div>
        <div><dt>Meaning vectors</dt><dd>{status.vectors.toLocaleString('en-US')}</dd></div>
      </dl>}
      <label className="workspace-map-toggle">
        <input type="checkbox" checked={!!semantic?.enabled} disabled={!semantic?.installed || busy !== null}
          onChange={event => void run('semantic', () => api('/settings/preferences', { method: 'PATCH', body: JSON.stringify({ semantic_search: event.target.checked }) }),
            event.target.checked ? 'Semantic search turned on' : 'Semantic search turned off')}/>
        <span><strong>Search by meaning</strong><small>{semantic?.installed
          ? 'Finds passages that share no word with the question. Downloads a small multilingual model once; then everything stays on this device.'
          : 'Install the optional component to enable it: pip install "kavot[semantic]".'}</small></span>
      </label>
      {semantic?.error && <p className="settings-hint">The model could not be loaded: {semantic.error}</p>}
      <div className="form-actions"><button className="button" disabled={busy !== null} onClick={() => void run('reindex', () => api('/search/reindex', { method: 'POST' }), 'Index updated')}>{busy === 'reindex' ? 'Updating…' : 'Update the index'}</button></div>
    </article>
    <article className="settings-card workspace-map-card">
      <h3>Summaries kept by agents</h3>
      <p>When an agent reads a long item in full, it can keep a summary so later requests read the summary instead. A summary is hidden as soon as its source changes.</p>
      {digests.length ? <ul className="digest-list">{digests.map(digest => <li key={digest.ref}>
        <div className="digest-heading"><strong>{digest.title || digest.ref}</strong><span className={digest.fresh ? 'digest-state fresh' : 'digest-state stale'}>{digest.fresh ? 'Up to date' : 'Source changed'}</span></div>
        <p>{digest.summary}</p>
        <small>{authorLabel(digest)} · {new Date(digest.updated_at).toLocaleDateString('en-US')}{digest.sections ? ` · ${digest.sections} section summaries` : ''}</small>
        <button className="button button-small" disabled={busy !== null} onClick={() => void run(digest.ref, () => api(`/digests?ref=${encodeURIComponent(digest.ref)}`, { method: 'DELETE' }), 'Summary deleted')}>{busy === digest.ref ? 'Deleting…' : 'Delete'}</button>
      </li>)}</ul> : <p className="settings-hint">No summaries yet.</p>}
    </article>
  </>;
}
