import { useEffect, useState } from 'react';
import { DiffView } from './DiffView';
import { atelierApi, relative, type Commit, type Diff, type Folder } from './types';

export function GitPanel({ projectId, folder }: { projectId: number; folder: Folder }) {
  const [commits, setCommits] = useState<Commit[]>([]);
  const [more, setMore] = useState(true);
  const [selected, setSelected] = useState<string>('working');
  const [diff, setDiff] = useState<Diff | null>(null);
  const [error, setError] = useState('');
  async function loadCommits(skip = 0) {
    const page = await atelierApi<Commit[]>(projectId, `/folders/${folder.id}/log?limit=50&skip=${skip}`);
    setCommits(current => skip ? [...current, ...page] : page);
    setMore(page.length === 50);
  }
  useEffect(() => { setSelected('working'); void loadCommits().catch(reason => setError(reason.message)); }, [projectId, folder.id]);
  useEffect(() => {
    let alive = true;
    setDiff(null); setError('');
    atelierApi<Diff>(projectId, selected === 'working' ? `/folders/${folder.id}/changes` : `/folders/${folder.id}/commits/${selected}`)
      .then(result => { if (alive) setDiff(result); }).catch(reason => { if (alive) setError(reason.message); });
    return () => { alive = false; };
  }, [projectId, folder.id, selected]);
  if (!folder.is_git) return <p className="atelier-empty">{folder.parent_repository ? 'This folder is inside a larger Git repository: link the repository root to see its history.' : 'This folder is not a Git repository.'}</p>;
  const commit = commits.find(item => item.sha === selected);
  return <div className="atelier-git">
    <nav className="atelier-commits" aria-label="History">
      <button className={`atelier-commit ${selected === 'working' ? 'active' : ''}`} onClick={() => setSelected('working')}>
        <strong>Uncommitted changes</strong><small>{folder.changes.length} file{folder.changes.length === 1 ? '' : 's'} · {folder.branch}</small>
      </button>
      {commits.map(item => <button key={item.sha} className={`atelier-commit ${selected === item.sha ? 'active' : ''}`} onClick={() => setSelected(item.sha)}>
        <strong>{item.subject}</strong>
        <small><code>{item.short}</code> · {item.author} · {relative(item.date)}</small>
        {!!item.refs.length && <span className="atelier-chips">{item.refs.map(ref => <code key={ref} className="atelier-ref">{ref.replace('HEAD -> ', '')}</code>)}</span>}
      </button>)}
      {more && <button className="text-link atelier-more" onClick={() => void loadCommits(commits.length)}>Older commits</button>}
    </nav>
    <section className="atelier-git-detail" aria-label="Changes">
      {commit && <header className="atelier-commit-head"><h3>{commit.subject}</h3><p className="atelier-muted"><code>{commit.short}</code> · {commit.author} · {new Date(commit.date).toLocaleString()}</p>
        {diff?.message && diff.message !== commit.subject && <pre className="atelier-commit-message">{diff.message}</pre>}</header>}
      {error ? <p className="atelier-empty">{error}</p> : diff ? <DiffView files={diff.files} truncated={diff.truncated} empty={selected === 'working' ? 'The checkout is clean.' : 'No change in this commit.'}/> : <p className="atelier-empty">Loading…</p>}
    </section>
  </div>;
}
