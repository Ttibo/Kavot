import { useEffect, useRef, useState } from 'react';
import { toast } from '../../app/navigation';
import { Icon } from '../../components/Icon';
import { api } from '../../services/api';
import { loadPdfEngine } from './pdf/engine';
import '../../styles/features/atelier.css';

type DocumentBlock = { type: 'heading' | 'paragraph' | 'item'; level?: number; text: string } | { type: 'table'; rows: string[][] };
type DocumentPreview =
  | { kind: 'document'; blocks: DocumentBlock[]; truncated?: boolean }
  | { kind: 'spreadsheet'; sheets: { name: string; rows: string[][]; truncated?: boolean }[] }
  | { kind: 'slides'; slides: string[][]; truncated?: boolean };

function Sheet({ rows, plain = false }: { rows: string[][]; plain?: boolean }) {
  const width = Math.max(0, ...rows.map(row => row.length));
  if (!rows.length) return <p className="atelier-empty">Empty sheet.</p>;
  // A table of a document reads as a table, without the letters and numbers of a spreadsheet.
  if (plain) return <div className="atelier-sheet plain"><table><tbody>{rows.map((row, index) => <tr key={index}>{Array.from({ length: width }, (_, column) => index === 0
    ? <th key={column}>{row[column] ?? ''}</th> : <td key={column}>{row[column] ?? ''}</td>)}</tr>)}</tbody></table></div>;
  return <div className="atelier-sheet"><table><thead><tr><th/>{Array.from({ length: width }, (_, index) => <th key={index}>{index < 26 ? String.fromCharCode(65 + index) : index + 1}</th>)}</tr></thead>
    <tbody>{rows.map((row, index) => <tr key={index}><th>{index + 1}</th>{Array.from({ length: width }, (_, column) => <td key={column}>{row[column] ?? ''}</td>)}</tr>)}</tbody></table></div>;
}

/** A PDF drawn page by page with the app's PDF engine (the desktop window shows no PDF in a frame). */
function PdfPages({ url }: { url: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ pages: number; shown: number; error?: string }>({ pages: 0, shown: 0 });
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let cancelled = false;
    let task: { promise: Promise<any>; destroy: () => Promise<void> } | undefined;
    container.replaceChildren();
    setState({ pages: 0, shown: 0 });
    void (async () => {
      try {
        const { getDocument } = await loadPdfEngine();
        task = getDocument({ url });
        const pdf = await task.promise;
        if (cancelled) return;
        const limit = Math.min(pdf.numPages, 30);
        setState({ pages: pdf.numPages, shown: limit });
        const width = Math.max(320, container.clientWidth - 32), ratio = window.devicePixelRatio || 1;
        for (let number = 1; number <= limit && !cancelled; number++) {
          const page = await pdf.getPage(number);
          const viewport = page.getViewport({ scale: Math.min(2.5, width / page.getViewport({ scale: 1 }).width) * ratio });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          canvas.style.width = `${Math.ceil(viewport.width / ratio)}px`;
          container.append(canvas);
          await page.render({ canvas, viewport }).promise;
        }
      } catch (error) {
        if (!cancelled) setState(current => ({ ...current, error: (error as Error).message || 'This PDF could not be read.' }));
      }
    })();
    return () => { cancelled = true; void task?.destroy(); };
  }, [url]);
  return <div className="atelier-pdf">
    {state.error && <p className="atelier-warning">{state.error}</p>}
    <div ref={host} className="atelier-pdf-pages"/>
    {state.pages > state.shown && <p className="atelier-muted">First {state.shown} of {state.pages} pages. Open the file to read everything.</p>}
  </div>;
}

function Preview({ preview }: { preview: DocumentPreview }) {
  const [sheet, setSheet] = useState(0);
  if (preview.kind === 'spreadsheet') {
    const current = preview.sheets[Math.min(sheet, preview.sheets.length - 1)];
    return <div className="atelier-preview spreadsheet">
      {preview.sheets.length > 1 && <nav className="atelier-sheet-tabs">{preview.sheets.map((item, index) => <button key={item.name} className={index === sheet ? 'active' : ''} onClick={() => setSheet(index)}>{item.name}</button>)}</nav>}
      {current ? <Sheet rows={current.rows}/> : <p className="atelier-empty">No sheet.</p>}
      {current?.truncated && <p className="atelier-muted">First rows only. Open the file to see everything.</p>}
    </div>;
  }
  if (preview.kind === 'slides') return <div className="atelier-preview slides">{preview.slides.map((lines, index) => <article key={index} className="atelier-slide">
    <small>Slide {index + 1}</small>{lines.length ? lines.map((line, row) => row === 0 ? <h3 key={row}>{line}</h3> : <p key={row}>{line}</p>) : <p className="atelier-muted">No text</p>}</article>)}</div>;
  return <article className="atelier-preview document">{preview.blocks.map((block, index) => block.type === 'table'
    ? <Sheet key={index} rows={block.rows} plain/>
    : block.type === 'heading' ? (block.level === 1 ? <h1 key={index}>{block.text}</h1> : block.level === 2 ? <h2 key={index}>{block.text}</h2> : <h3 key={index}>{block.text}</h3>)
    : block.type === 'item' ? <p key={index} className="atelier-preview-item">• {block.text}</p> : <p key={index}>{block.text}</p>)}
    {preview.truncated && <p className="atelier-muted">Long document: only the beginning is shown.</p>}</article>;
}

/** A Word, Excel, PowerPoint, CSV or PDF file of the workspace, previewed in the editor. */
export function WorkspaceDocument({ path, url }: { path: string; url: string }) {
  const [preview, setPreview] = useState<DocumentPreview | null>(null);
  const [error, setError] = useState('');
  const pdf = /\.pdf$/i.test(path);
  useEffect(() => {
    if (pdf) return;
    let alive = true;
    setPreview(null); setError('');
    api<DocumentPreview>(`/workspace/preview?path=${encodeURIComponent(path)}`)
      .then(result => { if (alive) setPreview(result); }).catch(reason => { if (alive) setError(reason.message); });
    return () => { alive = false; };
  }, [path]);
  const open = () => api('/workspace/open', { method: 'POST', body: JSON.stringify({ path }) }).catch(reason => toast(reason.message, 'error'));
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
