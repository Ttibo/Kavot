import { FormEvent, useState } from 'react';
import { useRuntime } from '../app/runtime';
import { useZotero } from '../features/library/useZotero';
import { ZoteroSyncProgress } from '../features/library/ZoteroSyncProgress';
import { ZoteroContentSummary } from '../features/library/ZoteroContentSummary';
import { ZoteroPdfSummary } from '../features/library/ZoteroPdfSummary';

/** Zotero connection and import, part of the Papers plugin. */
export function ZoteroSettings() {
  const runtime = useRuntime();
  const [zoteroKey, setZoteroKey] = useState('');
  const zoteroSync = useZotero();
  const zotero = zoteroSync.connection;
  async function saveZotero(event: FormEvent) {
    event.preventDefault();
    try { await zoteroSync.connect(zoteroKey); setZoteroKey(''); runtime.toast('Zotero connected'); }
    catch (reason) { runtime.toast((reason as Error).message, 'error'); }
  }
  return <article className="settings-card integration-settings-card"><div className="integration-brand"><span>Z</span><div><h3>Zotero</h3><p>Import your personal Zotero library with its folders, references, PDFs and notes.</p></div><i className={zotero?.configured ? 'connected' : ''}>{zotero?.configured ? 'Connected' : 'Not connected'}</i></div><form onSubmit={saveZotero}><label><span>Private API key</span><input type="password" autoComplete="off" required disabled={zoteroSync.connecting || zoteroSync.syncing} value={zoteroKey} onChange={event => setZoteroKey(event.target.value)} placeholder={zotero?.api_key_hint || 'Paste your Zotero API key'}/><small>Create a key that grants access to the library and files in your Zotero account. It stays in the local settings, outside the workspace folder.</small></label><button className="button button-primary" disabled={zoteroSync.connecting || zoteroSync.syncing || !zoteroKey.trim()}>{zoteroSync.connecting ? 'Checking…' : zotero?.configured ? 'Replace the key' : 'Connect Zotero'}</button></form>{zotero?.configured && <div className="configuration-state ready"><span/><strong>Personal library {zotero.user_id} · {zotero.api_key_hint}</strong></div>}<div className="zotero-import-actions"><span className="zotero-sync-trigger"><button className="button button-primary" disabled={!zotero?.configured || zoteroSync.loading || zoteroSync.connecting || zoteroSync.syncing} onClick={() => void zoteroSync.synchronize()}>{zoteroSync.syncing ? 'Synchronizing Zotero…' : 'Import / sync Zotero'}</button>{zoteroSync.syncing && <span className="sync-spinner zotero-sync-spinner" aria-label="Synchronizing Zotero" role="img"/>}</span>{!zotero?.configured && <small>{zoteroSync.loading ? 'Checking connection…' : 'Connect your Zotero account above to enable import.'}</small>}<p>Imports folders and subfolders, all collection memberships, references and available PDFs. Zotero notes are added directly to each article’s Kavot note; standalone notes appear in Notes. Repeat imports preserve your writing and existing PDFs.</p></div>{zoteroSync.syncing && <ZoteroSyncProgress progress={zoteroSync.progress} warning={zoteroSync.connectionWarning}/>}{zoteroSync.result && !zoteroSync.syncing && <div className="zotero-import-result" role="status"><strong>{zoteroSync.result.created} added · {zoteroSync.result.updated} updated · {zoteroSync.result.skipped} skipped</strong><span>{zoteroSync.result.total === 0 ? 'No bibliographic references found. Imported folders and standalone notes remain available.' : 'References are available in the article library.'}</span><ZoteroContentSummary result={zoteroSync.result}/><ZoteroPdfSummary result={zoteroSync.result.pdfs}/></div>}{zoteroSync.error && <div className="integration-error" role="alert">{zoteroSync.error}{!zotero && <button className="button button-small" onClick={() => void zoteroSync.reload()}>Try again</button>}</div>}</article>;
}
