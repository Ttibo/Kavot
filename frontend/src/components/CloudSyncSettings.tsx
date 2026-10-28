import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { SyncActivity } from './SyncActivity';
import '../styles/cloud-storage.css';

function cloud(path: string, body?: unknown) {
  return api(`/cloud-sync${path}`, {headers: {'X-Kavot-Local': '1'},
    ...(body === undefined ? {} : {method: 'POST', body: JSON.stringify(body)})});
}

type SyncSummary = {
  uploaded: number;
  downloaded: number;
  deleted_local: number;
  deleted_remote: number;
  conflicts: string[];
  preserved: string[];
  skipped: string[];
  errors: {path: string; detail: string}[];
};

type WorkspaceStatus = {
  enabled: boolean;
  running: boolean;
  last_sync: number | null;
  last_error: string | null;
  interval_seconds: number;
  path: string;
  summary: SyncSummary | null;
  progress?: {phase: string; path: string | null; completed: number; total: number} | null;
  auth_required?: boolean;
  live?: boolean;
  duration_ms?: number | null;
  activity_revision?: number;
};

type Revision = {id: string; version: number; size: number; created_at: number; current: boolean};

const when = (timestamp: number) => new Date(timestamp * 1000).toLocaleString('en-US', {dateStyle: 'medium', timeStyle: 'short'});

function bytes(value = 0) {
  const unit = value >= 1024 ** 3 ? 3 : value >= 1024 ** 2 ? 2 : value >= 1024 ? 1 : 0;
  return `${(value / 1024 ** unit).toLocaleString('en-US', {maximumFractionDigits: 2})} ${['B', 'KB', 'MB', 'GB'][unit]}`;
}

export function CloudSyncSettings({ localStorage, storageBusy = false }: { localStorage: ReactNode; storageBusy?: boolean }) {
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState('');
  const [pairing, setPairing] = useState<any>(null);
  const [workspace, setWorkspace] = useState<WorkspaceStatus | null>(null);
  const [resources, setResources] = useState<any[]>([]);
  const [filesLoaded, setFilesLoaded] = useState(false);
  const [account, setAccount] = useState<any>(null);
  const [query, setQuery] = useState('');
  const lastSync = useRef<number | null>(null);
  const [comparison, setComparison] = useState<any>(null);
  const [conflictPath, setConflictPath] = useState('');
  const [message, setMessage] = useState('');
  const feedbackRef = useRef<HTMLParagraphElement>(null);
  const comparisonRef = useRef<HTMLDivElement>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetConfirmed, setResetConfirmed] = useState(false);
  const [working, setBusy] = useState(false);
  const [history, setHistory] = useState<{id: string; path: string; version: number; revisions: Revision[]} | null>(null);
  const busy = working || storageBusy;

  async function openHistory(item: any) {
    if (history?.id === item.id) { setHistory(null); return; }
    const revisions = await cloud(`/resources/${item.id}/revisions`);
    setHistory({id: item.id, path: item.path || item.name, version: item.version, revisions});
  }

  // Continue on our own once the user approves the device on the portal.
  useEffect(() => {
    if (!pairing) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      void cloud('/connect/poll', {}).then(async result => {
        if (stopped || result.status !== 'approved') return;
        stopped = true; setPairing(null); setConnected(true);
        setMessage('This device is linked. Sync started.');
        await refreshStatus(); await list();
      }).catch(error => { if (!stopped) { stopped = true; setPairing(null); setMessage(error.message); } });
    }, 3000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [pairing]);

  async function restoreRevision(revision: Revision) {
    if (!history || !window.confirm(`Restore the version from ${when(revision.created_at)}? It becomes the current version on all your devices; newer versions stay in the history.`)) return;
    await cloud(`/resources/${history.id}/restore`, {revision_id: revision.id, expected_version: history.version});
    setMessage(`${history.path} restored to the version from ${when(revision.created_at)}. It will appear locally within seconds.`);
    setHistory(null);
    await list();
  }

  useEffect(() => {
    if (comparison) comparisonRef.current?.scrollIntoView({block: 'nearest'});
  }, [comparison]);

  useEffect(() => {
    if (message && !working) feedbackRef.current?.scrollIntoView({block: 'nearest'});
  }, [message, working]);

  async function refreshStatus() {
    const result = await cloud('/status');
    setConnected(result.connected);
    setWorkspace(result.workspace);
    lastSync.current = result.workspace?.last_sync ?? null;
    setStatusError('');
    return result;
  }

  async function list() {
    const all: any[] = [];
    let offset = 0;
    while (all.length < 100) {
      const rows = await cloud(`/resources?offset=${offset}`);
      all.push(...rows);
      if (rows.length < 100) break;
      offset += rows.length;
    }
    setResources(all);
    setFilesLoaded(true);
    setAccount(await cloud('/account'));
  }

  async function run(action: () => Promise<void>) {
    setBusy(true); setMessage('');
    try { await action(); } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    const reload = () => {
      setComparison(null); setConflictPath('');
      void refreshStatus().then(async result => { if (result.connected) await list(); })
        .catch(error => setStatusError(error.message)).finally(() => setLoading(false));
    };
    reload();
    window.addEventListener('kavot:storage-updated', reload);
    const timer = window.setInterval(() => {
      void cloud('/status').then(async result => {
        setConnected(result.connected);
        setWorkspace(result.workspace);
        if (result.connected && result.workspace?.last_sync && result.workspace.last_sync !== lastSync.current) {
          lastSync.current = result.workspace.last_sync;
          const summary = result.workspace.summary;
          if (summary && summary.uploaded + summary.downloaded + summary.deleted_remote + summary.deleted_local > 0) await list();
        }
      }).catch(error => setMessage(error.message));
    }, 1000);
    return () => { window.clearInterval(timer); window.removeEventListener('kavot:storage-updated', reload); };
  }, []);

  async function synchronize() {
    const summary = await cloud('/workspace/sync', {});
    setWorkspace(await cloud('/workspace/status'));
    await list();
    const changes = summary.uploaded + summary.downloaded + summary.deleted_local + summary.deleted_remote;
    setMessage(summary.errors.length
      ? `Sync incomplete: ${summary.errors.length} error(s). ${changes} change(s) applied.`
      : summary.conflicts.length
      ? `${changes} change(s) synced. ${summary.conflicts.length} conflict(s) to resolve.`
      : `Folder synced · ${changes} change(s).`);
  }

  async function compare(path: string) {
    setComparison(null); setConflictPath('');
    const result = await cloud('/compare', {path});
    if (result.status === 'conflict') {
      setConflictPath(path); setComparison(result);
    } else {
      setMessage(result.status === 'resolved' || result.status === 'committed'
        ? 'This conflict is already resolved. Refresh the sync to update the summary.'
        : 'The transfer is still pending. Run the sync again before comparing.');
    }
  }

  async function resolve(choice: string) {
    const result = await cloud('/resolve', {path: conflictPath, choice, expected_version: comparison.current.version});
    if (result.status === 'conflict') {
      setComparison(await cloud('/compare', {path: conflictPath}));
      setMessage('The remote file changed again. The comparison has been refreshed.');
      return;
    }
    setComparison(null); setConflictPath('');
    const confirmation = `Conflict resolved.${result.backup ? ` Local copy kept: ${result.backup}` : ''}`;
    setMessage(confirmation);
    try {
      await refreshStatus();
      await list();
    } catch (error) {
      setMessage(`${confirmation} Unable to refresh the summary: ${(error as Error).message}`);
    }
  }

  const summary = workspace?.summary;
  const progress = workspace?.progress;
  const phaseLabels: Record<string, string> = {reset: 'Resetting the cloud', scan: 'Looking for changed files', remote: 'Checking the cloud', compare: 'Comparing versions', upload: 'Uploading to the cloud', download: 'Receiving from the cloud', done: 'Sync complete'};
  const storage = account?.storage;
  const reserved = storage?.reserved_bytes || 0;
  const visibleResources = resources.filter(item => (item.path || item.name).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const needsAttention = !!(workspace?.last_error || summary?.errors.length || summary?.conflicts.length);
  const expired = !!workspace?.auth_required;
  const linkDevice = () => void run(async () => setPairing(await cloud('/connect', {})));
  const state = loading ? 'loading' : statusError ? 'error' : expired ? 'expired' : !connected ? 'off'
    : workspace?.running ? 'running' : needsAttention ? 'attention' : 'ok';
  const headline = {loading: 'Checking…', error: 'Cloud unavailable', expired: 'Session expired', off: 'Not linked',
    running: phaseLabels[progress?.phase || 'scan'] || 'Syncing…', attention: 'Needs your attention', ok: 'Up to date'}[state];
  const detail = state === 'error' ? statusError
    : state === 'expired' ? 'Kavot Cloud no longer accepts this device. Your local files are safe; link it again to resume.'
    : state === 'off' ? 'Link Kavot Cloud to find this folder on your other devices. Optional: everything works offline.'
    : state === 'running' ? (progress?.total ? `${progress.completed} / ${progress.total} files · ${progress.path || ''}` : progress?.path || 'Preparing…')
    : state === 'attention' ? (workspace?.last_error || `${summary?.conflicts.length || 0} conflict(s) to resolve.`)
    : workspace?.last_sync ? `Last sync ${when(workspace.last_sync)} · changes are sent seconds after you save.` : 'Ready for the first sync.';
  const fileCount = resources.length;
  return <div className="storage-settings">
    <header className="storage-page-heading"><span className="storage-eyebrow">Your data</span><h2>Cloud and storage</h2>
      <div className="storage-explainer">
        <a href="#storage-sync"><strong>1 · Sync</strong><span>Your current files, identical on every linked device. Each file keeps its own version history.</span></a>
        <a href="#storage-backups"><strong>2 · Backups</strong><span>Dated snapshots of the whole workspace, automatic or manual, kept on this device and/or online.</span></a>
      </div>
    </header>

    <section id="storage-sync" className="storage-block" aria-labelledby="storage-sync-title">
      <h3 id="storage-sync-title" className="storage-block-title">1 · Sync</h3>
      <article className={`settings-card storage-status is-${state}`} aria-label="Sync status">
        <div className="storage-status-main">
          <span className="storage-status-dot" aria-hidden="true"/>
          <div className="storage-status-text" role="status" aria-live="polite"><strong>{headline}</strong><p>{detail}</p></div>
          <div className="storage-status-action">
            {(state === 'off' || state === 'expired') && <button className="button button-primary" disabled={busy || !!pairing} onClick={linkDevice}>{state === 'expired' ? 'Link again' : 'Link this device'}</button>}
            {state === 'error' && <button className="button" disabled={busy} onClick={() => void run(async () => { const result = await refreshStatus(); if (result.connected) await list(); })}>Try again</button>}
            {connected && <button className="button" disabled={busy || workspace?.running} onClick={() => void run(synchronize)}>Sync now</button>}
          </div>
        </div>
        {state === 'running' && <progress className="storage-status-progress" aria-label="Sync progress" max={Math.max(1, progress?.total || 0)} value={progress?.total ? progress.completed : undefined}/>}
        {pairing && <div className="storage-pairing" aria-label="Linking this device"><p>Confirm this code on Kavot Cloud. This page continues on its own once you approve.</p><strong className="storage-pairing-code">{pairing.user_code}</strong><div className="form-actions"><a className="button button-primary button-small" href={pairing.verification_url} target="_blank" rel="noreferrer">Open Kavot Cloud</a><button className="button button-small" onClick={() => setPairing(null)}>Cancel</button></div></div>}
        {connected && <dl className="storage-status-facts">
          <div><dt>Account</dt><dd>{account?.email || '…'}</dd></div>
          <div><dt>Cloud space</dt><dd>{storage ? <>{bytes(storage.used_bytes)} of {bytes(storage.quota_bytes)}<progress aria-label="Cloud quota usage" max={Math.max(1, storage.quota_bytes)} value={Math.min(storage.quota_bytes, storage.used_bytes + reserved)}/></> : 'Not enabled yet'}</dd></div>
          <div><dt>Synced files</dt><dd>{filesLoaded ? fileCount >= 100 ? '100+' : fileCount : '…'}</dd></div>
        </dl>}
        {(busy || message) && <p ref={feedbackRef} className="storage-notice" role="status">{busy ? storageBusy ? 'Moving the folder…' : 'Working…' : message}</p>}
        {!!summary?.errors.length && <details className="storage-activity"><summary>{summary.errors.length} file(s) could not be synced</summary><ul>{summary.errors.map(error => <li key={`${error.path}:${error.detail}`}><strong>{error.path}</strong> — {error.detail}</li>)}</ul></details>}
        {!!summary?.skipped.length && <details className="storage-activity"><summary>{summary.skipped.length} unreadable file(s) skipped</summary><ul>{summary.skipped.map(path => <li key={path}>{path}</li>)}</ul></details>}
        {!!summary?.preserved?.length && <details className="storage-activity"><summary>{summary.preserved.length} local cop(ies) kept during the first merge</summary><ul>{summary.preserved.map(path => <li key={path}>{path}</li>)}</ul></details>}
      </article>

      {!!summary?.conflicts.length && <article className="settings-card storage-conflicts" aria-label="Sync conflicts"><h4>Conflicts to resolve <span className="storage-badge">{summary.conflicts.length}</span></h4><p>These files changed on two devices. Compare them and choose what to keep.</p>
        {summary.conflicts.map(path => <div className="storage-conflict-row" key={path}><strong>{path}</strong><button className="button button-small" disabled={busy} onClick={() => void run(() => compare(path))}>Compare</button></div>)}
        {comparison?.status === 'conflict' && <div ref={comparisonRef} className="storage-comparison" aria-label="Resolving the conflict"><h4>{conflictPath}</h4>
          <p>{comparison.current.deleted_at ? 'Deleted in the cloud, changed here.' : `Cloud version ${comparison.current.version} vs. your local edit.`} Whatever you replace is kept in the .kavot-conflicts folder.</p>
          {comparison.diff === null ? <p className="settings-hint">No text comparison for this file type.</p> : <pre>{comparison.diff || 'Same text; the files changed separately.'}</pre>}
          <div className="form-actions">{[['keep_local', 'Keep mine'], ['keep_remote', 'Keep the cloud version'], ['keep_both', 'Keep both']].map(([choice, label]) => <button className="button button-small" key={choice} disabled={busy} onClick={() => void run(() => resolve(choice))}>{label}</button>)}</div>
        </div>}
      </article>}

      {connected && <SyncActivity running={!!workspace?.running} progress={progress} phaseLabel={phaseLabels[progress?.phase || 'scan'] || 'Syncing…'}
        lastSync={workspace?.last_sync ?? null} revision={workspace?.activity_revision ?? 0}/>}

      {connected && <details className="settings-card storage-disclosure storage-files">
        <summary><strong>Synced files</strong><span>Search the cloud copy and restore an earlier version of a file</span></summary>
        {!filesLoaded ? <p>{loading ? 'Loading files…' : 'The file list could not be loaded.'}</p> : !resources.length ? <p className="storage-empty">No files in the cloud yet.</p> : <><div className="storage-files-tools"><input type="search" aria-label="Search synced files" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by name or folder"/><button className="button button-small" disabled={busy} onClick={() => void run(list)}>Refresh</button></div><div className="cloud-files-table"><table>
          <thead><tr><th scope="col">File</th><th scope="col">Size</th><th scope="col">Modified</th><th scope="col"><span className="sr-only">History</span></th></tr></thead>
          <tbody>{visibleResources.map(item => <Fragment key={item.id}><tr><td>{item.path || item.name}</td><td>{bytes(item.size)}</td><td>{item.updated_at ? when(item.updated_at) : '—'}</td><td><button className="button button-small" disabled={busy} aria-expanded={history?.id === item.id} onClick={() => void run(() => openHistory(item))}>Versions</button></td></tr>
            {history?.id === item.id && <tr className="cloud-file-history"><td colSpan={4}>{history.revisions.length ? <ol>{history.revisions.map(revision => <li key={revision.id}><span><strong>Version {revision.version}</strong> · {when(revision.created_at)} · {bytes(revision.size)}</span>{revision.current ? <span className="storage-badge is-connected">Current</span> : <button className="button button-small" disabled={busy} onClick={() => void run(() => restoreRevision(revision))}>Restore</button>}</li>)}</ol> : <p>No earlier versions.</p>}</td></tr>}
          </Fragment>)}</tbody>
        </table>{!visibleResources.length && <p className="storage-empty">No file matches this search.</p>}</div></>}
      </details>}

      <details className="settings-card storage-disclosure">
        <summary><strong>Folder and advanced options</strong><span>Where the folder lives on this device{connected ? ', and starting the cloud over' : ''}</span></summary>
        {localStorage}
        {connected && <div className="storage-reset" aria-label="Reset the cloud"><h4>Start the cloud over from this device</h4><p>Permanently deletes the synced cloud files and their versions, then uploads this folder. Backups are not affected.</p>
          {!resetOpen ? <button className="button button-small" disabled={busy || workspace?.running} onClick={() => setResetOpen(true)}>Reset the cloud…</button> : <div><label><input type="checkbox" checked={resetConfirmed} onChange={event => setResetConfirmed(event.target.checked)}/> Replace the cloud with this folder. Close Kavot on my other devices first.</label><div className="form-actions"><button className="button button-small" disabled={busy} onClick={() => { setResetOpen(false); setResetConfirmed(false); }}>Cancel</button><button className="button button-small" disabled={busy || workspace?.running || !resetConfirmed} onClick={() => void run(async () => {
            const result = await cloud('/workspace/reset', {confirmation: 'replace-cloud-with-local'});
            setResetOpen(false); setResetConfirmed(false); setComparison(null); setConflictPath('');
            await refreshStatus(); await list();
            setMessage(result.summary.errors.length ? `Cloud reset; ${result.summary.errors.length} transfer(s) to retry.` : `Cloud reset from this folder · ${result.summary.uploaded} file(s) uploaded.`);
          })}>Delete the cloud copy and upload this folder</button></div></div>}
        </div>}
      </details>
    </section>
  </div>;
}
