import { useEffect, useState } from 'react';
import { api } from '../services/api';

type SyncPass = {
  id: number;
  started_at: number;
  finished_at: number;
  duration_ms: number | null;
  repeats: number;
  uploaded: number;
  downloaded: number;
  deleted_local: number;
  deleted_remote: number;
  conflict_count: number;
  error_count: number;
  errors: {path: string; detail: string}[];
  error: string | null;
};

type SyncEvent = {id: number; at: number; kind: string; path: string; size: number | null; detail: string | null};

type Progress = {phase: string; path: string | null; completed: number; total: number} | null | undefined;

const kinds: Record<string, [string, string]> = {
  upload: ['↑', 'Sent to the cloud'],
  download: ['↓', 'Received from the cloud'],
  deleted_local: ['✕', 'Deleted here (removed in the cloud)'],
  deleted_remote: ['✕', 'Deleted from the cloud (removed here)'],
  conflict: ['!', 'Conflict'],
};

function ago(timestamp: number, now: number) {
  const seconds = Math.max(0, Math.round(now / 1000 - timestamp));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return new Date(timestamp * 1000).toLocaleString('en-US', {dateStyle: 'medium', timeStyle: 'short'});
}

const exact = (timestamp: number) => new Date(timestamp * 1000).toLocaleString('en-US', {dateStyle: 'medium', timeStyle: 'medium'});

function duration(ms: number | null) {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toLocaleString('en-US', {maximumFractionDigits: 1})} s`;
  return `${Math.floor(ms / 60000)} min ${Math.round(ms % 60000 / 1000)} s`;
}

function size(value: number | null) {
  if (value === null) return '—';
  const unit = value >= 1024 ** 3 ? 3 : value >= 1024 ** 2 ? 2 : value >= 1024 ? 1 : 0;
  return `${(value / 1024 ** unit).toLocaleString('en-US', {maximumFractionDigits: 1})} ${['B', 'KB', 'MB', 'GB'][unit]}`;
}

function counts(item: SyncPass) {
  return [
    [item.uploaded, '↑', 'sent'],
    [item.downloaded, '↓', 'received'],
    [item.deleted_local, '✕', 'deleted here'],
    [item.deleted_remote, '✕', 'deleted in the cloud'],
    [item.conflict_count, '!', item.conflict_count > 1 ? 'conflicts' : 'conflict'],
    [item.error_count, '!', item.error_count > 1 ? 'errors' : 'error'],
  ].filter(([count]) => count) as [number, string, string][];
}

/** What sync did recently on this device, refreshed as soon as a pass stores something new. */
export function SyncActivity({ running, progress, phaseLabel, lastSync, revision }: {
  running: boolean; progress: Progress; phaseLabel: string; lastSync: number | null; revision: number;
}) {
  const [activity, setActivity] = useState<{passes: SyncPass[]; events: SyncEvent[]} | null>(null);
  const [error, setError] = useState('');
  const now = Date.now();

  useEffect(() => {
    let current = true;
    api('/cloud-sync/workspace/activity', {headers: {'X-Kavot-Local': '1'}})
      .then(result => { if (current) { setActivity(result); setError(''); } })
      .catch(reason => { if (current) setError((reason as Error).message); });
    return () => { current = false; };
  }, [revision]);

  const passes = activity?.passes || [];
  const events = activity?.events || [];
  return <details className="settings-card storage-disclosure sync-activity" open>
    <summary><strong>Sync activity</strong><span>What sync recently sent, received and deleted on this device</span></summary>

    <div className={`sync-activity-now${running ? ' is-running' : ''}`} role="status" aria-live="polite">
      {running ? <>
        <strong>Now · {phaseLabel}</strong>
        <span>{progress?.total ? `${progress.completed} / ${progress.total} files` : 'Preparing…'}{progress?.path ? <> · <code>{progress.path}</code></> : null}</span>
      </> : <>
        <strong>Idle</strong>
        <span>Watching this folder and the cloud for changes · {lastSync ? `last check ${ago(lastSync, now)}` : 'no check yet'}. Checks that find nothing to change are not listed below.</span>
      </>}
    </div>

    {error && <p className="storage-notice">{error}</p>}

    <h4 className="sync-activity-heading">Recent syncs</h4>
    {!activity ? <p>Loading…</p> : !passes.length ? <p className="storage-empty">No sync has changed anything on this device yet.</p> : <ol className="sync-activity-passes">
      {passes.map(item => {
        const changes = counts(item);
        return <li key={item.id} className={item.error || item.error_count ? 'has-error' : ''}>
          <div className="sync-activity-pass-head">
            <time dateTime={new Date(item.finished_at * 1000).toISOString()} title={exact(item.finished_at)}>{ago(item.finished_at, now)}</time>
            <span className="sync-activity-duration">took {duration(item.duration_ms)}</span>
            {item.repeats > 0 && <span className="sync-activity-repeat" title={`First at ${exact(item.started_at)}`}>repeated {item.repeats + 1}×</span>}
          </div>
          <div className="sync-activity-counts">
            {item.error ? <span className="sync-activity-chip is-error">Failed: {item.error}</span>
              : changes.map(([count, icon, label]) => <span key={label} className={`sync-activity-chip${label.includes('error') || label.includes('conflict') ? ' is-error' : ''}`}><b aria-hidden="true">{icon}</b> {count} {label}</span>)}
          </div>
          {!!item.errors.length && <details className="storage-activity"><summary>Show the files that failed</summary><ul>{item.errors.map(entry => <li key={`${entry.path}:${entry.detail}`}><strong>{entry.path}</strong> — {entry.detail}</li>)}</ul></details>}
        </li>;
      })}
    </ol>}

    <h4 className="sync-activity-heading">Recent files</h4>
    {!activity ? null : !events.length ? <p className="storage-empty">No file has been synced yet.</p> : <div className="cloud-files-table"><table>
      <thead><tr><th scope="col">File</th><th scope="col">What happened</th><th scope="col">When</th><th scope="col">Size</th></tr></thead>
      <tbody>{events.map(event => {
        const [icon, label] = kinds[event.kind] || ['·', event.kind];
        return <tr key={event.id} className={`is-${event.kind}`}>
          <td>{event.path}</td>
          <td><span className="sync-activity-kind"><b aria-hidden="true">{icon}</b> {label}</span></td>
          <td title={exact(event.at)}>{ago(event.at, now)}</td>
          <td>{size(event.size)}</td>
        </tr>;
      })}</tbody>
    </table></div>}
  </details>;
}
