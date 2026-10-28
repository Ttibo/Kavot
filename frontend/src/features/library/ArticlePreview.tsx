import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRuntime } from '../../app/runtime';
import { publish } from '../../app/viewBridge';
import { api } from '../../services/api';
import { Icon } from '../../components/Icon';

export type LookupPreview = {
  title: string; authors: string[]; abstract: string; publication: string; published_at: string;
  doi: string; url: string; tags: string[]; metadata: Record<string, unknown>; origin: string;
  pdf_url?: string | null;
};
type ImportResult = { paper: Paper; created: boolean; pdf: { found: boolean; imported: boolean; error?: string | null } };

const sameDoi = (a?: string, b?: string) => Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

/** Quick look at an article before reading it, exploring its citations or adding it to the library. */
export function ArticlePreview({ paper, lookup, projectId, onExplore, onClose }: {
  paper?: Paper; lookup?: LookupPreview; projectId?: number;
  onExplore: (seed: Paper | LookupPreview) => void; onClose: () => void;
}) {
  const runtime = useRuntime();
  const { state } = runtime;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [addedId, setAddedId] = useState<number | null>(null);
  // A looked-up DOI already in the library behaves like that library article.
  const libraryPaper = paper
    || state.papers.find((item: Paper) => item.id === addedId)
    || (lookup ? state.papers.find((item: Paper) => sameDoi(item.doi, lookup.doi)) : undefined);
  const article = libraryPaper || lookup!;
  const year = libraryPaper ? runtime.paperPublicationYear(libraryPaper) : (lookup?.published_at || '').slice(0, 4);
  const link = article.doi ? `https://doi.org/${article.doi}` : article.url;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const read = () => {
    if (!libraryPaper) return;
    state.libraryReadingPaperId = libraryPaper.id;
    state.paperProjectContext = projectId ?? null;
    onClose();
    publish();
  };
  async function add() {
    if (!lookup) return;
    setBusy(true); setError('');
    try {
      const result = await api<ImportResult>('/library/import', { method: 'POST', body: JSON.stringify({ ...lookup, project_ids: projectId ? [projectId] : [] }) });
      await runtime.refreshData();
      setAddedId(result.paper.id);
      if (result.pdf.error) runtime.toast(`Article added, but the PDF could not be downloaded: ${result.pdf.error}`, 'error');
      else runtime.toast(result.pdf.imported ? 'Article added with its PDF' : 'Article added (no open PDF found)');
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  return createPortal(<div className="integration-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="integration-modal article-preview" role="dialog" aria-modal="true" aria-labelledby="article-preview-title">
      <header>
        <div>
          <span className="article-preview-kind">{libraryPaper ? (lookup && !addedId ? 'Already in your library' : 'Library article') : `Found via ${lookup?.origin || 'lookup'}`}</span>
          <h2 id="article-preview-title">{article.title || 'Untitled article'}</h2>
          <p>{article.authors?.join(', ') || 'Unknown author'}</p>
        </div>
        <button className="modal-x" onClick={onClose} aria-label="Close">×</button>
      </header>
      <div className="article-preview-body">
        <dl className="article-preview-meta">
          {article.publication && <><dt>Publication</dt><dd>{article.publication}</dd></>}
          {year && <><dt>Year</dt><dd>{year}</dd></>}
          {article.doi && <><dt>DOI</dt><dd>{article.doi}</dd></>}
          {libraryPaper && <><dt>Status</dt><dd>{runtime.labels[libraryPaper.status || 'to_read']}</dd></>}
          {libraryPaper ? <><dt>PDF</dt><dd>{libraryPaper.file_path ? 'Attached' : 'Not attached'}</dd></> : <><dt>PDF</dt><dd>{lookup?.pdf_url ? 'Open PDF found — downloaded on import' : 'No open PDF found'}</dd></>}
        </dl>
        {Boolean(article.tags?.length) && <div className="article-preview-tags">{article.tags.map(tag => <span key={tag} className="view-pill">{tag}</span>)}</div>}
        <h3>Abstract</h3>
        {article.abstract ? <p className="article-preview-abstract">{article.abstract}</p> : <p className="article-preview-empty">No abstract available for this article.</p>}
        {link && <a className="article-preview-link" href={link} target="_blank" rel="noreferrer">Open the publisher page <Icon name="arrow" size={12}/></a>}
        {error && <p className="integration-error" role="alert">{error}</p>}
      </div>
      <footer className="article-preview-actions">
        <button type="button" className="button" onClick={onClose}>Close</button>
        <button type="button" className="button" onClick={() => onExplore(libraryPaper || lookup!)}><Icon name="graph" size={14}/>Explore graph</button>
        {libraryPaper
          ? <button type="button" className="button button-primary" onClick={read}><Icon name="papers" size={14}/>Read</button>
          : <button type="button" className="button button-primary" disabled={busy} onClick={() => void add()}><Icon name="plus" size={14}/>{busy ? (lookup?.pdf_url ? 'Downloading PDF…' : 'Adding…') : 'Add to library'}</button>}
      </footer>
    </section>
  </div>, document.body);
}
