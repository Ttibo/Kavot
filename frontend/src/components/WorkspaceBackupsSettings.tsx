import { useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { useRuntime } from '../app/runtime';
import '../styles/workspace-backups.css';

type Kind = 'auto' | 'manual' | 'uploaded';
type LocalBackup = { id: string; size: number; created_at: number; version: number; kind: Kind; label: string | null; files: number | null };
type OnlineBackup = { id: string; name: string; size: number; created_at: number; kind: Kind; local_id: string | null };
type Schedule = { schedule: 'off' | 'daily' | 'weekly'; online: boolean; last_error: string | null };
/** One backup, wherever its copies are. */
type Backup = { key: string; created_at: number; kind: Kind; label: string | null; size: number; files: number | null;
  version: number | null; local?: LocalBackup; online?: OnlineBackup };
type Place = 'all' | 'local' | 'online';

const localHeader = { 'X-Kavot-Local': '1' };
const cloud = <T,>(path: string, options: RequestInit = {}) =>
  api<T>(`/cloud-sync/backups${path}`, { ...options, headers: { ...localHeader, ...options.headers } });
const size = (bytes: number) => `${(bytes / (bytes >= 1024 ** 2 ? 1024 ** 2 : 1024)).toLocaleString('en-US', { maximumFractionDigits: 1 })} ${bytes >= 1024 ** 2 ? 'MB' : 'KB'}`;
const time = (timestamp: number) => new Date(timestamp * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
const kindLabel: Record<Kind, string> = { auto: 'Automatic', manual: 'Manual', uploaded: 'Imported' };

function dayLabel(timestamp: number) {
  const day = new Date(timestamp * 1000); day.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - day.getTime()) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return day.toLocaleDateString('en-US', { weekday: days < 7 ? 'long' : undefined, day: 'numeric', month: 'long', year: day.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function byDay(items: Backup[]) {
  const groups: { label: string; items: Backup[] }[] = [];
  for (const item of items) {
    const label = dayLabel(item.created_at);
    if (groups.at(-1)?.label === label) groups.at(-1)!.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

/** Merge the local list and its online copies into one list of backups. */
function merge(local: LocalBackup[], online: OnlineBackup[]): Backup[] {
  const result = new Map<string, Backup>();
  for (const item of local) result.set(item.id, { key: item.id, created_at: item.created_at, kind: item.kind, label: item.label,
    size: item.size, files: item.files, version: item.version, local: item });
  for (const item of online) {
    const match = item.local_id ? result.get(item.local_id) : undefined;
    if (match) match.online = item;
    else result.set('online:' + item.id, { key: 'online:' + item.id, created_at: item.created_at, kind: item.kind,
      label: item.kind === 'uploaded' ? item.name : null, size: item.size, files: null, version: null, online: item });
  }
  return [...result.values()].sort((a, b) => b.created_at - a.created_at);
}

export function WorkspaceBackupsSettings() {
  const runtime = useRuntime();
  const uploadInput = useRef<HTMLInputElement>(null);
  const [local, setLocal] = useState<LocalBackup[]>([]);
  const [online, setOnline] = useState<OnlineBackup[]>([]);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [label, setLabel] = useState('');
  const [place, setPlace] = useState<Place>('all');
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refreshLocal = async () => setLocal(await api<LocalBackup[]>('/settings/backups'));
  async function refreshOnline() {
    const status = await api<{ connected: boolean }>('/cloud-sync/status', { headers: localHeader });
    setConnected(status.connected);
    setOnline(status.connected ? await cloud<OnlineBackup[]>('') : []);
  }
  const refresh = () => Promise.all([refreshLocal(), refreshOnline()]);

  useEffect(() => {
    void Promise.all([refresh(), api<Schedule>('/settings/backup-schedule').then(setSchedule)])
      .catch(reason => setError((reason as Error).message)).finally(() => setLoading(false));
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  const updateSchedule = (change: Partial<Schedule>) => run(async () => {
    setSchedule(await api<Schedule>('/settings/backup-schedule', { method: 'PATCH', body: JSON.stringify(change) }));
  });
  const keepOnline = !!schedule?.online && connected;

  function openRestored(result: { path: string }) {
    runtime.toast('Backup restored in ' + result.path);
    window.dispatchEvent(new Event('kavot:storage-updated'));
    window.location.reload();
  }

  async function downloadOnline(item: OnlineBackup) {
    const response = await fetch(`/api/cloud-sync/backups/${item.id}/download`, { headers: localHeader });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.detail || `Download failed (${response.status})`);
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url; link.download = item.name; document.body.append(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  const backupNow = () => run(async () => {
    const created = await api<LocalBackup>('/settings/backups', { method: 'POST', body: JSON.stringify({ label: label || null }) });
    if (keepOnline) await cloud(`/from-local/${created.id}`, { method: 'POST' });
    setLabel(''); await refresh();
    runtime.toast(keepOnline ? 'Backup saved on this device and online' : 'Backup saved on this device');
  });

  const restore = (item: Backup) => {
    if (!window.confirm('Open this backup as a copy in a new folder? Your current folder is not changed.')) return;
    void run(async () => openRestored(item.local
      ? await api<{ path: string }>(`/settings/backups/${item.local.id}/restore`, { method: 'POST' })
      : await cloud<{ path: string }>(`/${item.online!.id}/restore`, { method: 'POST' })));
  };
  const remove = (item: Backup, where: 'local' | 'online') => {
    const both = item.local && item.online;
    const text = where === 'local'
      ? `Delete this backup from this device?${both ? ' The online copy stays.' : ' This cannot be undone.'}`
      : `Delete the online copy of this backup?${both ? ' The copy on this device stays.' : ' This cannot be undone.'}`;
    if (!window.confirm(text)) return;
    void run(async () => {
      if (where === 'local') await api(`/settings/backups/${item.local!.id}`, { method: 'DELETE' });
      else await cloud(`/${item.online!.id}`, { method: 'DELETE' });
      await refresh();
    });
  };

  const backups = merge(local, online);
  const shown = backups.filter(item => place === 'all' || (place === 'local' ? item.local : item.online));
  const latest = backups[0];
  const counts = { all: backups.length, local: backups.filter(item => item.local).length, online: backups.filter(item => item.online).length };

  return <section id="storage-backups" className="storage-block workspace-backups" aria-labelledby="storage-backups-title">
    <h3 id="storage-backups-title" className="storage-block-title">2 · Backups</h3>

    <article className="settings-card backup-plan" aria-label="Backup settings">
      <div className="backup-plan-grid">
        <label>Automatic backup
          <select value={schedule?.schedule || 'daily'} disabled={busy || !schedule} onChange={event => void updateSchedule({ schedule: event.target.value as Schedule['schedule'] })}>
            <option value="daily">Every day</option><option value="weekly">Every week</option><option value="off">Off</option>
          </select>
        </label>
        <fieldset className="backup-where"><legend>Keep backups</legend>
          <label><input type="radio" name="backup-where" checked={!schedule?.online} disabled={busy || !schedule} onChange={() => void updateSchedule({ online: false })}/> On this device</label>
          <label><input type="radio" name="backup-where" checked={!!schedule?.online} disabled={busy || !schedule || !connected} onChange={() => void updateSchedule({ online: true })}/> On this device and online{!connected && <small> · link Kavot Cloud first</small>}</label>
        </fieldset>
      </div>
      <p className="settings-hint">A backup is made only when something changed. Kept: one per day for a week, one per week for a month, one per month for a year. Manual backups are kept until you delete them.{latest ? ` Latest: ${dayLabel(latest.created_at).toLowerCase()} at ${time(latest.created_at)}.` : ''}</p>
      {schedule?.online && !connected && <p className="settings-hint">Online copies are paused until this device is linked to Kavot Cloud again.</p>}
      {schedule?.last_error && <p role="alert" className="backup-error">Last automatic backup failed: {schedule.last_error}</p>}
      <div className="backup-actions">
        <input className="backup-label-input" value={label} maxLength={120} placeholder="Name (optional), e.g. Before migration" aria-label="Backup name" onChange={event => setLabel(event.target.value)}/>
        <button className="button button-primary" disabled={busy} onClick={() => void backupNow()}>{busy ? 'Working…' : 'Back up now'}</button>
      </div>
    </article>

    <article className="settings-card" aria-label="All backups">
      <div className="backup-list-heading">
        <div className="backup-filter" role="group" aria-label="Show backups">
          {(['all', 'local', 'online'] as Place[]).map(value => <button key={value} className={place === value ? 'is-active' : ''} aria-pressed={place === value} onClick={() => setPlace(value)}>
            {{ all: 'All', local: 'On this device', online: 'Online' }[value]} <span>{counts[value]}</span></button>)}
        </div>
        {connected && <>
          <input ref={uploadInput} type="file" accept=".zip,application/zip" className="backup-upload-input" aria-label="Choose a Kavot backup ZIP" onChange={event => {
            const file = event.target.files?.[0]; if (!file) return;
            event.target.value = '';
            void run(async () => {
              const body = new FormData(); body.append('file', file);
              await cloud('/upload', { method: 'POST', body });
              await refreshOnline(); runtime.toast('ZIP imported online');
            });
          }}/>
          <button className="button button-small" disabled={busy} onClick={() => uploadInput.current?.click()}>Import a ZIP…</button>
        </>}
      </div>
      {loading ? <p>Loading backups…</p> : !shown.length ? <p className="settings-hint">{place === 'online' && !connected ? 'Link Kavot Cloud to keep backups online.' : 'No backups here yet.'}</p>
        : <div className="backup-list" role="region" aria-label="Backups" tabIndex={0}>
          {byDay(shown).map(group => <section key={group.label} className="backup-day"><h4>{group.label}</h4>
            {group.items.map(item => <div className="backup-row" key={item.key}>
              <div className="backup-info">
                <strong>{item.label || time(item.created_at)}</strong>
                <span>{item.label ? `${time(item.created_at)} · ` : ''}<span className={`backup-kind is-${item.kind}`}>{kindLabel[item.kind]}</span>{item.files != null ? ` · ${item.files} files` : ''} · {size(item.size)}</span>
              </div>
              <div className="backup-places" aria-label="Stored">
                {item.local && <span className="backup-place">This device</span>}
                {item.online && <span className="backup-place is-online">Online</span>}
              </div>
              <div className="backup-row-actions">
                <button className="button button-small" disabled={busy} onClick={() => restore(item)}>Restore</button>
                <details className="backup-more">
                  <summary className="button button-small" aria-label="More actions">⋯</summary>
                  <div className="backup-menu">
                    {item.local ? <a href={`/api/settings/backups/${item.local.id}/download`} download>Download ZIP</a>
                      : <button disabled={busy} onClick={() => void run(() => downloadOnline(item.online!))}>Download ZIP</button>}
                    {item.local && !item.online && connected && <button disabled={busy} onClick={() => void run(async () => { await cloud(`/from-local/${item.local!.id}`, { method: 'POST' }); await refreshOnline(); runtime.toast('Copied online'); })}>Also keep online</button>}
                    {item.local && <button className="is-danger" disabled={busy} onClick={() => remove(item, 'local')}>Delete from this device</button>}
                    {item.online && <button className="is-danger" disabled={busy} onClick={() => remove(item, 'online')}>Delete online copy</button>}
                  </div>
                </details>
              </div>
            </div>)}
          </section>)}
        </div>}
      {error && <p role="alert" className="backup-error">{error}</p>}
    </article>
  </section>;
}
