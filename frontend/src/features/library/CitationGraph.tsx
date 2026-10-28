import { registerAgentContext, suggestToAgent } from '../externalAgents/context';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { CitationEdge, CitationNode as Node } from './CitationCanvas';
const CitationCanvas = lazy(() => import('./CitationCanvas').then(module => ({ default: module.CitationCanvas })));
import { Icon } from '../../components/Icon';
import { CitationSearchProgress } from './CitationSearchProgress';
import { loadCitationGraph, type SearchProgress } from './citationProgress';
import { api } from '../../services/api';
import { useRuntime } from '../../app/runtime';

type Payload = { focus: string; nodes: Node[]; catalog?: Node[]; provider_errors?: Record<string, string>; warning?: string; edges?: CitationEdge[] };
type Direction = 'all' | 'reference' | 'citation';
type Tab = { id: number; seed?: Node; direction: Direction };

export function CitationGraph({ paper, onBack, backLabel = "← Back to library", initialTabs, onTabsChange }: { paper: Paper | Node; onBack: () => void; backLabel?: string; initialTabs?: { direction: Direction; seed?: Node | null }[]; onTabsChange?: (tabs: { direction: Direction; seed: Node | null }[]) => void }) {
  const [tabs, setTabs] = useState<Tab[]>(() => initialTabs?.length
    ? initialTabs.flatMap((tab, index) => index === 0
      ? [{ id: 0, direction: tab.direction, seed: typeof paper.id === 'string' ? paper as Node : undefined }]
      : tab.seed ? [{ id: index, direction: tab.direction, seed: tab.seed }] : [])
    : [{ id: 0, direction: 'all', seed: typeof paper.id === 'string' ? paper as Node : undefined }]);
  const [active, setActive] = useState(0);
  const counter = useRef(initialTabs?.length || 1);
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    try { return Math.max(280, Math.min(640, Number(localStorage.getItem('kavot-citation-inspector-width')) || 340)); }
    catch { return 340; }
  });
  function resizeInspector(width: number) {
    setInspectorWidth(width);
    try { localStorage.setItem('kavot-citation-inspector-width', String(width)); } catch { /* Retain the session preference. */ }
  }
  function updateTabs(next: Tab[]) {
    setTabs(next);
    onTabsChange?.(next.map(({ direction, seed }) => ({ direction, seed: seed || null })));
  }
  function explore(seed: Node, direction: Direction) {
    const id = counter.current++;
    updateTabs([...tabs, { id, seed, direction }]); setActive(id);
  }
  return <section className="citation-workspace" aria-label="Citation explorer">
      <header className="citation-page-header"><button className="library-reader-back citation-back" onClick={onBack} aria-label={backLabel} title={backLabel}><span aria-hidden="true">←</span></button><div className="citation-page-heading"><Icon name="canvas" size={16}/><h1>Citation explorer</h1></div>
      <nav className="citation-tabs" aria-label="Exploration steps"><div role="tablist">{tabs.map((tab, index) => <div className="citation-tab" key={tab.id}><button role="tab" id={`citation-tab-${tab.id}`} aria-selected={active === tab.id} aria-controls={`citation-panel-${tab.id}`} onClick={() => setActive(tab.id)} title={tab.seed?.title || paper.title}>{index + 1}. {tab.seed?.title || paper.title}</button>{tab.id !== 0 && <button aria-label={`Close exploration ${index + 1}`} onClick={() => { updateTabs(tabs.filter(item => item.id !== tab.id)); if (active === tab.id) setActive(tabs[index - 1].id); }}>×</button>}</div>)}</div></nav></header>
      {tabs.map(tab => <div className="citation-tab-panel" key={tab.id} id={`citation-panel-${tab.id}`} role="tabpanel" aria-labelledby={`citation-tab-${tab.id}`} hidden={active !== tab.id}><Exploration paper={paper} tab={tab} explore={explore} inspectorWidth={inspectorWidth} onResizeInspector={resizeInspector}/></div>)}
    </section>;
}

function Exploration({ paper, tab, explore, inspectorWidth, onResizeInspector }: { paper: Paper | Node; tab: Tab; explore: (node: Node, direction: Direction) => void; inspectorWidth: number; onResizeInspector: (width: number) => void }) {
  const runtime = useRuntime();
  const [data, setData] = useState<Payload | null>(null);
  const [selected, setSelected] = useState<Node | null>(null);
  const [busy, setBusy] = useState(true);
  const [progress, setProgress] = useState<SearchProgress>({ start: 'running' });
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const [details, setDetails] = useState<Record<string, Node>>({});
  const [detailBusy, setDetailBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState('');
  const [direction, setDirection] = useState(tab.direction);
  const [sort, setSort] = useState('citations');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const element = menu.current;
    const dismiss = (event: PointerEvent) => { if (!element?.contains(event.target as globalThis.Node)) setMenuOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [menuOpen]);
  function run(prompt: string) { setMenuOpen(false); suggestToAgent(prompt); }
  const layout = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [layoutWidth, setLayoutWidth] = useState(1200);
  const maxInspectorWidth = Math.max(280, Math.min(640, layoutWidth - 600));
  const actualInspectorWidth = Math.min(inspectorWidth, maxInspectorWidth);
  const resizeInspector = (width: number) => onResizeInspector(Math.max(280, Math.min(maxInspectorWidth, Math.round(width))));
  useEffect(() => {
    const observer = new ResizeObserver(entries => { if (entries[0].contentRect.width) setLayoutWidth(entries[0].contentRect.width); });
    if (layout.current) observer.observe(layout.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError(''); setProgress({ start: 'running' });
    loadCitationGraph<Payload>(tab.seed ? '/citation-graph/expand' : `/papers/${paper.id}/citation-graph`, { signal: controller.signal, ...(tab.seed ? { method: 'POST', body: JSON.stringify(tab.seed) } : {}) }, (step, status) => {
      if (controller.signal.aborted) return;
      setProgress(current => {
        const next = { ...current, [step]: status };
        if (step === 'openalex' && status === 'warning') {
          for (const id of ['resolve', 'references', 'citations']) {
            if (next[id] !== 'done') next[id] = next[id] === 'running' || id === 'resolve' ? 'warning' : 'skipped';
          }
        }
        return next;
      });
    })
      .then(result => { if (controller.signal.aborted) return; setData(result); setSelected(result.nodes.find(node => node.id === result.focus) || null); setError(result.warning || ''); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [paper.id, tab.seed, attempt]);
  const focus = data?.nodes.find(node => node.id === data.focus);
  const allRelated = useMemo(() => (data?.catalog || data?.nodes || []).filter(node => node.id !== data?.focus), [data]);
  const filtered = useMemo(() => allRelated.filter(node => node.id !== data?.focus && (direction === 'all' || node.relation === direction) && `${node.title} ${node.authors?.join(' ')} ${node.doi || ''}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : sort === 'newest' ? Number(b.year || 0) - Number(a.year || 0) : (b.cited_by_count || 0) - (a.cited_by_count || 0)), [allRelated, data, direction, query, sort]);
  useEffect(() => {
    if (!layout.current) return;
    return registerAgentContext(layout.current, () => ({ area: 'citations', paper_id: focus?.paper_id || (tab.seed ? undefined : typeof paper.id === 'number' ? paper.id : undefined),
      citation_graph: { root: paper, focus, selected, direction, query, sort, candidates: allRelated.map(node => details[node.id] || node), articles: allRelated.map(node => details[node.id] || node), filtered_ids: filtered.map(node => node.id), related_count: allRelated.length, edges: data?.edges || [], warning: data?.warning, provider_errors: data?.provider_errors } }));
  }, [paper, tab.seed, focus, selected, direction, query, sort, filtered, allRelated, details, data]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visible = useMemo(() => filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize), [filtered, currentPage, pageSize]);
  useEffect(() => { setPage(1); }, [query, direction, sort, pageSize]);
  useEffect(() => { setSelected(current => current && (current.id === focus?.id || visible.some(node => node.id === current.id)) ? current : focus || null); }, [visible, focus]);
  useEffect(() => {
    if (!selected || details[selected.id]) { setDetailBusy(false); return; }
    const controller = new AbortController(); const node = selected; setDetailBusy(true);
    api<Node>('/citation-graph/details', { method: 'POST', body: JSON.stringify(node), signal: controller.signal })
      .then(result => { const enriched = { ...node, ...result, id: node.id }; setDetails(current => ({ ...current, [node.id]: enriched })); setSelected(current => current?.id === node.id ? enriched : current); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setDetailBusy(false); });
    return () => controller.abort();
  }, [selected?.id]);
  function select(node: Node) { setSelected(details[node.id] || node); }
  async function importArticle() {
    if (!selected) return;
    const node = selected; setImporting(true); setError('');
    try {
      const result = await api<{ paper: Paper; pdf: { imported: boolean; error?: string } }>(focus?.paper_id ? `/papers/${focus.paper_id}/citation-nodes/import` : '/citation-graph/import', { method: 'POST', body: JSON.stringify({ ...node, published_at: node.year ? String(node.year) : '' }) });
      const updated = { ...node, paper_id: result.paper.id };
      setDetails(current => ({ ...current, [node.id]: updated })); setSelected(current => current?.id === node.id ? updated : current);
      await runtime.refreshData(); runtime.toast(result.pdf.imported ? 'Article and PDF imported' : 'Article imported without PDF');
      if (!result.pdf.imported) setError(result.pdf.error || 'No downloadable PDF was found in the available sources.');
    } catch (reason) { setError((reason as Error).message); } finally { setImporting(false); }
  }
  return <section className="citation-exploration">
    <header className="citation-exploration-toolbar">
    <div className="citation-directions" role="group" aria-label="Search direction">{(['all', 'reference', 'citation'] as Direction[]).map(value => <button key={value} aria-pressed={direction === value} onClick={() => setDirection(value)}>{value === 'all' ? 'All relations' : value === 'reference' ? 'References · Earlier work' : 'Cited by · Later work'}</button>)}</div><p className="citation-result-count">{filtered.length} articles · {visible.length} on this page</p>
    <details ref={menu} className="citation-agent-menu" open={menuOpen} onToggle={event => setMenuOpen(event.currentTarget.open)}><summary><Icon name="sparkle" size={14}/> AI actions</summary><div className="citation-agent-menu-body" role="group" aria-label="Analyze articles with AI">
      <small className="citation-agent-scope">AI context: {allRelated.length} related articles · every page</small>
      <button className="button" disabled={busy || !focus} onClick={() => run('Analyze the article pack of the active graph: research questions, methods, findings and limitations. Read the abstracts you need, cite DOIs or URLs and state what still has to be checked in the full texts.')}>Analyser ce pack</button>
      <button className="button" disabled={busy || !selected} onClick={() => run('Starting from the article selected in the graph, retrieve the related articles and suggest five relevant readings. For each one, explain its link to the reference, why it matters and the available evidence, with a DOI or URL. Do not import them automatically.')}>Articles related to this reference</button>
      <button className="button" onClick={() => run('Find relevant articles for the following question, compare them with the graph pack and justify a selection of five references with DOIs or URLs: ')}>Search for a question</button>
    </div></details></header>
    <div className="citation-layout" ref={layout} style={{ '--citation-inspector-width': `${actualInspectorWidth}px` } as CSSProperties}>
      <aside className="citation-browser citation-list-panel" aria-label="Related articles"><div className="citation-filters"><input aria-label="Search graph results" placeholder="Search…" value={query} onChange={event => setQuery(event.target.value)}/><select aria-label="Sort" value={sort} onChange={event => setSort(event.target.value)}><option value="citations">Most cited</option><option value="newest">Newest</option><option value="title">Title A–Z</option></select></div>
        <div className="citation-results">{visible.map(node => <button className={`citation-result ${selected?.id === node.id ? 'active' : ''}`} key={node.id} onClick={() => select(node)}><span className={`relation-dot ${node.relation}`}/><span><strong>{details[node.id]?.title || node.title}</strong><small>{node.year || '—'} · {node.cited_by_count || 0} citations</small><em>{node.authors?.join(', ') || 'Authors unavailable'}</em></span></button>)}{!busy && !visible.length && <p className="citation-empty">No articles match this search.</p>}</div>
        <div className="citation-pagination"><button aria-label="Previous page" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>←</button><span aria-live="polite">{currentPage} / {totalPages}</span><button aria-label="Next page" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>→</button><select aria-label="Articles per page" value={pageSize} onChange={event => setPageSize(Number(event.target.value))}>{[12, 20, 24, 36, 60].map(value => <option key={value} value={value}>{value} / page</option>)}</select></div>
      </aside>
      {focus ? <Suspense fallback={<div className="citation-canvas" role="status">Loading graph…</div>}><CitationCanvas key={focus.id} focus={focus} nodes={visible} edges={data?.edges} selectedId={selected?.id} onSelect={select}/></Suspense> : <CitationSearchProgress progress={progress} busy={busy} error={error || 'No graph available for this article.'} retry={() => setAttempt(value => value + 1)}/>}
      <div className="citation-inspector-resize" role="separator" aria-label="Resize article details" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={maxInspectorWidth} aria-valuenow={actualInspectorWidth} tabIndex={0}
        onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); drag.current = { x: event.clientX, width: actualInspectorWidth }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (drag.current) resizeInspector(drag.current.width + drag.current.x - event.clientX); }}
        onPointerUp={event => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}
        onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
        onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); resizeInspector(event.key === 'Home' ? 280 : event.key === 'End' ? maxInspectorWidth : actualInspectorWidth + (event.key === 'ArrowLeft' ? 24 : -24)); } }}
        title="Drag to resize the summary panel"><span/></div>
      <aside className="citation-inspector" aria-label="Article details">{selected && <><div className="citation-inspector-head"><span className={`relation-chip ${selected.relation}`}>{selected.id === focus?.id ? 'Starting article' : selected.relation === 'citation' ? 'Citing paper' : 'Reference'}</span><h3>{selected.title}</h3><p>{selected.authors?.join(', ') || 'Authors unavailable'}</p></div><dl><dt>Year</dt><dd>{selected.year || 'Unavailable'}</dd><dt>Publication</dt><dd>{selected.publication || 'Unavailable'}</dd><dt>DOI</dt><dd>{selected.doi || 'Unavailable'}</dd><dt>Citations</dt><dd>{selected.cited_by_count || 0}</dd></dl><section className="citation-abstract"><h4>Abstract</h4><p>{selected.abstract || (detailBusy ? 'Searching for the abstract…' : 'No abstract was found in the available scholarly sources.')}</p>{!!selected.lookup_errors?.length && <small>Some sources could not be reached.</small>}</section><div className="citation-selection-actions"><button className="button button-primary" onClick={() => explore(selected, 'reference')}>Explore references ↗</button><button className="button" onClick={() => explore(selected, 'citation')}>Explore citing papers ↗</button><button className="button" disabled={importing || detailBusy} onClick={() => void importArticle()}>{importing ? 'Importing…' : selected.paper_id ? 'Update article / retry PDF' : 'Import article + PDF'}</button></div>{selected.pdf_url && <a className="citation-open-link" href={selected.pdf_url} target="_blank" rel="noreferrer">Open PDF ↗</a>}{selected.url && <a className="citation-open-link" href={selected.url} target="_blank" rel="noreferrer">Original record ↗</a>}</>}{error && <p className="graph-warning" role="status">{error}</p>}{Object.keys(data?.provider_errors || {}).length > 0 && <p className="graph-warning">Partial results: {Object.keys(data!.provider_errors!).join(', ')} unavailable.</p>}</aside>
    </div>
  </section>;
}
