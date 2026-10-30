import { useEffect, useRef, useState } from 'react';
import { toast } from '../../app/navigation';
import { Icon } from '../../components/Icon';
import { AgentMessageContent } from '../../components/AgentMessageContent';
import { loadPdfEngine } from '../documents/pdfEngine';
import { atelierApi, openInEditor, type Entry, type FileContent, type Folder } from './types';

function Tree({ projectId, folder, path, depth, selected, expanded, onToggle, onOpen }: {
  projectId: number; folder: Folder; path: string; depth: number; selected: string; expanded: Set<string>;
  onToggle: (path: string) => void; onOpen: (path: string) => void;
}) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    atelierApi<{ entries: Entry[] }>(projectId, `/folders/${folder.id}/tree?path=${encodeURIComponent(path)}`)
      .then(result => { if (alive) setEntries(result.entries); }).catch(reason => { if (alive) setError(reason.message); });
    return () => { alive = false; };
  }, [projectId, folder.id, path]);
  if (error) return <p className="atelier-tree-note" style={{ paddingLeft: 12 + depth * 14 }}>{error}</p>;
  if (!entries) return <p className="atelier-tree-note" style={{ paddingLeft: 12 + depth * 14 }}>Loading…</p>;
  return <ul role={depth ? 'group' : 'tree'} className="atelier-tree">{entries.map(entry => <li key={entry.path} role="treeitem" aria-expanded={entry.directory ? expanded.has(entry.path) : undefined} aria-selected={selected === entry.path}>
    <button className={`atelier-tree-row ${selected === entry.path ? 'active' : ''}`} style={{ paddingLeft: 8 + depth * 14 }}
      onClick={() => entry.directory ? onToggle(entry.path) : onOpen(entry.path)} title={entry.path}>
      <span className="atelier-tree-caret">{entry.directory ? (expanded.has(entry.path) ? '▾' : '▸') : ''}</span>
      {entry.directory ? <Icon name="folder" size={13}/> : <span className="atelier-tree-dot"/>}<span>{entry.name}</span>
    </button>
    {entry.directory && expanded.has(entry.path) && <Tree projectId={projectId} folder={folder} path={entry.path} depth={depth + 1} selected={selected} expanded={expanded} onToggle={onToggle} onOpen={onOpen}/>}
  </li>)}</ul>;
}

type DocumentBlock = { type: 'heading' | 'paragraph' | 'item'; level?: number; text: string } | { type: 'table'; rows: string[][] };
export type DocumentPreview =
  | { kind: 'document'; blocks: DocumentBlock[]; truncated?: boolean }
  | { kind: 'spreadsheet'; sheets: { name: string; rows: string[][]; truncated?: boolean }[] }
  | { kind: 'slides'; slides: string[][]; truncated?: boolean };
type Shown = { path: string; mode: 'text'; file: FileContent } | { path: string; mode: 'preview'; preview: DocumentPreview }
  | { path: string; mode: 'pdf' | 'image' } | { path: string; mode: 'markdown'; text: string } | { path: string; mode: 'none'; reason: string };

const extension = (path: string) => (path.match(/\.[^./]+$/)?.[0] || '').toLowerCase();
const PREVIEWED = new Set(['.docx', '.xlsx', '.xlsm', '.pptx', '.csv', '.tsv']);
const IMAGES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
// Opened with the system's app (Word, Excel, a PDF reader…), like code is opened in the editor.
const DOCUMENTS = new Set([...PREVIEWED, '.doc', '.odt', '.rtf', '.xls', '.ods', '.ppt', '.odp', '.pdf', ...IMAGES, '.svg', '.md', '.txt', '.json', '.ipynb', '.tex', '.bib', '.mp3', '.wav', '.mp4', '.mov', '.zip']);

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
export function PdfPages({ url }: { url: string }) {
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

export function Preview({ preview }: { preview: DocumentPreview }) {
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

export function FilesPanel({ projectId, folder, target, onShowInMap }: {
  projectId: number; folder: Folder; target?: { path: string; line?: number } | null; onShowInMap: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState<Shown | null>(null);
  const [line, setLine] = useState<number | undefined>();
  const [error, setError] = useState('');
  const viewer = useRef<HTMLDivElement>(null);
  const base = `/folders/${folder.id}`;
  const raw = (path: string) => `/api/atelier/projects/${projectId}${base}/raw?path=${encodeURIComponent(path)}`;
  async function open(path: string, at?: number) {
    setError('');
    const type = extension(path);
    try {
      if (PREVIEWED.has(type)) setShown({ path, mode: 'preview', preview: await atelierApi<DocumentPreview>(projectId, `${base}/preview?path=${encodeURIComponent(path)}`) });
      else if (type === '.pdf') setShown({ path, mode: 'pdf' });
      else if (IMAGES.has(type)) setShown({ path, mode: 'image' });
      else {
        const file = await atelierApi<FileContent>(projectId, `${base}/file?path=${encodeURIComponent(path)}`);
        setShown(file.binary ? { path, mode: 'none', reason: 'No preview for this kind of file.' }
          : type === '.md' || type === '.markdown' ? { path, mode: 'markdown', text: file.content || '' } : { path, mode: 'text', file });
      }
      setLine(at);
      // Reveal the file in the tree.
      const parts = path.split('/');
      setExpanded(current => new Set([...current, ...parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))]));
    } catch (reason) { setShown({ path, mode: 'none', reason: (reason as Error).message }); }
  }
  // A linked file opens at once; a folder waits for a choice in its tree.
  useEffect(() => { setShown(null); setExpanded(new Set()); if (folder.file) void open(folder.path.split(/[\\/]/).pop() || ''); }, [folder.id]);
  useEffect(() => { if (target?.path) void open(target.path, target.line); }, [target]);
  useEffect(() => {
    if (!line || !viewer.current) return;
    viewer.current.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: 'center' });
  }, [shown, line]);
  const toggle = (path: string) => setExpanded(current => { const next = new Set(current); next.has(path) ? next.delete(path) : next.add(path); return next; });
  const launch = (editor: 'vscode' | 'cursor' | 'system' | 'default') => openInEditor(projectId, folder.id, shown?.path || '', line || 1, editor).catch(reason => toast(reason.message, 'error'));
  const isDocument = shown ? DOCUMENTS.has(extension(shown.path)) : false;
  const isCode = folder.kind !== 'resources';
  const lines = shown?.mode === 'text' ? shown.file.content?.split('\n') || [] : [];
  return <div className={`atelier-files ${folder.file ? 'single' : ''}`}>
    {!folder.file && <nav className="atelier-files-tree" aria-label="Files"><Tree projectId={projectId} folder={folder} path="" depth={0} selected={shown?.path || ''} expanded={expanded} onToggle={toggle} onOpen={path => void open(path)}/></nav>}
    <section className="atelier-viewer" aria-label="File">
      {shown ? <>
        <header className="atelier-viewer-head">
          <code title={shown.path}>{shown.path}</code>
          {shown.mode === 'text' && <span className="atelier-muted">{lines.length} lines{shown.file.truncated ? ' · truncated' : ''}</span>}
          <div className="atelier-viewer-actions">
            {isCode && shown.mode === 'text' && <button className="button button-small" onClick={() => onShowInMap(shown.path)} title="Show this file in the map of the code"><Icon name="graph" size={12}/></button>}
            <button className="button button-small" onClick={() => void launch('system')} title="Show in the file manager"><Icon name="folder" size={12}/></button>
            {isDocument
              ? <button className="button button-small button-primary" onClick={() => void launch('default')} title="Open with the app of this kind of file"><Icon name="arrow" size={12}/> Open</button>
              : <button className="button button-small button-primary" onClick={() => void launch('vscode')}><Icon name="code" size={12}/> Open in VS Code</button>}
          </div>
        </header>
        <div className="atelier-code" ref={viewer}>
          {shown.mode === 'preview' ? <Preview preview={shown.preview}/>
            : shown.mode === 'pdf' ? <PdfPages url={raw(shown.path)}/>
            : shown.mode === 'image' ? <div className="atelier-image"><img src={raw(shown.path)} alt={shown.path}/></div>
            : shown.mode === 'markdown' ? <article className="atelier-preview document"><AgentMessageContent content={shown.text}/></article>
            : shown.mode === 'none' ? <div className="atelier-empty"><p>{shown.reason}</p>{isDocument && <button className="button" onClick={() => void launch('default')}>Open with its app</button>}</div>
            : <table><tbody>{lines.map((text, index) => <tr key={index} data-line={index + 1} className={line === index + 1 ? 'focus' : ''} onClick={() => setLine(index + 1)}>
              <td className="atelier-line-number">{index + 1}</td><td><pre>{text || ' '}</pre></td></tr>)}</tbody></table>}
        </div>
      </> : <p className="atelier-empty">{error || (isCode ? 'Choose a file to read it. Kavot shows the code read-only: edit it in your editor or ask an agent.'
        : 'Choose a document to preview it: Word, Excel, PowerPoint, CSV, PDF, images, Markdown. “Open” launches its usual app.')}</p>}
    </section>
  </div>;
}
