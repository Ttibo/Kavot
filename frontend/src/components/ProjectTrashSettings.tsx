import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { useRuntime } from '../app/runtime';

type DeletedProject = { id: string; name: string; deleted_at: string };

export function ProjectTrashSettings() {
  const runtime = useRuntime();
  const [items, setItems] = useState<DeletedProject[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    const load = () => void api<DeletedProject[]>('/projects/trash').then(setItems).catch(reason => setError(reason.message));
    load();
    window.addEventListener('kavot:projects-trashed', load);
    return () => window.removeEventListener('kavot:projects-trashed', load);
  }, []);
  async function restore(item: DeletedProject) {
    setBusy(item.id); setError('');
    try {
      await api(`/projects/trash/${encodeURIComponent(item.id)}/restore`, { method: 'POST' });
      setItems(current => current.filter(project => project.id !== item.id));
      await runtime.refreshData();
      runtime.toast('Project restored');
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(null); }
  }
  return <article className="settings-card"><h3>Deleted projects</h3><p>Projects moved to the trash stay in the workspace folder until they are restored.</p>
    {error && <p role="alert">{error}</p>}
    {items.length ? <ul>{items.map(item => <li key={item.id}><strong>{item.name}</strong>{' · '}{new Date(item.deleted_at).toLocaleDateString('en-US')}{' '}<button className="button button-small" disabled={busy !== null} onClick={() => void restore(item)}>{busy === item.id ? 'Restoring…' : 'Restore'}</button></li>)}</ul> : <p>No deleted projects.</p>}
  </article>;
}
