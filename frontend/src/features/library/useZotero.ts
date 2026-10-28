import { useEffect, useSyncExternalStore } from 'react';
import { useRuntime } from '../../app/runtime';
import { api } from '../../services/api';

type Connection = { configured: boolean; api_key_hint: string; user_id?: number };
export type ZoteroPdfResult = { downloaded: number; existing: number; unavailable: number; failed: number; errors: { paper_id: number; title: string; message: string }[] };
export type ZoteroContentResult = { collections?: { total: number }; notes?: { imported: number; updated: number; existing: number; conflicts: number; errors: { note_id: number; title: string; message: string }[] } };
type SyncResult = ZoteroContentResult & { created: number; updated: number; skipped: number; total: number; pdfs?: ZoteroPdfResult };
export type ZoteroProgress = { phase: 'connecting' | 'collections' | 'references' | 'notes' | 'pdfs' | 'refreshing' | 'done'; message: string; page?: number; completed?: number; total?: number; title?: string; created?: number; updated?: number; pdfs?: ZoteroPdfResult };
type SyncJob = { id?: string; status: 'idle' | 'running' | 'completed' | 'failed'; progress?: ZoteroProgress; result?: SyncResult; error?: string };
type ZoteroState = { connection: Connection | null; loading: boolean; connecting: boolean; syncing: boolean; result: SyncResult | null; progress: ZoteroProgress | null; error: string; connectionWarning: string };
let state: ZoteroState = { connection: null, loading: false, connecting: false, syncing: false, result: null, progress: null, error: '', connectionWarning: '' };
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;
let monitoring: Promise<void> | null = null;
let revision = 0;
const snapshot = () => state;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function update(patch: Partial<ZoteroState>) { state = { ...state, ...patch }; listeners.forEach(listener => listener()); }
const delay = () => new Promise(resolve => setTimeout(resolve, 1000));
async function jobRequest(options: RequestInit = {}, background = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try { return await api<SyncJob>(`/integrations/zotero/sync${background ? '?background=true' : ''}`, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function monitor(initial: SyncJob, refresh: () => Promise<unknown>) {
  if (monitoring) return monitoring;
  update({ syncing: true, error: '', result: null, progress: initial.progress || null });
  monitoring = (async () => {
    let job = initial;
    try {
      while (job.status === 'running') {
        update({ progress: job.progress || null });
        await delay();
        try {
          const next = await jobRequest();
          if (next.id !== initial.id || next.status === 'idle') throw new Error('sync-interrupted');
          job = next;
          update({ connectionWarning: '' });
        } catch (reason) {
          if ((reason as Error).message === 'sync-interrupted') throw new Error('The server restarted or the workspace changed. Retry synchronization; references already imported are kept.');
          update({ connectionWarning: 'Connection interrupted. Reconnecting to the synchronization in progress…' });
        }
      }
      if (job.status === 'failed') throw new Error(job.error || 'Zotero synchronization failed');
      if (job.status !== 'completed' || !job.result) throw new Error('The server returned an invalid synchronization status. Restart Kavot and retry.');
      update({ progress: { phase: 'refreshing', message: 'Refreshing the article library…' } });
      try { await refresh(); }
      catch { update({ error: 'Zotero was synchronized, but the article list could not refresh. Reopen the library to see the imported references.' }); }
      update({ result: job.result, progress: { phase: 'done', message: 'Synchronization complete' } });
    } catch (reason) {
      update({ error: `${(reason as Error).message}. You can retry; references already imported will be updated without duplicates.` });
      try { await refresh(); } catch { /* Preserve the original error. */ }
    } finally { monitoring = null; update({ syncing: false, connectionWarning: '' }); }
  })();
  return monitoring;
}

async function load(refresh: () => Promise<unknown>) {
  if (loading) return loading;
  if (state.connecting || state.syncing) return;
  const started = revision;
  update({ loading: true });
  loading = (async () => {
    try {
      const connection = await api<Connection>('/integrations/zotero');
      if (started === revision) {
        update({ connection, error: '' });
        if (connection.configured) {
          const job = await jobRequest();
          if (started === revision && job.status === 'running') void monitor(job, refresh);
          else if (started === revision && job.status === 'failed') update({ error: job.error || 'The last Zotero sync failed. You can retry.' });
        }
      }
    } catch (reason) { if (started === revision) update({ error: (reason as Error).message }); }
    finally { loading = null; update({ loading: false }); }
  })();
  return loading;
}

async function connect(key: string) {
  if (state.connecting || state.syncing) return;
  revision += 1;
  update({ connecting: true, error: '', result: null, progress: null });
  try { update({ connection: await api<Connection>('/integrations/zotero', { method: 'PUT', body: JSON.stringify({ api_key: key }) }) }); }
  catch (reason) { update({ error: (reason as Error).message }); throw reason; }
  finally { update({ connecting: false }); }
}

async function synchronize(refresh: () => Promise<unknown>) {
  if (state.syncing || state.connecting || !state.connection?.configured) return;
  revision += 1;
  update({ syncing: true, error: '', result: null, connectionWarning: '', progress: { phase: 'connecting', message: 'Connecting to Zotero…' } });
  try {
    let job: SyncJob;
    try { job = await jobRequest({ method: 'POST' }, true); }
    catch (reason) {
      // A lost start response must not launch a second import.
      job = await jobRequest();
      if (!job.id || job.status !== 'running') throw reason;
    }
    await monitor(job, refresh);
  } catch (reason) { update({ syncing: false, error: `${(reason as Error).message}. You can retry synchronization.` }); }
}

export function useZotero() {
  const runtime = useRuntime();
  const current = useSyncExternalStore(subscribe, snapshot);
  const refresh = () => runtime.refreshData();
  useEffect(() => { if (!state.connection) void load(refresh); }, []);
  return { ...current, connect, reload: () => load(refresh), synchronize: () => synchronize(refresh) };
}
