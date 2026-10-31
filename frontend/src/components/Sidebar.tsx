import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { useOptionalRuntime } from '../app/runtime';
import { navigate } from '../app/navigation';
import { collectionIcon } from '../features/collections/icons';
import { openAtelier, openAtelierBeside } from '../features/projects/navigation';
import { setAtelierIntent, useAtelierLocations } from '../features/atelier/intent';
import { atelierApi, type Folder, type Overview } from '../features/atelier/types';
import { openPage } from '../app/tabs/pages';
import { pages, type PageId } from '../app/pages';
import { workspaceColor } from '../styles/palette';
import { Icon } from './Icon';
import { Menu } from './Menu';
import '../styles/features/sidebar.css';

type Kind = 'code' | 'resources';
type Linked = Folder & { projectId: number; projectName: string };

const SECTIONS_KEY = 'kavot-sidebar-sections';
function readFolded(): string[] {
  try { return JSON.parse(localStorage.getItem(SECTIONS_KEY) || '[]'); } catch { return []; }
}

/** The scope of the whole interface: every project, or one of them. */
function ScopeSwitcher({ projects, scope, onScope }: { projects: Project[]; scope: Project | null; onScope: (id: number | null) => void }) {
  return <Menu label="Scope" className="sidebar-scope" menuClassName="sidebar-menu" button={(open, toggle) =>
    <button className="project-switcher-button sidebar-scope-button" aria-haspopup="menu" aria-expanded={open} onClick={toggle}
      title={scope ? `Filtered on ${scope.name}` : 'The whole workspace'} data-tooltip={scope ? scope.name : 'All the workspace'}>
      {scope ? <span className="project-sidebar-dot" style={{ background: workspaceColor(scope.color) }}/> : <Icon name="local" size={14}/>}
      <strong>{scope ? scope.name : 'All the workspace'}</strong><Icon name="chevron" size={12}/>
    </button>}>
    {close => <>
      <button role="menuitemradio" aria-checked={!scope} className={!scope ? 'active' : ''} onClick={() => { close(); onScope(null); }}>
        <Icon name="local" size={13}/><span>All the workspace</span>{!scope && <Icon name="check" size={13}/>}
      </button>
      {projects.length > 0 && <small>Projects</small>}
      {projects.map(item => <button key={item.id} role="menuitemradio" aria-checked={item.id === scope?.id} className={item.id === scope?.id ? 'active' : ''}
        onClick={() => { close(); onScope(item.id); }}>
        <span className="project-sidebar-dot" style={{ background: workspaceColor(item.color) }}/><span>{item.name}</span>{item.id === scope?.id && <Icon name="check" size={13}/>}
      </button>)}
      <hr/>
      {scope && <button role="menuitem" data-action="edit-project" data-project-id={scope.id} onClick={close}><Icon name="settings" size={13}/><span>Project settings</span></button>}
      <button role="menuitem" data-action="new-project" onClick={close}><Icon name="plus" size={13}/><span>New project</span></button>
    </>}
  </Menu>;
}

/** Code and resource folders linked to the projects in scope, refreshed when a project's Atelier changes them. */
function useLinkedFolders(projects: Project[], enabled: boolean) {
  const [byProject, setByProject] = useState<Record<number, Folder[]>>({});
  const ids = projects.map(project => project.id).join(',');
  const load = useCallback(async (only?: number) => {
    const targets = only ? [only] : ids ? ids.split(',').map(Number) : [];
    const loaded = await Promise.all(targets.map(async id => {
      try { return [id, (await atelierApi<Overview>(id)).folders] as const; } catch { return [id, null] as const; }
    }));
    setByProject(current => {
      const next = { ...current };
      loaded.forEach(([id, folders]) => { if (folders) next[id] = folders; });
      return next;
    });
  }, [ids]);
  useEffect(() => {
    if (!enabled) return;
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 60000);
    return () => window.clearInterval(timer);
  }, [load, enabled]);
  useEffect(() => {
    const listener = (event: Event) => { const id = (event as CustomEvent).detail?.projectId; if (id) void load(id); };
    window.addEventListener('kavot:atelier-changed', listener);
    return () => window.removeEventListener('kavot:atelier-changed', listener);
  }, [load]);
  return projects.flatMap(project => (byProject[project.id] || []).map(folder => ({ ...folder, projectId: project.id, projectName: project.name })));
}

/** One unified sidebar: the views, the collections, the linked code and resources, then the notes and files,
 * all filtered on the project chosen at the top. Every entry opens in the active pane, or beside it. */
export function Sidebar({ collapsed, onNavigate, onNewCollection }: { collapsed: boolean; onNavigate: () => void; onNewCollection: () => void }) {
  const runtime = useOptionalRuntime();
  const state = runtime?.state;
  const locations = useAtelierLocations();
  const [folded, setFolded] = useState<string[]>(readFolded);
  const projects: Project[] = (state?.projects || []).filter((project: Project) => project.status !== 'archived');
  const scope = runtime?.scopeProject() || null;
  const linked = useLinkedFolders(scope ? [scope] : projects, Boolean(runtime));

  // The editor engine draws the explorer into the tree element; redraw it when its content or scope changes.
  useEffect(() => { runtime?.rerenderWorkspaceTree(); }, [runtime, state?.workspaceTree, state?.scopeProjectId, state?.projects]);

  const toggleSection = (id: string) => setFolded(current => {
    const next = current.includes(id) ? current.filter(item => item !== id) : [...current, id];
    try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(next)); } catch { /* Folding then lasts for this session. */ }
    return next;
  });
  const isFolded = (id: string) => folded.includes(id);

  const pane: 'primary' | 'secondary' = state?.activeNotePane === 'secondary' ? 'secondary' : 'primary';
  const activeTab = state?.workspaceTabs?.[pane]?.find((tab: any) => tab.id === state.workspaceActiveTabs?.[pane]);
  const here = state?.view === 'notes' && activeTab?.resource?.type === 'atelier' ? locations[pane] : undefined;

  // A view shown in the focused pane of the editor counts as the current view.
  const paneView = state?.view === 'notes' && activeTab?.resource?.type === 'view' ? activeTab.resource : undefined;
  const showing = (view: string, collectionId?: string) => state?.view === view && (view !== 'database' || state.collectionId === collectionId)
    || paneView?.view === view && (view !== 'database' || paneView.collectionId === collectionId);
  const newTab = (event: ReactMouseEvent) => event.ctrlKey || event.metaKey;

  type ItemOptions = {
    id: string; icon: string; title: string; count?: number; active: boolean; extra?: ReactNode;
    /** The page it opens as a tab; `nav`/`collection` route the click through the global navigation (Ctrl/Cmd: new tab). */
    view?: PageId; collectionId?: string; nav?: string; collection?: string;
    onClick?: (newTab: boolean) => void; onBeside?: () => void;
  };
  const item = (options: ItemOptions) => {
    const beside = options.onBeside || (options.view ? () => void openPage(options.view!, { collectionId: options.collectionId, beside: true }) : undefined);
    return <div key={options.id} className={`sidebar-row ${options.active ? 'active' : ''}`}>
      <button className={`nav-item ${options.active ? 'active' : ''}`} aria-label={options.title} data-tooltip={options.title}
        title={beside ? `${options.title} — Ctrl+click: new tab` : undefined}
        aria-current={options.active ? 'page' : undefined} data-nav={options.nav} data-collection-nav={options.collection}
        onClick={event => { onNavigate(); options.onClick?.(newTab(event)); }}>
        <span className="nav-icon"><Icon size={14} name={options.icon}/></span><span className="nav-copy"><strong>{options.title}</strong></span>
        {options.extra}{options.count !== undefined && <span className="navigation-count">{options.count}</span>}
      </button>
      {beside && <button className="sidebar-beside" title="Open to the side" aria-label={`Open ${options.title} to the side`} onClick={() => { onNavigate(); beside(); }}><Icon name="panel" size={12}/></button>}
    </div>;
  };
  // A page of the registry: its title and icon come from there (a collection may have its own icon).
  const view = (id: PageId, count?: number, icon = pages[id].icon) =>
    item({ id, icon, title: pages[id].title, count, nav: id, view: id, active: showing(id) });

  const section = (id: string, title: string, children: ReactNode, action?: ReactNode, onTitle?: () => void) =>
    <section className={`research-nav-section sidebar-section ${isFolded(id) ? 'folded' : ''}`} aria-label={title}>
      <div className="nav-group-label sidebar-section-head">
        <button className="sidebar-section-toggle" aria-expanded={!isFolded(id)} aria-label={`${isFolded(id) ? 'Show' : 'Hide'} ${title}`} onClick={() => toggleSection(id)}><Icon name="chevron" size={10}/></button>
        {onTitle ? <button className="sidebar-section-title" onClick={() => { onNavigate(); onTitle(); }}>{title}</button> : <span className="sidebar-section-title">{title}</span>}
        {action}
      </div>
      {!isFolded(id) && children}
    </section>;

  const databaseIcon = (id: string, fallback: string) => {
    const database = state?.databases.find((entry: any) => entry.id === id);
    return database ? collectionIcon(database) : fallback;
  };
  const collectionShown = (id: string) => !state?.databases.length || state.databases.some((entry: any) => entry.id === id);
  const customDatabases = runtime?.collectionDatabaseDefinitions().filter(
    (database: any) => database.storage?.driver === 'json-files' && !['resources', 'codes'].includes(database.id),
  ) || [];

  const scopedTasks = (state?.tasks || []).filter((task: any) => task.status !== 'done' && !task.archived_at && (!scope || task.project_id === scope.id));
  const scopedPapers = scope ? (state?.papers || []).filter((paper: any) => (paper.projects || []).some((project: any) => project.id === scope.id)) : state?.papers || [];

  // A linked folder has its own tab: a click shows it in the active tab, Ctrl/Cmd+click in a new one.
  const openFolder = (folder: Linked, how: 'here' | 'tab' | 'beside' = 'here') => {
    onNavigate();
    setAtelierIntent(folder.projectId, 'code', { folderId: folder.id });
    void (how === 'beside' ? openAtelierBeside(folder.projectId, 'code', pane, folder.id)
      : openAtelier(folder.projectId, 'code', undefined, { newTab: how === 'tab', folderId: folder.id }));
  };
  const linkTo = (projectId: number, kind: Kind) => {
    onNavigate();
    setAtelierIntent(projectId, 'code', { add: kind });
    void openAtelier(projectId, 'code');
  };
  const linkButton = (kind: Kind) => {
    const title = kind === 'code' ? 'Link a repository, a folder or a script' : 'Link documents or data: a folder or a file';
    if (scope) return <button aria-label={title} title={title} onClick={() => linkTo(scope.id, kind)}>＋</button>;
    if (!projects.length) return <button aria-label={title} title={title} data-action="new-project">＋</button>;
    return <Menu label={title} menuClassName="sidebar-menu" button={(open, toggle) => <button aria-label={title} title={title} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>＋</button>}>
      {close => <><small>Link to a project</small>{projects.map(project => <button key={project.id} role="menuitem" onClick={() => { close(); linkTo(project.id, kind); }}>
        <span className="project-sidebar-dot" style={{ background: workspaceColor(project.color) }}/><span>{project.name}</span>
      </button>)}</>}
    </Menu>;
  };
  const folderRows = (kind: Kind) => {
    const folders = linked.filter(folder => (folder.kind || 'code') === kind);
    if (!folders.length) return <p className="sidebar-hint">{kind === 'code' ? 'Repositories, scripts…' : 'Documents, data, papers…'}</p>;
    return <nav aria-label={kind === 'code' ? 'Code' : 'Resources'}>{folders.map(folder => {
      const active = here?.section === 'code' && here.projectId === folder.projectId && here.folderId === folder.id;
      return <div key={`${folder.projectId}:${folder.id}`} className={`sidebar-row ${active ? 'active' : ''}`}>
        <button className={`nav-item ${active ? 'active' : ''}`} title={folder.path} data-tooltip={folder.name} onClick={event => openFolder(folder, newTab(event) ? 'tab' : 'here')}>
          <span className="nav-icon"><Icon size={14} name={folder.file ? 'notes' : kind === 'code' ? 'code' : 'folder'}/></span>
          <span className="nav-copy"><strong>{folder.name}</strong></span>
          {!folder.available ? <small className="sidebar-row-meta atelier-warning-text">unavailable</small>
            : folder.is_git && folder.changes.length ? <small className="sidebar-row-meta">{folder.changes.length}●</small>
            : !scope && <small className="sidebar-row-meta">{folder.projectName}</small>}
        </button>
        <button className="sidebar-beside" title="Open to the side" aria-label={`Open ${folder.name} to the side`} onClick={() => openFolder(folder, 'beside')}><Icon name="panel" size={12}/></button>
      </div>;
    })}</nav>;
  };

  return <div className="sidebar-scroll">
    <ScopeSwitcher projects={projects} scope={scope} onScope={id => void runtime?.setScope(id)}/>
    <nav className="primary-nav" aria-label="Workspace navigation">
      {scope ? item({ id: 'home', icon: 'home', title: 'Project home', active: here?.section === 'project',
          onClick: tab => void openAtelier(scope.id, 'project', undefined, { newTab: tab }), onBeside: () => void openAtelierBeside(scope.id, 'project', pane) })
        : view('dashboard')}
      {view('chat')}
      {view('tasks', scopedTasks.length)}
      {view('calendar')}
      {view('watchers')}
      {item({ id: 'workflows', icon: pages.workflows.icon, title: pages.workflows.title, view: 'workflows', active: showing('workflows'), count: state?.workflows?.length || 0,
        extra: state?.workflows?.some((flow: any) => flow.running) && <span className="nav-running" aria-label="Running"/>,
        onClick: tab => { if (state) state.workflowId = null; void navigate('workflows', { newTab: tab }); } })}
    </nav>
    {section('collections', 'Collections', <nav aria-label="Research collections">
      {view('papers', scopedPapers.length, databaseIcon('articles', pages.papers.icon))}
      {collectionShown('conferences') && view('conferences', state?.conferences.length, databaseIcon('conferences', pages.conferences.icon))}
      {collectionShown('datasets') && view('datasets', state?.datasets.length, databaseIcon('datasets', pages.datasets.icon))}
      {customDatabases.map((database: any) => item({ id: `collection:${database.id}`, icon: collectionIcon(database), title: database.name, collection: database.id,
        view: 'database', collectionId: database.id, active: showing('database', database.id), count: runtime?.collectionItems(database.id).length }))}
    </nav>, <button className="sidebar-section-add" aria-label="New collection" title="New collection" onClick={() => { onNavigate(); onNewCollection(); }}>＋</button>)}
    {section('code', 'Code', folderRows('code'), linkButton('code'))}
    {section('resources', 'Resources', folderRows('resources'), linkButton('resources'))}
    {section('files', 'Notes & Files', null, undefined, () => void navigate('notes'))}
    {/* The collapsed ribbon has no room for the explorer: one icon goes back to the open documents. */}
    {collapsed && <nav className="sidebar-rail-only" aria-label="Notes and files">{item({ id: 'notes', icon: 'notes', title: 'Notes & Files', nav: 'notes', active: state?.view === 'notes' && !here && !paneView })}</nav>}
    {/* Outside React's reach: the editor engine owns the explorer's content and its events. */}
    <div className={`notes-sidebar sidebar-explorer ${isFolded('files') || collapsed ? 'hidden' : ''}`}>
      {runtime && <div className="sidebar-explorer-tools" dangerouslySetInnerHTML={{ __html: runtime.notesExplorerToolbar() }}/>}
      <div className="notes-tree" id="notes-tree"/>
      <div className="note-search-results hidden" id="note-items" aria-live="polite"/>
    </div>
  </div>;
}
