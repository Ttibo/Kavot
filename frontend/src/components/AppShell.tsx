import { RecordSheet } from './RecordSheet';
import { lazy, Suspense, useEffect, useRef, useState, type MouseEvent } from 'react';
import { useOptionalRuntime } from '../app/runtime';
import { currentProject } from '../app/projectContext';
import { Icon } from './Icon';
import { Sidebar } from './Sidebar';
import { WindowHeader } from './WindowHeader';
const SettingsView = lazy(() => import('../views/SettingsView').then(module => ({ default: module.SettingsView })));
const NewCollectionDialog = lazy(() => import('./CustomCollectionCreator').then(module => ({ default: module.NewCollectionDialog })));

export function AppShell() {
  const runtime = useOptionalRuntime();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newCollectionOpen, setNewCollectionOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('kavot-sidebar-collapsed') === 'true');
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
  const state = runtime?.state;
  const project = currentProject(runtime);
  // The sidebar holds the file explorer too: its width is the user's, kept between sessions.
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem('kavot-sidebar-width'));
    return Number.isFinite(saved) && saved >= 200 && saved <= 480 ? saved : 260;
  });
  useEffect(() => { document.documentElement.style.setProperty('--research-sidebar-width', `${sidebarWidth}px`); }, [sidebarWidth]);
  const resizeSidebar = (width: number) => {
    const next = Math.max(200, Math.min(480, Math.round(width)));
    setSidebarWidth(next);
    localStorage.setItem('kavot-sidebar-width', String(next));
  };
  const sidebarDrag = useRef(false);
  const openSettings = (tab: string) => { if (state) state.settingsTab = tab; setMobileOpen(false); setSettingsOpen(true); };
  useEffect(() => {
    const showSettings = () => setSettingsOpen(true);
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setSettingsOpen(false); setMobileOpen(false); }
      if (event.key === '\\' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); toggleSidebar(); }
    };
    // The file search shows its results in the sidebar: typing in it opens a collapsed sidebar.
    const search = (event: Event) => {
      const input = event.target as HTMLInputElement;
      if (input?.id === 'note-filter' && input.value) setSidebarCollapsed(collapsed => { if (collapsed) localStorage.setItem('kavot-sidebar-collapsed', 'false'); return false; });
    };
    window.addEventListener('kavot:open-settings', showSettings);
    document.addEventListener('keydown', escape);
    document.addEventListener('input', search);
    return () => { window.removeEventListener('kavot:open-settings', showSettings); document.removeEventListener('keydown', escape); document.removeEventListener('input', search); };
  }, []);
  return <><WindowHeader sidebarCollapsed={sidebarCollapsed} onToggleSidebar={toggleSidebar}/><div className={`app-shell research-shell ${project ? 'has-project' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
    {mobileOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)}/>}
    <aside id="sidebar" className={`sidebar research-sidebar ${mobileOpen ? 'open' : ''}`} onMouseOver={showRailTip} onMouseLeave={() => setRailTip(null)} onClick={() => setRailTip(null)}>
      <div className="sidebar-mobile-head mobile-only"><button className="icon-button" id="close-sidebar" aria-label="Close menu" onClick={() => setMobileOpen(false)}><Icon name="close" size={14}/></button></div>
      <Sidebar collapsed={sidebarCollapsed && !mobileOpen} onNavigate={() => setMobileOpen(false)} onNewCollection={() => setNewCollectionOpen(true)}/>
<div className="sidebar-footer"><button className={`nav-item ${settingsOpen ? 'active' : ''}`} aria-label="Settings" data-tooltip="Settings" onClick={() => openSettings('general')}><span className="nav-icon"><Icon name="settings" size={14}/></span><span className="nav-copy"><strong>Settings</strong></span></button><button className={`nav-item ${state?.view === 'trash' ? 'active' : ''}`} data-nav="trash" aria-label="Trash" data-tooltip="Trash" onClick={() => setMobileOpen(false)}><span className="nav-icon"><Icon name="trash" size={14}/></span><span className="nav-copy"><strong>Trash</strong></span></button><div className="sidebar-local"><span className="local-indicator"/>Private, local workspace</div></div>
      {!sidebarCollapsed && <div className="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="Resize the sidebar" aria-valuemin={200} aria-valuemax={480} aria-valuenow={sidebarWidth} tabIndex={0}
        onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); sidebarDrag.current = true; event.currentTarget.setPointerCapture(event.pointerId); document.body.classList.add('resizing-notes'); }}
        onPointerMove={event => { if (sidebarDrag.current) resizeSidebar(event.clientX); }}
        onPointerUp={event => { sidebarDrag.current = false; event.currentTarget.releasePointerCapture(event.pointerId); document.body.classList.remove('resizing-notes'); }}
        onLostPointerCapture={() => { sidebarDrag.current = false; document.body.classList.remove('resizing-notes'); }}
        onDoubleClick={() => resizeSidebar(260)}
        onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resizeSidebar(sidebarWidth + (event.key === 'ArrowRight' ? 20 : -20)); } }}/>}
    </aside>
    {railTip && sidebarCollapsed && <div className="sidebar-rail-tooltip" role="tooltip" style={{ top: railTip.top, left: railTip.left }}>{railTip.text}</div>}
    <div className="workspace">
      <button className="mobile-workspace-menu" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Icon name="menu" size={18}/></button>
      <div className="research-frame"><div className="research-main"><main id="main-content" tabIndex={-1}/><RecordSheet/></div></div>
    </div>
  </div>{newCollectionOpen && <Suspense fallback={null}><NewCollectionDialog onClose={() => setNewCollectionOpen(false)}/></Suspense>}{settingsOpen && <div className="modal-backdrop settings-dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setSettingsOpen(false); }}><section className="modal modal-wide modal-settings settings-dialog" role="dialog" aria-modal="true" aria-label="Settings"><button className="modal-close" aria-label="Close settings" onClick={() => setSettingsOpen(false)}>×</button><Suspense fallback={<p role="status">Loading settings…</p>}><SettingsView/></Suspense></section></div>}<div className="modal-backdrop hidden" id="modal-backdrop" role="presentation"><section className="modal" id="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><button className="modal-close" id="modal-close" aria-label="Close">×</button><div id="modal-content"/></section></div><div className="toast-region" id="toast-region" aria-live="polite"/></>;
}
