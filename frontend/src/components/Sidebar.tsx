import { useEffect, type MouseEvent as ReactMouseEvent } from 'react';
import { useOptionalRuntime } from '../app/runtime';
import { pages, type PageId } from '../app/pages';
import { Icon } from './Icon';
import '../styles/features/sidebar.css';

const PAGES: PageId[] = ['papers', 'chat', 'tasks', 'calendar'];

type Props = {
  /** The panel beside the ribbon (the tree) is hidden. */
  collapsed: boolean;
  settingsOpen: boolean;
  onToggle: () => void;
  onOpenSettings: () => void;
  onNavigate: () => void;
};

/** Like a vault: a narrow ribbon of icons (the pages, quick creation, the settings at the bottom),
 * and beside it the panel with the tree of notes and folders. The search is a finder dialog (QuickSearch). */
export function Sidebar({ collapsed, settingsOpen, onToggle, onOpenSettings, onNavigate }: Props) {
  const runtime = useOptionalRuntime();
  const state = runtime?.state;
  // The editor engine draws the explorer into the tree element; redraw it when its content changes.
  useEffect(() => { runtime?.rerenderWorkspaceTree(); }, [runtime, state?.workspaceTree, state?.projects]);

  const pane: 'primary' | 'secondary' = state?.activeNotePane === 'secondary' ? 'secondary' : 'primary';
  const activeTab = state?.workspaceTabs?.[pane]?.find((tab: any) => tab.id === state.workspaceActiveTabs?.[pane]);
  const shownPage = state?.view === 'notes' && activeTab?.resource?.type === 'view' ? activeTab.resource.view : state?.view;
  const openTasks = (state?.tasks || []).filter((task: any) => task.status !== 'done' && !task.archived_at).length;

  const button = (key: string, icon: string, title: string, onClick: (event: ReactMouseEvent) => void,
    options: { active?: boolean; badge?: number; attributes?: Record<string, string> } = {}) =>
    <button key={key} type="button" className={`ribbon-button ${options.active ? 'active' : ''}`} aria-label={title} title={title}
      aria-pressed={options.active} {...options.attributes} onClick={event => { onClick(event); onNavigate(); }}>
      <Icon name={icon} size={17}/>{options.badge ? <span className="ribbon-badge">{options.badge > 99 ? '99+' : options.badge}</span> : null}
    </button>;

  return <div className="sidebar-frame">
    <nav className="ribbon" aria-label="Pages and actions">
      {button('workspace', 'folder', collapsed ? 'Show the notes (Ctrl+\\)' : 'Hide the notes (Ctrl+\\)', onToggle, { active: !collapsed })}
      <span className="ribbon-separator" aria-hidden="true"/>
      {/* data-nav: the app opens the page (Ctrl+click: new tab), and its context menu offers a new tab or the other pane. */}
      {PAGES.map(id => button(id, pages[id].icon, `${pages[id].title} — right-click: open to the side`, () => {},
        { active: shownPage === id, badge: id === 'tasks' ? openTasks : undefined, attributes: { 'data-nav': id } }))}
      <span className="ribbon-separator" aria-hidden="true"/>
      {/* Creation goes into the folder selected in the tree, like the explorer's own buttons. */}
      {button('new-note', 'noteplus', 'New note', () => {}, { attributes: { 'data-tree-create': 'new-note' } })}
      {button('new-project', 'projects', 'New project', () => {}, { attributes: { 'data-action': 'new-project' } })}
      <span className="ribbon-spacer"/>
      {button('settings', 'settings', 'Settings', onOpenSettings, { active: settingsOpen })}
    </nav>
    {/* Outside React's reach: the editor engine owns the explorer's content and its events. */}
    <div className={`sidebar-panel ${collapsed ? 'hidden' : ''}`}>
      <div className="notes-sidebar sidebar-explorer">
        {runtime && <div className="sidebar-explorer-tools" dangerouslySetInnerHTML={{ __html: runtime.notesExplorerToolbar() }}/>}
        <div className="notes-tree" id="notes-tree"/>
        <div className="note-search-results hidden" id="note-items" aria-live="polite"/>
      </div>
    </div>
  </div>;
}
