import { api, pendingApiWrites } from '../services/api';
import { editorSession } from './editorSession';
import { noteTitleTimers, workspaceMarkdownTimers } from './state';
import { hasCanvasDrafts } from '../features/documents/canvas';
import { hasCollectionDrafts } from '../features/collections/noteEditor';
import { refreshOpenCloudResources } from '../features/documents/workspace';
import { captureMarkdownPositions } from '../features/documents/live-editor';

/** Keep received files visible without remounting a form while it is being edited. */
export function startCloudRefresh(runtime: {refreshData: () => Promise<void>; render: () => void}) {
  let applied: number | undefined;
  let polling = false;
  let stopped = false;
  let editVersion = 0;
  let connected = false;
  let latest: {running: boolean; local_revision?: number} | undefined;
  let controller: AbortController | undefined;
  let reconnect: number | undefined;
  let watchdog: number | undefined;
  const edited = () => { editVersion++; };
  const editing = () => (document.activeElement?.matches('input, textarea, select, [contenteditable="true"]')
      && !document.activeElement?.closest('.note-pane, .reader-note-pane, [data-canvas-path]'))
    || [...document.querySelectorAll('[role="dialog"]')].some(dialog => dialog.getClientRects().length > 0)
    || document.querySelector('[data-state="pending"], [data-state="saving"], [data-state="error"]')
    || pendingApiWrites || hasCanvasDrafts() || hasCollectionDrafts()
    || noteTitleTimers.size || workspaceMarkdownTimers.size
    || editorSession.noteAutosaveTimer || editorSession.secondaryNoteAutosaveTimer
    || editorSession.readerAutosaveTimer || editorSession.pendingReaderSave;
  const poll = async () => {
    if (polling || stopped || document.hidden) return;
    polling = true;
    try {
      const status = latest;
      if (!status) return;
      const revision = status.local_revision;
      if (revision === undefined) return;
      // A nonzero revision on the first poll may have arrived during startup.
      applied ??= 0;
      if (status.running || revision === applied || editing()) return;
      const before = editVersion;
      await runtime.refreshData();
      if (stopped || before !== editVersion || editing()) return;
      await refreshOpenCloudResources(() => !stopped && before === editVersion && !editing());
      if (stopped || before !== editVersion || editing() || latest?.running) return;
      const restorePositions = captureMarkdownPositions();
      runtime.render();
      restorePositions();
      applied = revision;
    } catch {
      // Keep the current view on network failure and retry on the next poll.
    } finally { polling = false; }
  };
  const receive = (status: {running: boolean; local_revision?: number}) => { latest = status; void poll(); };
  const fallback = async () => {
    if (stopped || connected) return;
    try {
      const status = await api('/cloud-sync/workspace/status', {headers: {'X-Kavot-Local': '1'}});
      if (!connected && !stopped) receive(status);
    }
    catch { /* Preserve the current view while offline. */ }
  };
  const connect = async () => {
    if (stopped) return;
    controller = new AbortController();
    const current = controller;
    const alive = () => {
      window.clearTimeout(watchdog);
      watchdog = window.setTimeout(() => current.abort(), 25000);
    };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      alive();
      const response = await fetch('/api/cloud-sync/workspace/events', {
        headers: {'X-Kavot-Local': '1'}, signal: current.signal, cache: 'no-store',
      });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body)
        throw new Error('Event stream unavailable');
      connected = true;
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!stopped) {
        const {value, done} = await reader.read();
        if (done) break;
        alive();
        buffer += decoder.decode(value, {stream: true});
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).replace(/\r$/, '');
          buffer = buffer.slice(end + 1);
          if (line.startsWith('data:')) {
            const status = JSON.parse(line.slice(5));
            if (typeof status.running === 'boolean' && Number.isSafeInteger(status.local_revision)) receive(status);
          }
        }
        if (buffer.length > 65536) throw new Error('Invalid event frame');
      }
    } catch { /* Reconnect with the same local-only authentication headers. */ }
    finally {
      connected = false;
      current.abort();
      await reader?.cancel().catch(() => {});
      window.clearTimeout(watchdog);
      if (!stopped) { void fallback(); reconnect = window.setTimeout(() => void connect(), 2000); }
    }
  };
  document.addEventListener('input', edited, true);
  document.addEventListener('change', edited, true);
  document.addEventListener('visibilitychange', poll);
  // Retry deferred renders without network polling while SSE is connected.
  const timer = window.setInterval(() => void poll(), 250);
  const fallbackTimer = window.setInterval(() => void fallback(), 10000);
  void connect();
  void fallback();
  return () => {
    stopped = true;
    controller?.abort();
    window.clearTimeout(reconnect);
    window.clearTimeout(watchdog);
    window.clearInterval(fallbackTimer);
    window.clearInterval(timer);
    document.removeEventListener('input', edited, true);
    document.removeEventListener('change', edited, true);
    document.removeEventListener('visibilitychange', poll);
  };
}
