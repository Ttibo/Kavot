import { useCallback, useEffect, useState } from 'react';
import { useRuntime } from '../app/runtime';
import { refreshData, toast } from '../app/navigation';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/common';
import { FitList, ViewHeader, ViewPage } from '../components/ViewLayout';
import { api } from '../services/api';
import '../styles/features/trash.css';

type TreeNode = { path: string; name: string; label?: string; kind: string; trash_id?: string; children?: TreeNode[] };
type DeletedProject = { id: string; name: string; deleted_at: string };
type Entry = { key: string; source: 'workspace' | 'project'; id: string; label: string; detail: string; icon: string };

const KIND_ICONS: Record<string, string> = { directory: 'folder', pdf: 'papers', markdown: 'canvas', html: 'canvas' };

/** Notes, files and projects moved to the trash, in one place. */
export function TrashView() {
  const runtime = useRuntime();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const [tree, projects] = await Promise.all([api<TreeNode[]>('/workspace/tree'), api<DeletedProject[]>('/projects/trash')]);
      runtime.state.workspaceTree = tree;
      const files = (tree.find(root => root.path === 'trash')?.children || []).filter(node => node.trash_id).map(node => ({
        key: `workspace:${node.trash_id}`, source: 'workspace' as const, id: node.trash_id!, label: node.label || node.name,
        detail: node.kind === 'directory' ? 'Folder' : node.kind === 'markdown' ? 'Note' : 'File', icon: KIND_ICONS[node.kind] || 'canvas',
      }));
      const deletedProjects = projects.map(item => ({
        key: `project:${item.id}`, source: 'project' as const, id: item.id, label: item.name,
        detail: `Project · deleted ${new Date(item.deleted_at).toLocaleDateString('en-US')}`, icon: 'projects',
      }));
      setEntries([...deletedProjects, ...files]);
    } catch (reason) { setError((reason as Error).message); }
    finally { setLoading(false); }
  }, [runtime]);
  useEffect(() => { void load(); }, [load]);

  async function run(entry: Entry, work: () => Promise<unknown>, message: string) {
    setBusy(entry.key); setError('');
    try {
      await work();
      setEntries(current => current.filter(item => item.key !== entry.key));
      await refreshData();
      toast(message);
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(null); }
  }
  const restore = (entry: Entry) => run(entry, () => api(entry.source === 'project'
    ? `/projects/trash/${encodeURIComponent(entry.id)}/restore`
    : `/workspace/trash/${encodeURIComponent(entry.id)}/restore`, { method: 'POST' }), entry.source === 'project' ? 'Project restored' : 'Item restored to its original location');
  const purge = (entry: Entry) => {
    const state = runtime.state;
    const marker = `trash/${entry.id}/`;
    if (state.primaryResource?.path?.startsWith(marker)) state.primaryResource = null;
    if (state.secondaryResource?.path?.startsWith(marker)) state.secondaryResource = null;
    return api(entry.source === 'project'
      ? `/projects/trash/${encodeURIComponent(entry.id)}`
      : `/workspace/trash/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
  };
  const remove = (entry: Entry) => {
    if (!confirm('Permanently delete this item? This cannot be undone.')) return;
    void run(entry, () => purge(entry), 'Item permanently deleted');
  };
  async function emptyTrash() {
    if (!confirm(`Permanently delete ${entries.length === 1 ? 'the item' : `all ${entries.length} items`} in the trash? This cannot be undone.`)) return;
    setBusy('all'); setError('');
    const failed: Entry[] = [];
    for (const entry of entries) {
      try { await purge(entry); } catch { failed.push(entry); }
    }
    setEntries(failed);
    await refreshData();
    setBusy(null);
    if (failed.length) setError(`${failed.length} item${failed.length === 1 ? '' : 's'} could not be deleted.`);
    else toast('Trash emptied');
  }

  return <ViewPage className="trash-view" label="Trash">
    <ViewHeader icon="trash" title="Trash" count={entries.length} subtitle="Deleted items stay in the workspace folder until they are restored or deleted permanently.">
      <button className="button trash-delete" disabled={!entries.length || busy !== null} onClick={() => void emptyTrash()}><Icon name="trash" size={14}/>{busy === 'all' ? 'Emptying…' : 'Empty trash'}</button>
    </ViewHeader>
    {error && <p role="alert" className="trash-error">{error}</p>}
    <FitList items={entries} label="Trash pages" resetKey={entries.length}
      empty={loading ? <p role="status">Loading the trash…</p> : <EmptyState icon="◇" title="The trash is empty">Deleted notes, files and projects appear here.</EmptyState>}
      render={entry => <div key={entry.key} className="trash-row">
        <Icon name={entry.icon} size={15}/>
        <span className="trash-row-copy"><strong>{entry.label}</strong><small>{entry.detail}</small></span>
        <span className="trash-row-actions">
          <button className="button button-small" disabled={busy !== null} aria-label={`Restore ${entry.label}`} onClick={() => void restore(entry)}>{busy === entry.key ? 'Restoring…' : 'Restore'}</button>
          <button className="button button-small trash-delete" disabled={busy !== null} aria-label={`Delete ${entry.label} permanently`} onClick={() => remove(entry)}>Delete permanently</button>
        </span>
      </div>}/>
  </ViewPage>;
}
