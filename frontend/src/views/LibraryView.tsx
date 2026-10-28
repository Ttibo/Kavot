import { openWatchers } from '../features/collections/CollectionWatchers';
import { useEffect, useRef, useState } from 'react';
import { useRuntime } from '../app/runtime';
import { publish } from '../app/viewBridge';
import { cssVars, EmptyState } from '../components/common';
import { Icon } from '../components/Icon';
import { PaperRow } from '../features/library/PaperRow';
import { paperFolderIds } from '../features/library/filters';
import { FolderTree } from '../features/library/FolderTree';
import { QuickAdd } from '../features/library/QuickAdd';
import { CitationGraph } from '../features/library/CitationGraph';
import { useExplorations } from '../features/library/useExplorations';
import { ArticlePreview } from '../features/library/ArticlePreview';
import { LibraryReader } from '../features/library/LibraryReader';
import { useZotero } from '../features/library/useZotero';
import { ZoteroSyncProgress } from '../features/library/ZoteroSyncProgress';
import { ZoteroContentSummary } from '../features/library/ZoteroContentSummary';
import { ZoteroPdfSummary } from '../features/library/ZoteroPdfSummary';
import { Pagination, useFitPagination, ViewHeader, ViewPage } from '../components/ViewLayout';
import '../styles/features/discovery.css';

export function LibraryView() {
  const runtime = useRuntime();
  const { state, labels } = runtime;
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const exploration = useExplorations();
  const [previewPaper, setPreviewPaper] = useState<Paper | null>(null);
  const graphPaper = exploration.paper;
  const zotero = useZotero();
  const [sort, setSort] = useState('recent');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [folderWidth, setFolderWidth] = useState(() => {
    try { return Math.max(180, Math.min(520, Number(localStorage.getItem('kavot-library-folder-width')) || 240)); }
    catch { return 240; }
  });
  const folderDrag = useRef<{ x: number; width: number } | null>(null);
  useEffect(() => {
    try { localStorage.setItem('kavot-library-folder-width', String(folderWidth)); } catch { /* Keep the session preference when storage is unavailable. */ }
  }, [folderWidth]);
  const resizeFolders = (width: number) => setFolderWidth(Math.max(180, Math.min(520, width)));
  const project = state.projects.find((item: Project) => item.id === Number(state.paperProjectFilter));
  const years = [...new Set<string>(state.papers.map((item: Paper) => runtime.paperPublicationYear(item)).filter(Boolean))].sort().reverse();
  const hasFilters = Boolean(favoritesOnly || state.paperSearch || state.paperStatusFilter || state.paperYearFilter !== 'all');
  const papers = ([...runtime.paperFilteredItems()] as Paper[]).filter(paper => !favoritesOnly || paper.favorite);
  if (sort === 'title') papers.sort((a, b) => a.title.localeCompare(b.title));
  if (sort === 'year') papers.sort((a, b) => runtime.paperPublicationYear(b).localeCompare(runtime.paperPublicationYear(a)) || a.title.localeCompare(b.title));
  const fit = useFitPagination(papers, { page: state.paperPage, onPage: next => { state.paperPage = next; publish(); }, resetKey: `${sort}|${favoritesOnly}` });
  const update = (key: string, value: string | number) => { Object.assign(state, { [key]: value, paperPage: 1 }); publish(); };
  const location = (favoritesOnly ? 'Favoris' : '') || project?.name || (state.paperFolderFilter === 'all' ? 'All articles' : state.paperFolderFilter === 'root' ? 'Unfiled' : runtime.paperFolderLabel(state.paperFolderFilter));
  const reset = () => { setFavoritesOnly(false); Object.assign(state, { paperSearch: '', paperStatusFilter: '', paperYearFilter: 'all', paperPage: 1 }); publish(); };
  const closeReader = () => { state.libraryReadingPaperId = null; publish(); };
  useEffect(() => {
    const main = document.querySelector('#main-content');
    main?.classList.toggle('library-reader-mode', Boolean(state.libraryReadingPaperId));
    main?.classList.toggle('library-graph-mode', Boolean(graphPaper));
    return () => main?.classList.remove('library-reader-mode', 'library-graph-mode');
  }, [state.libraryReadingPaperId, graphPaper]);

  if (graphPaper) return <div className="library-graph-view"><CitationGraph paper={graphPaper} onBack={exploration.close} initialTabs={exploration.resumeTabs} onTabsChange={tabs => void exploration.saveTabs(tabs)}/></div>;
  if (state.libraryReadingPaperId) return <div className="library-workspace library-refined library-reader-view"><section className="library-content"><LibraryReader paperId={state.libraryReadingPaperId} onBack={closeReader}/></section></div>;
  return <ViewPage className="library-view library-workspace library-refined" label="Article library" style={cssVars({ '--library-folder-width': `${folderWidth}px` })}>
    <aside id="library-folder-nav" className="library-folder-nav" aria-label="Library organization">
      <div className="library-nav-heading">Library</div>
      <button className={`library-folder-scope ${favoritesOnly ? 'active' : ''}`} aria-pressed={favoritesOnly} onClick={() => { setFavoritesOnly(!favoritesOnly); update('paperPage', 1); }}><span>★</span><strong>Favoris</strong><small>{state.papers.filter(paper => paper.favorite).length}</small></button>
      <button className={`library-folder-scope ${!favoritesOnly && !project && state.paperFolderFilter === 'all' ? 'active' : ''}`} data-library-paper-folder="all" onClick={() => setFavoritesOnly(false)}><Icon name="papers" size={17}/><strong>All articles</strong><small>{state.papers.length}</small></button>
      <button className={`library-folder-scope ${!project && state.paperFolderFilter === 'root' ? 'active' : ''}`} data-library-paper-folder="root" data-paper-folder-drop="root"><Icon name="folder" size={17}/><strong>Unfiled</strong><small>{state.papers.filter((paper: Paper) => !paperFolderIds(paper).length).length}</small></button>
      <div className="library-nav-heading" data-paper-folder-drop="root" title="Drop a folder here to move it to the top level"><span>Folders</span><button data-action="new-paper-folder" aria-label="Create a library folder"><Icon name="plus" size={16}/></button></div>
      <div className="library-folder-tree"><FolderTree/>{!state.paperFolders.length && <p className="library-nav-hint">Create folders to organize your references.</p>}</div>
      <div className="library-nav-heading">Projects</div>
      <div className="library-project-nav">{state.projects.map((item: Project) => <button key={item.id} className={`library-project-scope ${project?.id === item.id ? 'active' : ''}`} data-paper-project-drop={item.id} onClick={() => { Object.assign(state, { paperProjectFilter: String(item.id), paperFolderFilter: 'all', paperPage: 1 }); publish(); }}><i style={cssVars({ '--project-color': item.color })}/><strong>{item.name}</strong><small>{state.papers.filter((paper: Paper) => paper.projects.some(link => link.id === item.id)).length}</small></button>)}</div>
      <p className="library-nav-hint">Drag folders to move them. Drop a folder on a project to link all its articles, including subfolders.</p>
    </aside>
    <div className="library-folder-resizer" role="separator" tabIndex={0} aria-label="Resize library folders" aria-orientation="vertical" aria-controls="library-folder-nav" aria-valuemin={180} aria-valuemax={520} aria-valuenow={folderWidth}
      title="Drag to resize folders · Double-click to reset"
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); folderDrag.current = { x: event.clientX, width: event.currentTarget.previousElementSibling!.getBoundingClientRect().width }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (folderDrag.current) resizeFolders(folderDrag.current.width + event.clientX - folderDrag.current.x); }}
      onPointerUp={event => { folderDrag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => { folderDrag.current = null; }} onLostPointerCapture={() => { folderDrag.current = null; }}
      onDoubleClick={() => resizeFolders(240)}
      onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); resizeFolders(event.key === 'Home' ? 180 : event.key === 'End' ? 520 : folderWidth + (event.key === 'ArrowRight' ? 20 : -20)); } }}/>
    <section className="library-content">
      <ViewHeader icon="papers" title="Article library" count={state.papers.length}><form className="library-explore-doi" onSubmit={exploration.exploreIdentifier}><input required aria-label="Article DOI or URL" value={exploration.identifier} onChange={event => exploration.setIdentifier(event.target.value)} placeholder="Explore a DOI or URL…" disabled={exploration.busy}/><button className="button" type="submit" disabled={exploration.busy || !exploration.identifier.trim()} title="Preview the article, then add it or explore its citations"><Icon name="graph" size={14}/>{exploration.busy ? 'Looking up…' : 'Look up'}</button></form><button className="button" onClick={() => openWatchers({ collectionId: 'articles' })}><Icon name="sparkle" size={14}/>Watchers</button><span className="zotero-sync-trigger"><button className="button" disabled={zotero.loading || zotero.connecting || zotero.syncing} onClick={() => zotero.connection?.configured ? void zotero.synchronize() : void runtime.openSettings('integrations')}>{zotero.syncing ? 'Synchronizing Zotero…' : zotero.connection?.configured ? 'Sync Zotero' : 'Import from Zotero'}</button>{zotero.syncing && <span className="sync-spinner zotero-sync-spinner" aria-label="Synchronizing Zotero" role="img"/>}</span><button className="button button-primary" onClick={() => setQuickAddOpen(true)}><Icon name="plus" size={14}/> Add article</button></ViewHeader>
      {zotero.syncing && <ZoteroSyncProgress progress={zotero.progress} warning={zotero.connectionWarning}/>}
      {zotero.result && !zotero.syncing && <details className="library-sync-report">
        <summary><span>Zotero · {zotero.result.created} added · {zotero.result.updated} updated</span>{Boolean(zotero.result.pdfs?.errors.length || zotero.result.notes?.errors.length) && <span className="library-sync-attention">{(zotero.result.pdfs?.errors.length || 0) + (zotero.result.notes?.errors.length || 0)} needing attention</span>}<span className="library-sync-details-label">Details</span></summary>
        <div className="library-sync-report-body"><p>{zotero.result.skipped} articles skipped</p><ZoteroContentSummary result={zotero.result}/><ZoteroPdfSummary result={zotero.result.pdfs}/></div>
      </details>}
      {zotero.error && <p className="integration-error" role="alert">{zotero.error}</p>}
      {exploration.error && <p className="integration-error" role="alert">{exploration.error}</p>}
      <div className="library-toolbar"><div className="library-query-bar"><label className="library-search" htmlFor="paper-search"><Icon name="search" size={18}/><input id="paper-search" type="search" value={state.paperSearch} onChange={event => update('paperSearch', event.target.value)} placeholder="Search by title, author, DOI or tag" aria-label="Search the library"/></label><label className="library-select"><span>Year</span><select aria-label="Publication year" value={state.paperYearFilter} onChange={event => update('paperYearFilter', event.target.value)}><option value="all">All years</option>{years.map(year => <option key={year}>{year}</option>)}</select></label><label className="library-select"><span>Sort</span><select aria-label="Sort articles" value={sort} onChange={event => { setSort(event.target.value); update('paperPage', 1); }}><option value="recent">Recently added</option><option value="year">Newest publication</option><option value="title">Title A–Z</option></select></label></div>
      <div className="library-reading-filters" role="group" aria-label="Filter articles"><button className={favoritesOnly ? 'active' : ''} aria-pressed={favoritesOnly} onClick={() => { setFavoritesOnly(!favoritesOnly); update('paperPage', 1); }}>★ Favoris</button>{['', 'to_read', 'reading', 'read', 'key'].map(status => <button key={status} className={state.paperStatusFilter === status ? 'active' : ''} aria-pressed={state.paperStatusFilter === status} onClick={() => update('paperStatusFilter', status)}>{status ? labels[status] : 'All statuses'}</button>)}{hasFilters && <button className="library-clear" onClick={reset}>Clear filters</button>}</div></div>
      <div className="library-list-heading"><div><h2>{location}</h2><span aria-live="polite">{papers.length} {papers.length === 1 ? 'article' : 'articles'}</span></div>{project && <button className="button button-small" data-action="add-project-paper" data-project-id={project.id}>Link articles</button>}</div>
      <div id="paper-results" className="fit-list"><div className="fit-body" ref={fit.ref}>{papers.length ? <div className="view-table-wrap"><table className="view-table article-table paper-table" aria-label="Articles"><thead><tr><th scope="col">Article</th><th scope="col">Year</th><th scope="col">Reading status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead><tbody data-fit-list>{fit.pageItems.map(paper => <PaperRow key={paper.id} paper={paper} projectId={project?.id} onCitationGraph={paper => void exploration.start(paper)} onPreview={setPreviewPaper}/>)}</tbody></table></div>
        : <EmptyState icon="▤" title={hasFilters || location !== 'All articles' ? 'No articles match this view' : 'Build your research library'} action={hasFilters || location !== 'All articles' ? 'reset-paper-filters' : undefined} onAction={hasFilters || location !== 'All articles' ? () => setFavoritesOnly(false) : () => setQuickAddOpen(true)} actionLabel={hasFilters || location !== 'All articles' ? 'Reset filters' : 'Add article'}>{hasFilters || location !== 'All articles' ? 'Try a different search, status or folder.' : 'Add a reference or import one by DOI. Attach a PDF when you are ready to read.'}</EmptyState>}</div>
        {papers.length > 0 && <Pagination label="Library pages" page={fit.page} pages={fit.pages} total={fit.total} from={fit.from} to={fit.to} onPage={fit.setPage}/>}</div>
    </section>
    <aside className="library-explorations-panel" aria-labelledby="library-explorations-heading">
      <div className="library-nav-heading"><span id="library-explorations-heading">Graph explorations</span><small>{exploration.explorations?.length ?? '…'}</small></div>
      <div className="library-explorations">{exploration.explorations?.length ? exploration.explorations.map(record => <div className="discovery-exploration" key={record.id}>
        <button type="button" className="discovery-exploration-open" title={`Resume “${record.title}”`} onClick={() => exploration.resume(record)}>
          <strong>{record.title}</strong>
          <small>{record.kind === 'library' ? 'Library article' : 'External DOI'}{record.seed?.year ? ` · ${record.seed.year}` : ''} · {Math.max(1, record.tabs?.length || 1)} step{Math.max(1, record.tabs?.length || 1) === 1 ? '' : 's'}</small>
        </button>
        <button type="button" className="discovery-icon-button discovery-icon-danger" title="Delete" aria-label={`Delete exploration: ${record.title}`} onClick={() => void exploration.remove(record.id)}><Icon name="trash" size={13}/></button>
      </div>) : exploration.explorations && <p className="library-nav-hint">Open an article's graph or explore a DOI — explorations are saved here automatically.</p>}</div>
    </aside>
    {quickAddOpen && <QuickAdd projectId={project?.id} onClose={() => setQuickAddOpen(false)}/>}
    {previewPaper && <ArticlePreview paper={previewPaper} projectId={project?.id} onClose={() => setPreviewPaper(null)} onExplore={seed => { setPreviewPaper(null); void exploration.start(seed); }}/>}
    {exploration.lookupPreview && <ArticlePreview lookup={exploration.lookupPreview} projectId={project?.id} onClose={exploration.closeLookup} onExplore={seed => { exploration.closeLookup(); exploration.setIdentifier(''); void exploration.start(seed); }}/>}
  </ViewPage>;
}
