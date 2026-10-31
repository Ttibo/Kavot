import { openWatchers } from '../features/collections/CollectionWatchers';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRuntime } from '../app/runtime';
import { publish } from '../app/viewBridge';
import { refreshState, toast } from '../app/navigation';
import { api } from '../services/api';
import { Menu } from '../components/Menu';
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
  // One column by default: the folders fold away, the graph explorations open on demand.
  const [foldersOpen, setFoldersOpen] = useState(() => { try { return localStorage.getItem('kavot-library-folders-open') !== 'false'; } catch { return true; } });
  const toggleFolders = () => setFoldersOpen(open => { try { localStorage.setItem('kavot-library-folders-open', String(!open)); } catch { /* Kept for this session. */ } return !open; });
  const [explorationsOpen, setExplorationsOpen] = useState(false);
  const project = state.projects.find((item: Project) => item.id === Number(state.paperProjectFilter));
  const years = [...new Set<string>(state.papers.map((item: Paper) => runtime.paperPublicationYear(item)).filter(Boolean))].sort().reverse();
  const hasFilters = Boolean(favoritesOnly || state.paperSearch || state.paperStatusFilter || state.paperYearFilter !== 'all');
  const papers = ([...runtime.paperFilteredItems()] as Paper[]).filter(paper => !favoritesOnly || paper.favorite);
  if (sort === 'title') papers.sort((a, b) => a.title.localeCompare(b.title));
  if (sort === 'year') papers.sort((a, b) => runtime.paperPublicationYear(b).localeCompare(runtime.paperPublicationYear(a)) || a.title.localeCompare(b.title));
  const fit = useFitPagination(papers, { page: state.paperPage, onPage: next => { state.paperPage = next; publish(); }, resetKey: `${sort}|${favoritesOnly}` });
  const update = (key: string, value: string | number) => { Object.assign(state, { [key]: value, paperPage: 1 }); publish(); };
  const location = (favoritesOnly ? 'Favorites' : '') || project?.name || (state.paperFolderFilter === 'all' ? 'All articles' : state.paperFolderFilter === 'root' ? 'Unfiled' : runtime.paperFolderLabel(state.paperFolderFilter));
  const reset = () => { setFavoritesOnly(false); Object.assign(state, { paperSearch: '', paperStatusFilter: '', paperYearFilter: 'all', paperPage: 1 }); publish(); };
  const closeReader = () => { state.libraryReadingPaperId = null; publish(); };
  // Several articles at once: filed into a folder, linked to a project, given a status.
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const lastSelected = useRef<number | null>(null);
  const visibleIds = papers.map(paper => paper.id);
  const selectedIds = [...selection].filter(id => visibleIds.includes(id));
  const toggleSelected = (paper: Paper, range: boolean) => setSelection(current => {
    const next = new Set(current);
    const from = lastSelected.current === null ? -1 : visibleIds.indexOf(lastSelected.current);
    const to = visibleIds.indexOf(paper.id);
    if (range && from >= 0) visibleIds.slice(Math.min(from, to), Math.max(from, to) + 1).forEach(id => next.add(id));
    else if (next.has(paper.id)) next.delete(paper.id); else next.add(paper.id);
    lastSelected.current = paper.id;
    return next;
  });
  const allSelected = visibleIds.length > 0 && selectedIds.length === visibleIds.length;
  const selectAll = () => setSelection(allSelected ? new Set() : new Set(visibleIds));
  const [working, setWorking] = useState(false);
  const bulk = async (label: string, run: (id: number) => Promise<unknown>) => {
    if (!selectedIds.length || working) return;
    setWorking(true);
    try {
      await Promise.all(selectedIds.map(run));
      await refreshState(['papers', 'workspaceTree']);
      publish();
      toast(`${selectedIds.length} ${selectedIds.length === 1 ? 'article' : 'articles'} ${label}`);
    } catch (error) { toast((error as Error).message, 'error'); }
    finally { setWorking(false); }
  };
  const moveTo = (folder: string) => {
    const folderId = folder === 'root' ? null : Number(folder);
    void bulk(`moved to ${runtime.paperFolderLabel(folderId)}`, id => api(`/papers/${id}`, { method: 'PATCH', body: JSON.stringify({ folder_id: folderId }) }));
  };
  const linkTo = (projectId: number) => void bulk(`linked to ${state.projects.find((item: Project) => item.id === projectId)?.name || 'the project'}`,
    id => state.papers.find((paper: Paper) => paper.id === id)?.projects.some(link => link.id === projectId) ? Promise.resolve() : api(`/papers/${id}/projects/${projectId}`, { method: 'POST' }));
  const unlinkFrom = (projectId: number) => void bulk('removed from the project', id => api(`/papers/${id}/projects/${projectId}`, { method: 'DELETE' }));
  const setStatus = (status: string) => void bulk(`marked “${labels[status]}”`, id => api(`/papers/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }));
  // Folders in tree order, indented, for the “Move to folder” menu.
  const folderOptions = (parentId: number | null = null, depth = 0, seen = new Set<number>()): { id: number; label: string }[] =>
    state.paperFolders.filter((folder: PaperFolder) => folder.parent_id === parentId && !seen.has(folder.id)).flatMap((folder: PaperFolder) =>
      [{ id: folder.id, label: `${'  '.repeat(depth)}${folder.name}` }, ...folderOptions(folder.id, depth + 1, new Set([...seen, folder.id]))]);
  // The search also takes a DOI or a link: it is then looked up instead of searched.
  const identifier = state.paperSearch.trim();
  const looksLikeIdentifier = /^(https?:\/\/|doi:|10\.\d{4,9}\/)/i.test(identifier);
  const lookUp = (event?: FormEvent) => { event?.preventDefault(); if (looksLikeIdentifier) void exploration.exploreIdentifier(undefined, identifier); };
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const main = document.querySelector('#main-content');
    main?.classList.toggle('library-reader-mode', Boolean(state.libraryReadingPaperId));
    main?.classList.toggle('library-graph-mode', Boolean(graphPaper));
    return () => main?.classList.remove('library-reader-mode', 'library-graph-mode');
  }, [state.libraryReadingPaperId, graphPaper]);

  if (graphPaper) return <div className="library-graph-view"><CitationGraph paper={graphPaper} onBack={exploration.close} initialTabs={exploration.resumeTabs} onTabsChange={tabs => void exploration.saveTabs(tabs)}/></div>;
  if (state.libraryReadingPaperId) return <div className="library-workspace library-refined library-reader-view"><section className="library-content"><LibraryReader paperId={state.libraryReadingPaperId} onBack={closeReader}/></section></div>;
  const zoteroLabel = zotero.syncing ? 'Synchronizing Zotero…' : zotero.connection?.configured ? 'Sync Zotero' : 'Import from Zotero';
  const zoteroAction = () => { if (zotero.connection?.configured) void zotero.synchronize(); else void runtime.openSettings('integrations'); };
  const zoteroBusy = zotero.loading || zotero.connecting || zotero.syncing;
  const activeProjects = state.projects.filter((item: Project) => item.status !== 'archived');
  return <ViewPage className={`library-view library-workspace library-refined library-v2 ${foldersOpen ? '' : 'library-folders-hidden'}`} label="Article library" style={cssVars({ '--library-folder-width': `${folderWidth}px` })}>
    {foldersOpen && <><aside id="library-folder-nav" className="library-folder-nav" aria-label="Library organization">
      <div className="library-nav-heading">Library</div>
      <button className={`library-folder-scope ${!favoritesOnly && !project && state.paperFolderFilter === 'all' ? 'active' : ''}`} data-library-paper-folder="all" onClick={() => setFavoritesOnly(false)}><Icon name="papers" size={16}/><strong>All articles</strong><small>{state.papers.length}</small></button>
      <button className={`library-folder-scope ${favoritesOnly ? 'active' : ''}`} aria-pressed={favoritesOnly} onClick={() => { setFavoritesOnly(!favoritesOnly); update('paperPage', 1); }}><span>★</span><strong>Favorites</strong><small>{state.papers.filter((paper: Paper) => paper.favorite).length}</small></button>
      <button className={`library-folder-scope ${!project && state.paperFolderFilter === 'root' ? 'active' : ''}`} data-library-paper-folder="root" data-paper-folder-drop="root"><Icon name="folder" size={16}/><strong>Unfiled</strong><small>{state.papers.filter((paper: Paper) => !paperFolderIds(paper).length).length}</small></button>
      <div className="library-nav-heading" data-paper-folder-drop="root" title="Drop a folder here to move it to the top level"><span>Folders</span><button className="library-nav-add" data-action="new-paper-folder" aria-label="Create a library folder" title="New folder"><Icon name="plus" size={12}/>New</button></div>
      <div className="library-folder-tree"><FolderTree/>{!state.paperFolders.length && <button className="library-nav-empty" data-action="new-paper-folder"><Icon name="folder" size={14}/>Create a first folder to file your articles</button>}</div>
      <div className="library-nav-heading"><span>Projects</span>{project && <button className="library-nav-add" onClick={() => { Object.assign(state, { paperProjectFilter: 'all', paperPage: 1 }); publish(); }} title="Show the articles of every project">All</button>}</div>
      <div className="library-project-nav">{activeProjects.map((item: Project) => <button key={item.id} className={`library-project-scope ${project?.id === item.id ? 'active' : ''}`} data-paper-project-drop={item.id} onClick={() => { Object.assign(state, { paperProjectFilter: String(item.id), paperFolderFilter: 'all', paperPage: 1 }); publish(); }}><i style={cssVars({ '--project-color': item.color })}/><strong>{item.name}</strong><small>{state.papers.filter((paper: Paper) => paper.projects.some(link => link.id === item.id)).length}</small></button>)}</div>
      <p className="library-nav-hint">Select articles to file them, or drag them onto a folder or a project.</p>
    </aside>
    <div className="library-folder-resizer" role="separator" tabIndex={0} aria-label="Resize library folders" aria-orientation="vertical" aria-controls="library-folder-nav" aria-valuemin={180} aria-valuemax={520} aria-valuenow={folderWidth}
      title="Drag to resize folders · Double-click to reset"
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); folderDrag.current = { x: event.clientX, width: event.currentTarget.previousElementSibling!.getBoundingClientRect().width }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (folderDrag.current) resizeFolders(folderDrag.current.width + event.clientX - folderDrag.current.x); }}
      onPointerUp={event => { folderDrag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => { folderDrag.current = null; }} onLostPointerCapture={() => { folderDrag.current = null; }}
      onDoubleClick={() => resizeFolders(240)}
      onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); resizeFolders(event.key === 'Home' ? 180 : event.key === 'End' ? 520 : folderWidth + (event.key === 'ArrowRight' ? 20 : -20)); } }}/>
    </>}
    <section className="library-content">
      <ViewHeader icon="papers" title="Library" count={state.papers.length}>
        <button className={`icon-button ${foldersOpen ? 'active' : ''}`} aria-pressed={foldersOpen} aria-controls="library-folder-nav" title={foldersOpen ? 'Hide folders and projects' : 'Show folders and projects'} aria-label={foldersOpen ? 'Hide folders and projects' : 'Show folders and projects'} onClick={toggleFolders}><Icon name="sidebar" size={15}/></button>
        {zotero.syncing && <span className="sync-spinner zotero-sync-spinner" aria-label="Synchronizing Zotero" role="img"/>}
        <Menu label="More" button={(open, toggle) => <button className="icon-button" aria-label="More" title="Explorations, watchers, Zotero" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>•••</button>}>
          {close => <>
            <button role="menuitem" onClick={() => { close(); setExplorationsOpen(value => !value); }}><Icon name="graph" size={13}/><span>Citation explorations</span>{exploration.explorations?.length ? <small>{exploration.explorations.length}</small> : null}</button>
            <button role="menuitem" onClick={() => { close(); openWatchers({ collectionId: 'articles' }); }}><Icon name="sparkle" size={13}/><span>Watchers</span></button>
            <button role="menuitem" disabled={zoteroBusy} onClick={() => { close(); zoteroAction(); }}><Icon name="link" size={13}/><span>{zoteroLabel}</span></button>
          </>}
        </Menu>
        <Menu label="Add" button={(open, toggle) => <button className="button button-primary" aria-haspopup="menu" aria-expanded={open} onClick={toggle}><Icon name="plus" size={14}/>Add<Icon name="chevron" size={11}/></button>}>
          {close => <>
            <button role="menuitem" onClick={() => { close(); setQuickAddOpen(true); }}><Icon name="notes" size={13}/><span>Add a reference</span></button>
            <button role="menuitem" onClick={() => { close(); search.current?.focus(); }}><Icon name="search" size={13}/><span>From a DOI or a link…</span></button>
            <button role="menuitem" disabled={zoteroBusy} onClick={() => { close(); zoteroAction(); }}><Icon name="link" size={13}/><span>{zoteroLabel}</span></button>
          </>}
        </Menu>
      </ViewHeader>
      {zotero.syncing && <ZoteroSyncProgress progress={zotero.progress} warning={zotero.connectionWarning}/>}
      {zotero.result && !zotero.syncing && <details className="library-sync-report">
        <summary><span>Zotero · {zotero.result.created} added · {zotero.result.updated} updated</span>{Boolean(zotero.result.pdfs?.errors.length || zotero.result.notes?.errors.length) && <span className="library-sync-attention">{(zotero.result.pdfs?.errors.length || 0) + (zotero.result.notes?.errors.length || 0)} needing attention</span>}<span className="library-sync-details-label">Details</span></summary>
        <div className="library-sync-report-body"><p>{zotero.result.skipped} articles skipped</p><ZoteroContentSummary result={zotero.result}/><ZoteroPdfSummary result={zotero.result.pdfs}/></div>
      </details>}
      {zotero.error && <p className="integration-error" role="alert">{zotero.error}</p>}
      {exploration.error && <p className="integration-error" role="alert">{exploration.error}</p>}
      <form className="library-filter-bar" onSubmit={lookUp} role="search">
        <label className="library-search" htmlFor="paper-search"><Icon name="search" size={16}/><input ref={search} id="paper-search" type="search" value={state.paperSearch} onChange={event => update('paperSearch', event.target.value)} placeholder="Search titles, authors, tags — or paste a DOI or a link" aria-label="Search the library, or paste a DOI or a link"/></label>
        <select aria-label="Reading status" value={state.paperStatusFilter} onChange={event => update('paperStatusFilter', event.target.value)}><option value="">Any status</option>{['to_read', 'reading', 'read', 'key'].map(status => <option key={status} value={status}>{labels[status]}</option>)}</select>
        <select aria-label="Publication year" value={state.paperYearFilter} onChange={event => update('paperYearFilter', event.target.value)}><option value="all">Any year</option>{years.map(year => <option key={year}>{year}</option>)}</select>
        <select aria-label="Sort articles" value={sort} onChange={event => { setSort(event.target.value); update('paperPage', 1); }}><option value="recent">Recently added</option><option value="year">Newest first</option><option value="title">Title A–Z</option></select>
        {hasFilters && <button type="button" className="text-link" onClick={reset}>Clear</button>}
      </form>
      {looksLikeIdentifier && <div className="library-lookup-hint" role="status"><Icon name="search" size={14}/><span>This looks like a DOI or a link.</span><button className="button button-small button-primary" onClick={() => lookUp()} disabled={exploration.busy}>{exploration.busy ? 'Looking up…' : 'Look it up'}</button></div>}
      {selectedIds.length > 0 ? <div className="library-bulk-bar" role="toolbar" aria-label="Selected articles">
        <strong>{selectedIds.length} selected</strong>
        <select aria-label="Move the selected articles to a folder" value="" disabled={working} onChange={event => moveTo(event.target.value)}>
          <option value="" disabled>Move to folder…</option><option value="root">Unfiled</option>{folderOptions().map(folder => <option key={folder.id} value={folder.id}>{folder.label}</option>)}
        </select>
        <select aria-label="Link the selected articles to a project" value="" disabled={working} onChange={event => linkTo(Number(event.target.value))}>
          <option value="" disabled>Link to project…</option>{activeProjects.map((item: Project) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <select aria-label="Set the reading status of the selected articles" value="" disabled={working} onChange={event => setStatus(event.target.value)}>
          <option value="" disabled>Set status…</option>{['to_read', 'reading', 'read', 'key'].map(status => <option key={status} value={status}>{labels[status]}</option>)}
        </select>
        {project && <button className="button button-small" disabled={working} onClick={() => unlinkFrom(project.id)}>Remove from {project.name}</button>}
        <button className="button button-small" data-action="new-paper-folder"><Icon name="folder" size={13}/>New folder</button>
        <span className="library-bulk-spacer"/>
        <button className="text-link" onClick={() => setSelection(new Set())}>Clear selection</button>
      </div> : <div className="library-list-heading"><div><h2>{location}</h2><span aria-live="polite">{papers.length} {papers.length === 1 ? 'article' : 'articles'}</span></div>{project && <button className="button button-small" data-action="add-project-paper" data-project-id={project.id}>Link articles</button>}</div>}
      <div id="paper-results" className="fit-list"><div className="fit-body" ref={fit.ref}>{papers.length ? <div className="view-table-wrap"><table className="view-table article-table paper-table" aria-label="Articles"><thead><tr><th scope="col" className="paper-cell-select"><input type="checkbox" checked={allSelected} aria-label="Select every article shown" onChange={selectAll}/></th><th scope="col">Article</th><th scope="col">Year</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead><tbody data-fit-list>{fit.pageItems.map(paper => <PaperRow key={paper.id} paper={paper} projectId={project?.id} selected={selection.has(paper.id)} onSelect={toggleSelected} onCitationGraph={paper => void exploration.start(paper)} onPreview={setPreviewPaper}/>)}</tbody></table></div>
        : <EmptyState icon="▤" title={hasFilters || location !== 'All articles' ? 'No articles match this view' : 'Build your research library'} action={hasFilters || location !== 'All articles' ? 'reset-paper-filters' : undefined} onAction={hasFilters || location !== 'All articles' ? () => setFavoritesOnly(false) : () => setQuickAddOpen(true)} actionLabel={hasFilters || location !== 'All articles' ? 'Reset filters' : 'Add article'}>{hasFilters || location !== 'All articles' ? 'Try a different search, status or folder.' : 'Add a reference, paste a DOI in the search, or import your Zotero library.'}</EmptyState>}</div>
        {papers.length > 0 && <Pagination label="Library pages" page={fit.page} pages={fit.pages} total={fit.total} from={fit.from} to={fit.to} onPage={fit.setPage}/>}</div>
    </section>
    {explorationsOpen && <aside id="library-explorations" className="library-explorations-panel" aria-labelledby="library-explorations-heading">
      <div className="library-nav-heading"><span id="library-explorations-heading">Graph explorations</span><small>{exploration.explorations?.length ?? '…'}</small></div>
      <div className="library-explorations">{exploration.explorations?.length ? exploration.explorations.map(record => <div className="discovery-exploration" key={record.id}>
        <button type="button" className="discovery-exploration-open" title={`Resume “${record.title}”`} onClick={() => exploration.resume(record)}>
          <strong>{record.title}</strong>
          <small>{record.kind === 'library' ? 'Library article' : 'External DOI'}{record.seed?.year ? ` · ${record.seed.year}` : ''} · {Math.max(1, record.tabs?.length || 1)} step{Math.max(1, record.tabs?.length || 1) === 1 ? '' : 's'}</small>
        </button>
        <button type="button" className="discovery-icon-button discovery-icon-danger" title="Delete" aria-label={`Delete exploration: ${record.title}`} onClick={() => void exploration.remove(record.id)}><Icon name="trash" size={13}/></button>
      </div>) : exploration.explorations && <p className="library-nav-hint">Open an article's graph or explore a DOI — explorations are saved here automatically.</p>}</div>
    </aside>}
    {quickAddOpen && <QuickAdd projectId={project?.id} onClose={() => setQuickAddOpen(false)}/>}
    {previewPaper && <ArticlePreview paper={previewPaper} projectId={project?.id} onClose={() => setPreviewPaper(null)} onExplore={seed => { setPreviewPaper(null); void exploration.start(seed); }}/>}
    {exploration.lookupPreview && <ArticlePreview lookup={exploration.lookupPreview} projectId={project?.id} onClose={exploration.closeLookup} onExplore={seed => { exploration.closeLookup(); exploration.setIdentifier(''); void exploration.start(seed); }}/>}
  </ViewPage>;
}
