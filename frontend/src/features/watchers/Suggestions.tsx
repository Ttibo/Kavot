import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { OverlayPanel, Pagination, useFitPagination } from '../../components/ViewLayout';
import type { CitationNode } from '../library/CitationCanvas';
import '../../styles/features/discovery.css';
import '../../styles/features/library-refined.css';

export type Suggestion = {
  id: string; title: string; authors: string[]; publication: string; published_at: string;
  abstract: string; doi: string; url: string; matched_query: string;
  openalex_id?: string; pdf_url?: string;
  status: 'new' | 'saved' | 'dismissed'; found_at: string; report_id?: string;
  match_reasons?: string[]; relevance_score?: number; interest_rating?: number;
};
export type Report = {
  id: string; created_at: string; queries: string[]; suggestion_ids: string[];
  new_count: number; error_count: number; summary: string; errors?: string[];
  examined_count?: number; relevant_count?: number;
  context_paper_count?: number; zero_rating_count?: number;
  library_duplicate_count?: number; search_rounds?: number;
};

export const shortDate = (value: string | null) => value ? new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : 'Never';

function sourceUrl(item: Suggestion) {
  if (item.doi) return `https://doi.org/${item.doi}`;
  return /^https:\/\//i.test(item.url || '') ? item.url : '';
}

export function graphSeed(item: Suggestion): CitationNode {
  const year = Number(String(item.published_at || '').slice(0, 4));
  return { id: item.openalex_id || item.id, openalex_id: item.openalex_id,
    title: item.title, authors: item.authors || [], year: year || undefined,
    doi: item.doi, abstract: item.abstract, publication: item.publication,
    url: item.url, pdf_url: item.pdf_url, relation: 'focus' };
}

/** Articles found by a scientific search: a table, with details and decisions in a side panel. */
export function SuggestionTable({ items, handled, busy, resetKey, onDecide, onGraph }: {
  items: Suggestion[]; handled: boolean; busy: boolean; resetKey: string;
  onDecide: (item: Suggestion, decision: 'saved' | 'dismissed') => void; onGraph: (item: Suggestion) => void;
}) {
  const [articleId, setArticleId] = useState<string | null>(null);
  useEffect(() => { setArticleId(null); }, [resetKey]);
  const fit = useFitPagination(items, { resetKey });
  const relevance = (item: Suggestion) => typeof item.interest_rating === 'number' ? <span className="view-pill" aria-label={`Relevance ${item.interest_rating} out of 5`}>{item.interest_rating}/5</span> : <span className="view-muted">—</span>;
  const statusPill = (item: Suggestion) => <span className={`view-pill ${item.status === 'saved' ? 'is-success' : item.status === 'dismissed' ? 'is-muted' : 'is-accent'}`}>{item.status === 'saved' ? 'Added' : item.status === 'dismissed' ? 'Dismissed' : 'New'}</span>;
  const detail = items.find(item => item.id === articleId) || null;
  return <>
    <div className="fit-body" ref={fit.ref}><div className="view-table-wrap"><table className="view-table article-table watch-article-table" aria-label="Articles">
      <thead><tr><th scope="col">Article</th><th scope="col">Source</th><th scope="col">Published</th><th scope="col">Relevance</th><th scope="col">{handled ? 'Decision' : 'Status'}</th></tr></thead>
      <tbody data-fit-list>{(fit.pageItems as Suggestion[]).map(item => <tr key={item.id} className={`is-clickable${item.id === articleId ? ' is-selected' : ''}`} aria-selected={item.id === articleId} tabIndex={0}
        onClick={() => setArticleId(item.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setArticleId(item.id); } }}>
        <td><div className="view-cell-stack"><strong title={item.title}>{item.title}</strong><small>{item.authors?.slice(0, 3).join(', ') || 'Authors not provided'}{(item.authors?.length || 0) > 3 ? ' et al.' : ''}</small></div></td>
        <td title={item.publication}>{item.publication || 'Scientific article'}</td>
        <td>{item.published_at || shortDate(item.found_at)}</td>
        <td>{relevance(item)}</td>
        <td>{statusPill(item)}</td>
      </tr>)}</tbody></table></div></div>
    <Pagination label="List pages" page={fit.page} pages={fit.pages} total={fit.total} from={fit.from} to={fit.to} onPage={fit.setPage}/>
    {detail && <OverlayPanel className="article-detail-panel" label="Article details" title="Article" closeLabel="Close the article" onClose={() => setArticleId(null)}>
      <div className="article-detail">
        <div className="article-detail-meta"><span>{detail.publication || 'Scientific article'}</span>{relevance(detail)}{statusPill(detail)}</div>
        <h2>{detail.title}</h2>
        <p className="article-detail-authors">{detail.authors?.join(', ') || 'Authors not provided'}</p>
        <dl className="article-detail-fields">
          <div><dt>Published</dt><dd>{detail.published_at || '—'}</dd></div>
          <div><dt>Found on</dt><dd>{shortDate(detail.found_at)}</dd></div>
          <div><dt>DOI</dt><dd>{detail.doi ? <a href={`https://doi.org/${detail.doi}`} target="_blank" rel="noreferrer">{detail.doi}</a> : '—'}</dd></div>
          <div><dt>Link</dt><dd>{/^https?:\/\//i.test(detail.url || '') ? <a href={detail.url} target="_blank" rel="noreferrer">{detail.url}</a> : '—'}</dd></div>
          {detail.pdf_url && <div><dt>PDF</dt><dd><a href={detail.pdf_url} target="_blank" rel="noreferrer">Open the PDF ↗</a></dd></div>}
          <div><dt>Search</dt><dd>{detail.matched_query || '—'}</dd></div>
          {typeof detail.relevance_score === 'number' && <div><dt>Score</dt><dd>{detail.relevance_score.toFixed(2)}</dd></div>}
        </dl>
        <section><h3>Abstract</h3><p>{detail.abstract || 'No abstract provided.'}</p></section>
        <section><h3>Why this article</h3><div className="article-detail-reasons">{detail.match_reasons?.length ? detail.match_reasons.map(reason => <span key={reason} className="view-pill">{reason}</span>) : <span className="view-pill">Search: {detail.matched_query}</span>}</div></section>
        <footer className="article-detail-actions">
          <button className="button" onClick={() => onGraph(detail)}><Icon name="canvas" size={14}/>View the graph</button>
          {sourceUrl(detail) && <a className="button" href={sourceUrl(detail)} target="_blank" rel="noreferrer">View the source ↗</a>}
          {detail.status === 'new' && <><button className="button" disabled={busy} onClick={() => onDecide(detail, 'dismissed')}>Ignore</button><button className="button button-primary" disabled={busy} onClick={() => onDecide(detail, 'saved')}><Icon name="plus" size={14}/>Add to the library</button></>}
        </footer>
      </div>
    </OverlayPanel>}
  </>;
}

/** Search reports of the scientific search: what was examined, kept and why. */
export function ReportList({ reports, onShow }: { reports: Report[]; onShow: (report: Report) => void }) {
  const fit = useFitPagination(reports, { resetKey: String(reports.length) });
  if (!reports.length) return <div className="watch-empty"><Icon name="papers" size={26}/><h3>No reports yet</h3><p>Run a first search to see its report here.</p></div>;
  return <>
    <div className="fit-body" ref={fit.ref}><div className="watch-report-list" data-fit-list>{(fit.pageItems as Report[]).map(report => <article key={report.id} className="watch-report">
      <div className="watch-report-date"><Icon name="calendar" size={17}/><strong>{shortDate(report.created_at)}</strong><span>{report.new_count} article{report.new_count > 1 ? 's' : ''}</span></div>
      <p>{report.summary}</p>
      <div className="watch-report-stats"><span>{report.context_paper_count || 0} context article(s)</span><span>{report.examined_count || 0} results reviewed</span><span>{report.relevant_count || 0} relevant</span>{typeof report.zero_rating_count === 'number' && <span>{report.zero_rating_count} dismissed (0/5)</span>}{typeof report.library_duplicate_count === 'number' && <span>{report.library_duplicate_count} already in the library</span>}</div>
      <div className="watch-query-list">{report.queries.map(query => <span key={query}>{query}</span>)}</div>
      {report.error_count > 0 && <small title={(report.errors || []).join(' · ')}>{report.error_count} search(es) unavailable{report.errors?.[0] ? ` — ${report.errors[0]}` : ''}</small>}
      {report.new_count > 0 && <button className="text-link" onClick={() => onShow(report)}>See results →</button>}
    </article>)}</div></div>
    <Pagination label="List pages" page={fit.page} pages={fit.pages} total={fit.total} from={fit.from} to={fit.to} onPage={fit.setPage}/>
  </>;
}
