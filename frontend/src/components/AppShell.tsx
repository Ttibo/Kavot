import { RecordSheet } from './RecordSheet';
import { collectionIcon } from '../features/collections/icons';
import { lazy, Suspense, useEffect, useState, type MouseEvent } from 'react';
import { useOptionalRuntime } from '../app/runtime';
import { currentProject } from '../app/projectContext';
import { navigate, refreshData, toast } from '../app/navigation';
import { api } from '../services/api';
import { Icon } from './Icon';
import { WindowHeader } from './WindowHeader';
const SettingsView = lazy(() => import('../views/SettingsView').then(module => ({ default: module.SettingsView })));
const AgentPanel = lazy(() => import('./AgentPanel').then(module => ({ default: module.AgentPanel })));

export function AppShell() {
  const runtime = useOptionalRuntime();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentMounted, setAgentMounted] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('kavot-sidebar-collapsed') !== 'false');
  const [railTip, setRailTip] = useState<{ text: string; top: number; left: number } | null>(null);
  // The collapsed ribbon names the hovered entry at once; native titles are slow and get clipped.
  const showRailTip = (event: MouseEvent) => {
    const target = sidebarCollapsed ? (event.target as HTMLElement).closest<HTMLElement>('[data-tooltip]') : null;
    if (!target) return setRailTip(null);
    const box = target.getBoundingClientRect();
    setRailTip({ text: target.dataset.tooltip || '', top: box.top + box.height / 2, left: box.right + 8 });
  };
  const toggleSidebar = () => {
    // Narrow windows use the sidebar as an overlay drawer instead of a ribbon.
    if (window.matchMedia('(max-width: 820px)').matches) return setMobileOpen(open => !open);
    setSidebarCollapsed(collapsed => { localStorage.setItem('kavot-sidebar-collapsed', String(!collapsed)); return !collapsed; });
  };
  useEffect(() => { if (agentOpen) setAgentMounted(true); }, [agentOpen]);
  const [agentWidth, setAgentWidth] = useState(() => {
    const saved = Number(localStorage.getItem('kavot-agent-panel-width'));
    return Number.isFinite(saved) && saved >= 300 && saved <= 760 ? saved : 360;
  });
  const state = runtime?.state;
  const openWorkflow = (id: number) => { if (state) state.workflowId = id; void navigate('workflows'); };
  const createWorkflow = async () => {
    try {
      const flow = await api<{ id: number }>('/workflows', { method: 'POST', body: JSON.stringify({
        name: 'New workflow', nodes: [{ id: Math.random().toString(36).slice(2, 10), type: 'start', x: 60, y: 160, label: '', config: {} }], edges: [] }) });
      await refreshData();
      openWorkflow(flow.id);
    } catch (error) { toast((error as Error).message, 'error'); }
  };
  const project = currentProject(runtime);
  const customDatabases = runtime?.collectionDatabaseDefinitions().filter(
    (database: any) => database.storage?.driver === 'json-files' && !['resources', 'codes'].includes(database.id),
  ) || [];
  useEffect(() => {
    const showSettings = () => setSettingsOpen(true);
    const showAssistant = () => setAgentOpen(true);
    window.addEventListener('kavot:assistant-suggestion', showAssistant);
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setSettingsOpen(false); setMobileOpen(false); }
      if (event.key === '\\' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); toggleSidebar(); }
    };
    window.addEventListener('kavot:open-settings', showSettings);
    document.addEventListener('keydown', escape);
    return () => { window.removeEventListener('kavot:assistant-suggestion', showAssistant); window.removeEventListener('kavot:open-settings', showSettings); document.removeEventListener('keydown', escape); };
  }, []);
  const nav = (id: string, icon: string, title: string, count?: number) => <button key={id} className={`nav-item ${state?.view === id && (!project || id === 'notes') ? 'active' : ''}`} data-nav={id} aria-label={title} data-tooltip={title} onClick={() => setMobileOpen(false)}><span className="nav-icon"><Icon size={14} name={state?.databases.find(item => item.id === (id === 'papers' ? 'articles' : id)) ? collectionIcon(state.databases.find(item => item.id === (id === 'papers' ? 'articles' : id))) : icon}/></span><span className="nav-copy"><strong>{title}</strong></span>{count !== undefined && <span className="navigation-count">{count}</span>}</button>;
  // Conferences and Datasets can be removed in the settings; they stay visible while the catalog is not loaded.
  const collectionShown = (id: string) => !state?.databases.length || state.databases.some((item: any) => item.id === id);
  const resizeAgent = (width: number) => {
    const next = Math.max(300, Math.min(760, Math.round(width)));
    setAgentWidth(next);
    localStorage.setItem('kavot-agent-panel-width', String(next));
  };
  return <><WindowHeader sidebarCollapsed={sidebarCollapsed} onToggleSidebar={toggleSidebar} agentOpen={agentOpen} onToggleAgent={() => setAgentOpen(open => !open)}/><div className={`app-shell research-shell ${project ? 'has-project' : ''} ${agentOpen ? 'agent-open' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
    {mobileOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)}/>}
    <aside id="sidebar" className={`sidebar research-sidebar ${mobileOpen ? 'open' : ''}`} onMouseOver={showRailTip} onMouseLeave={() => setRailTip(null)} onClick={() => setRailTip(null)}>
      <div className="sidebar-mobile-head mobile-only"><button className="icon-button" id="close-sidebar" aria-label="Close menu" onClick={() => setMobileOpen(false)}><Icon name="close" size={14}/></button></div>
      <div className="sidebar-scroll"><nav className="primary-nav" aria-label="Workspace navigation">{nav('dashboard', 'home', 'Research Home')}{nav('notes', 'canvas', 'Workspace', state?.notes.length)}{nav('calendar', 'calendar', 'Calendar')}{nav('tasks', 'tasks', 'Tasks', state?.tasks.filter(task => task.status !== 'done').length)}</nav>
      <section className="research-nav-section" aria-label="Collections"><div className="nav-group-label">Collections<button aria-label="New collection" onClick={() => { if (state) state.settingsTab = 'databases'; setSettingsOpen(true); }}>＋</button></div><nav aria-label="Research collections">{nav('papers', 'papers', 'Library', state?.papers.length)}{collectionShown('conferences') && nav('conferences', 'conferences', 'Conferences', state?.conferences.length)}{collectionShown('datasets') && nav('datasets', 'database', 'Datasets', state?.datasets.length)}{customDatabases.map((database: any) => <button key={database.id} aria-label={database.name} data-tooltip={database.name} className={`nav-item ${state?.view === 'database' && !project && state.collectionId === database.id ? 'active' : ''}`} data-collection-nav={database.id} onClick={() => setMobileOpen(false)}><span className="nav-icon"><Icon name={collectionIcon(database)} size={14}/></span><span className="nav-copy"><strong>{database.name}</strong></span><span className="navigation-count">{runtime?.collectionItems(database.id).length}</span></button>)}</nav></section>
      <section className="research-nav-section" aria-label="Agents"><div className="nav-group-label">Agents<button aria-label="New workflow" title="New workflow" onClick={() => void createWorkflow()}>＋</button></div><nav aria-label="Agents">{nav('chat', 'chat', 'Chat')}<button className={`nav-item ${state?.view === 'workflows' && !project ? 'active' : ''}`} aria-label="Workflows" data-tooltip="Workflows" onClick={() => { setMobileOpen(false); if (state) state.workflowId = null; void navigate('workflows'); }}><span className="nav-icon"><Icon name="workflow" size={14}/></span><span className="nav-copy"><strong>Workflows</strong></span>{state?.workflows?.some((flow: any) => flow.running) && <span className="nav-running" aria-label="Running"/>}<span className="navigation-count">{state?.workflows?.length || 0}</span></button>{nav('watchers', 'sparkle', 'Watchers')}</nav></section>
      </div><div className="sidebar-footer"><button className={`nav-item ${settingsOpen ? 'active' : ''}`} aria-label="Settings" data-tooltip="Settings" onClick={() => { if (state) state.settingsTab = 'general'; setMobileOpen(false); setSettingsOpen(true); }}><span className="nav-icon"><Icon name="settings" size={14}/></span><span className="nav-copy"><strong>Settings</strong></span></button>{nav('trash', 'trash', 'Trash')}<div className="sidebar-local"><span className="local-indicator"/>Private, local workspace</div></div>
    </aside>
    {railTip && sidebarCollapsed && <div className="sidebar-rail-tooltip" role="tooltip" style={{ top: railTip.top, left: railTip.left }}>{railTip.text}</div>}
    <div className="workspace">
      <button className="mobile-workspace-menu" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Icon name="menu" size={18}/></button>
      <div className="research-frame"><div className="research-main"><main id="main-content" tabIndex={-1}/><RecordSheet/></div>{agentMounted && <Suspense fallback={<p role="status">Loading the assistant…</p>}><AgentPanel hidden={!agentOpen} project={project} width={agentWidth} onResize={resizeAgent} onClose={() => setAgentOpen(false)}/></Suspense>}</div>
    </div>
  </div>{settingsOpen && <div className="modal-backdrop settings-dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setSettingsOpen(false); }}><section className="modal modal-wide modal-settings settings-dialog" role="dialog" aria-modal="true" aria-label="Settings"><button className="modal-close" aria-label="Close settings" onClick={() => setSettingsOpen(false)}>×</button><Suspense fallback={<p role="status">Loading settings…</p>}><SettingsView/></Suspense></section></div>}<div className="modal-backdrop hidden" id="modal-backdrop" role="presentation"><section className="modal" id="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><button className="modal-close" id="modal-close" aria-label="Close">×</button><div id="modal-content"/></section></div><div className="toast-region" id="toast-region" aria-live="polite"/></>;
}
