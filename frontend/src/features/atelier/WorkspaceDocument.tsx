import { useEffect, useState } from 'react';
import { toast } from '../../app/navigation';
import { Icon } from '../../components/Icon';
import { api } from '../../services/api';
import { PdfPages, Preview, type DocumentPreview } from './FilesPanel';
import '../../styles/features/atelier.css';

/** A Word, Excel, PowerPoint, CSV or PDF file of the workspace, previewed in the editor. */
export function WorkspaceDocument({ path, url }: { path: string; url: string }) {
  const [preview, setPreview] = useState<DocumentPreview | null>(null);
  const [error, setError] = useState('');
  const pdf = /\.pdf$/i.test(path);
  useEffect(() => {
    if (pdf) return;
    let alive = true;
    setPreview(null); setError('');
    api<DocumentPreview>(`/atelier/workspace/preview?path=${encodeURIComponent(path)}`)
      .then(result => { if (alive) setPreview(result); }).catch(reason => { if (alive) setError(reason.message); });
    return () => { alive = false; };
  }, [path]);
  const open = () => api('/atelier/workspace/open', { method: 'POST', body: JSON.stringify({ path }) }).catch(reason => toast(reason.message, 'error'));
  return <div className="atelier-view atelier-document">
    <header className="atelier-viewer-head">
      <code title={path}>{path.split('/').pop()}</code>
      <div className="atelier-viewer-actions"><button className="button button-small button-primary" onClick={() => void open()} title="Open with the app of this kind of file"><Icon name="arrow" size={12}/> Open</button></div>
    </header>
    <div className="atelier-code">
      {pdf ? <PdfPages url={url}/> : error ? <div className="atelier-empty"><p>{error}</p><button className="button" onClick={() => void open()}>Open with its app</button></div>
        : preview ? <Preview preview={preview}/> : <p className="atelier-empty">Reading the document…</p>}
    </div>
  </div>;
}
