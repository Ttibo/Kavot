import type { ZoteroProgress } from './useZotero';

const steps = [
  ['connecting', 'Connection'], ['collections', 'Folders'], ['references', 'References'], ['notes', 'Notes'], ['pdfs', 'PDFs'], ['refreshing', 'Library'],
];
export function ZoteroSyncProgress({ progress, warning }: { progress: ZoteroProgress | null; warning: string }) {
  if (!progress) return null;
  const current = steps.findIndex(([phase]) => phase === progress.phase);
  const pdfs = progress.pdfs;
  return <section className="zotero-sync-progress" aria-label="Zotero synchronization progress" aria-busy="true">
    <ol>{steps.map(([phase, label], index) => <li key={phase} className={index < current ? 'complete' : index === current ? 'active' : ''} aria-current={index === current ? 'step' : undefined}><span aria-hidden="true">{index < current ? '✓' : index + 1}</span>{label}</li>)}</ol>
    <div role="status" aria-live="polite" aria-atomic="true"><strong>{progress.message}</strong>
      {progress.phase === 'references' && <p>Page {progress.page || 1} · {progress.completed || 0} references processed{progress.created !== undefined ? ` · ${progress.created} added · ${progress.updated || 0} updated` : ''}</p>}
      {progress.phase === 'collections' && <p>{progress.completed || 0} folders fetched</p>}
      {progress.phase === 'notes' && <p>{progress.completed || 0} / {progress.total || 0} notes processed</p>}
      {progress.phase === 'pdfs' && <><p>{progress.completed || 0} / {progress.total || 0} articles checked{pdfs ? ` · ${pdfs.downloaded} PDFs downloaded · ${pdfs.existing} already present · ${pdfs.failed + pdfs.unavailable} unavailable or failed` : ''}</p>{Boolean(progress.total) && <progress value={progress.completed || 0} max={progress.total} aria-label="PDF synchronization"/>}</>}
      {progress.title && <p className="zotero-current-article" title={progress.title}>{progress.title}</p>}
      {warning && <p className="integration-error">{warning}</p>}
    </div>
  </section>;
}
