import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useOptionalRuntime } from '../app/runtime';
import { subscribe } from '../app/viewBridge';
import { Icon } from './Icon';
import '../styles/components/window-header.css';

type TitlebarTab = { id: string; label: string; icon: string; active: boolean };
type TabGroup = { pane: string; left: number; width: number; tabs: TitlebarTab[]; draggable: boolean };
type Titlebar = { groups: TabGroup[]; title: string; icon: string };

const VIEW_LABELS: Record<string, [string, string]> = {
  dashboard: ['Research Home', 'home'], notes: ['Workspace', 'canvas'], projects: ['Projects', 'projects'],
  calendar: ['Calendar', 'calendar'], tasks: ['Tasks', 'tasks'], papers: ['Library', 'papers'],
  watchers: ['Watchers', 'sparkle'], workflows: ['Workflows', 'workflow'], chat: ['Chat', 'chat'],
  conferences: ['Conferences', 'conferences'], datasets: ['Datasets', 'database'], database: ['Collection', 'database'],
  settings: ['Settings', 'settings'], trash: ['Trash', 'trash'],
};

function tabLabel(state: any, tab: any) {
  if (tab.type === 'empty') return 'New tab';
  if (tab.type === 'note') return state.notes.find((note: any) => note.id === Number(tab.noteId))?.title || 'Note';
  return tab.resource?.title || tab.resource?.path?.split('/').pop() || 'Document';
}

function tabIcon(state: any, tab: any) {
  if (tab.type === 'note') return state.notes.find((note: any) => note.id === Number(tab.noteId))?.drawing ? 'canvas' : 'notes';
  if (tab.resource?.type === 'atelier') return ({ project: 'home', code: 'code', agents: 'agents', tasks: 'tasks' } as Record<string, string>)[tab.resource.section] || 'code';
  return tab.resource?.type === 'canvas' ? 'canvas' : 'notes';
}

/** Every editor pane's tabs move to the titlebar, each group placed above its own pane. */
function readTitlebar(state: any, zone: HTMLElement | null): Titlebar {
  const [viewTitle, viewIcon] = VIEW_LABELS[state?.view] || ['Kavot', 'home'];
  const title = state?.selectedProject?.name ? `${state.selectedProject.name} · ${viewTitle}` : viewTitle;
  const groups: TabGroup[] = [];
  if (state && zone) {
    const origin = zone.getBoundingClientRect();
    const split = Boolean(state.secondaryResource || state.workspaceTabs.secondary.length);
    for (const pane of ['primary', 'secondary']) {
      const element = document.querySelector<HTMLElement>(`#main-content [data-workspace-pane="${pane}"]`);
      if (!element || !state.workspaceTabs[pane].length) continue;
      const rect = element.getBoundingClientRect();
      const left = Math.max(0, Math.round(rect.left - origin.left));
      const width = Math.max(0, Math.round(Math.min(rect.right, origin.right) - origin.left) - left);
      const active = state.workspaceActiveTabs[pane];
      groups.push({
        pane, left, width, draggable: split,
        tabs: state.workspaceTabs[pane].map((tab: any) => ({ id: String(tab.id), label: tabLabel(state, tab), icon: tabIcon(state, tab), active: tab.id === active })),
      });
    }
  }
  return { groups, title, icon: viewIcon };
}

type DraggedTab = { pane: string; id: string };
let draggedTab: DraggedTab | null = null;
const moveTab = (tab: DraggedTab, pane: string, index = -1) =>
  import('../features/documents/workspace').then(module => module.moveWorkspaceTab(tab.pane, tab.id, pane, index));

/** Where a dragged tab lands over the editor: the pane under the pointer, or a new right pane when there is only one. */
function editorDropTarget(event: DragEvent, state: any) {
  const pane = (event.target as HTMLElement).closest?.('#main-content [data-workspace-pane]') as HTMLElement | null;
  if (!draggedTab || !pane || !state) return null;
  const single = !state.workspaceTabs.secondary.length;
  const rect = pane.getBoundingClientRect();
  if (single && event.clientX > rect.left + rect.width / 2) {
    // Splitting needs another tab left behind in the first pane.
    return state.workspaceTabs.primary.length > 1 ? { pane: 'secondary', element: pane, split: true } : null;
  }
  const target = pane.dataset.workspacePane!;
  return target === draggedTab.pane ? null : { pane: target, element: pane, split: false };
}

/** Open Notes if needed, then put the cursor in the file search. */
function focusNoteSearch() {
  const started = performance.now();
  const focus = () => {
    const input = document.querySelector<HTMLInputElement>('#note-filter');
    if (input) { input.focus(); input.select(); return; }
    if (performance.now() - started < 2000) requestAnimationFrame(focus);
  };
  if (!document.querySelector('#note-filter')) document.querySelector<HTMLElement>('.research-sidebar [data-nav="notes"]')?.click();
  focus();
}

export function WindowHeader({ sidebarCollapsed, onToggleSidebar, agentOpen, onToggleAgent }: {
  sidebarCollapsed: boolean; onToggleSidebar: () => void; agentOpen: boolean; onToggleAgent: () => void;
}) {
  const runtime = useOptionalRuntime();
  const [native, setNative] = useState(false);
  const [mac, setMac] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState('');
  const [bar, setBar] = useState<Titlebar>(() => readTitlebar(null, null));
  const [dropAt, setDropAt] = useState<{ pane: string; index: number } | null>(null);
  const zone = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; anchor: number; pointerId: number } | null>(null);

  useEffect(() => {
    let nativeState: NonNullable<Window['pywebview']>['state'];
    const sync = () => setMaximized(Boolean(nativeState?.maximized));
    const ready = () => {
      if (!window.pywebview?.api?.close_window) return;
      setMac(window.pywebview.platform === 'cocoa');
      setNative(true);
      document.documentElement.classList.add('has-window-header');
      nativeState?.removeEventListener('change', sync);
      nativeState = window.pywebview.state;
      nativeState?.addEventListener('change', sync);
      sync();
    };
    ready();
    window.addEventListener('pywebviewready', ready);
    return () => {
      window.removeEventListener('pywebviewready', ready);
      nativeState?.removeEventListener('change', sync);
      document.documentElement.classList.remove('has-window-header');
    };
  }, []);

  // Views render outside React, so follow bridge publications, DOM swaps and pane resizes.
  useEffect(() => {
    let frame = 0;
    let signature = '';
    const refresh = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const next = readTitlebar(runtime?.state, zone.current);
        const nextSignature = JSON.stringify(next);
        if (nextSignature === signature) return;
        signature = nextSignature;
        document.documentElement.classList.toggle('titlebar-hosts-tabs', next.groups.length > 0);
        setBar(next);
      });
    };
    refresh();
    const unsubscribe = subscribe(refresh);
    const main = document.getElementById('main-content');
    const mutations = new MutationObserver(refresh);
    if (main) mutations.observe(main, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
    const sizes = new ResizeObserver(refresh);
    if (main) sizes.observe(main);
    if (zone.current) sizes.observe(zone.current);
    document.addEventListener('click', refresh);
    document.addEventListener('pointerup', refresh);
    window.addEventListener('resize', refresh);
    return () => {
      unsubscribe(); mutations.disconnect(); sizes.disconnect(); cancelAnimationFrame(frame);
      document.removeEventListener('click', refresh);
      document.removeEventListener('pointerup', refresh);
      window.removeEventListener('resize', refresh);
      document.documentElement.classList.remove('titlebar-hosts-tabs');
    };
  }, [runtime]);

  // Tabs dragged from the titlebar can be dropped on an editor pane.
  useEffect(() => {
    let marked: HTMLElement | null = null;
    const clear = () => { marked?.classList.remove('tab-drop-target', 'tab-drop-split'); marked = null; };
    const over = (event: DragEvent) => {
      const target = editorDropTarget(event, runtime?.state);
      if (!target) { clear(); return; }
      event.preventDefault(); event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      if (marked !== target.element) clear();
      marked = target.element;
      marked.classList.add(target.split ? 'tab-drop-split' : 'tab-drop-target');
      marked.classList.toggle('tab-drop-target', !target.split);
    };
    const drop = (event: DragEvent) => {
      const target = editorDropTarget(event, runtime?.state);
      clear();
      if (!target || !draggedTab) return;
      event.preventDefault(); event.stopPropagation();
      void moveTab(draggedTab, target.pane);
      draggedTab = null;
    };
    const end = () => { clear(); draggedTab = null; setDropAt(null); };
    document.addEventListener('dragover', over, true);
    document.addEventListener('drop', drop, true);
    document.addEventListener('dragend', end);
    return () => { document.removeEventListener('dragover', over, true); document.removeEventListener('drop', drop, true); document.removeEventListener('dragend', end); };
  }, [runtime]);

  const tabIndexAt = (list: HTMLElement, clientX: number) => {
    const tabs = [...list.querySelectorAll<HTMLElement>('.titlebar-tab')];
    const index = tabs.findIndex(tab => { const rect = tab.getBoundingClientRect(); return clientX < rect.left + rect.width / 2; });
    return index < 0 ? tabs.length : index;
  };

  const command = async (action: 'minimize_window' | 'toggle_maximize_window' | 'close_window') => {
    try {
      setError('');
      await window.pywebview?.api?.[action]?.();
    } catch {
      setError('The window command failed. Try again.');
    }
  };

  // Only empty titlebar space moves the window: buttons and tabs keep their own clicks.
  const isDragSurface = (target: EventTarget) => !(target as HTMLElement).closest('button, a, input, [role="tab"], [draggable="true"]');
  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (mac || event.button !== 0 || !window.pywebview?.api?.move_window || !isDragSurface(event.target)) return;
    drag.current = { x: event.clientX, y: event.clientY, anchor: event.clientX / window.innerWidth, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4) return;
    drag.current = null;
    void window.pywebview?.api?.move_window?.(start.anchor, start.y).catch(() => setError('Moving the window failed.'));
  };
  const endDrag = () => { drag.current = null; };

  const controls = native && <div className="window-controls">
    <button type="button" aria-label="Minimize" title="Minimize" onClick={() => void command('minimize_window')}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5h10"/></svg></button>
    <button type="button" aria-label={maximized ? 'Restore' : 'Agrandir'} title={maximized ? 'Restore' : 'Agrandir'} onClick={() => void command('toggle_maximize_window')}><svg viewBox="0 0 16 16" aria-hidden="true">{maximized ? <path d="M5.5 5.5v-3h8v8h-3m-8-5h8v8h-8z"/> : <rect x="3.5" y="3.5" width="9" height="9"/>}</svg></button>
    <button type="button" className="window-close" aria-label="Close" title="Close" onClick={() => void command('close_window')}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 3.5 9 9m0-9-9 9"/></svg></button>
  </div>;

  // On Windows the captured pointer drives the native move command; Cocoa keeps pywebview dragging.
  return <header className={`titlebar window-header${mac ? ' window-header-macos' : ''}${maximized ? ' is-maximized' : ''}`} aria-label="Kavot title bar"
    onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
    onDoubleClick={event => { if (native && isDragSurface(event.target)) void command('toggle_maximize_window'); }}>
    <div className={`titlebar-lead${sidebarCollapsed ? ' is-collapsed' : ''}`}>
      <button type="button" className="titlebar-brand" data-nav="dashboard" aria-label="Kavot home" title="Research Home"><span className="brand-mark">{/* Drawn inline so it follows the accent color. */}<svg viewBox="0 0 32 36" width="14" height="16" aria-hidden="true"><path className="brand-mark-letter" d="M3 3h7v12L20 3h9L16 18l13 15h-9L10 21v12H3V3Z"/><path className="brand-mark-dot" d="m27 17 3 3-3 3-3-3 3-3Z"/></svg></span><span className="titlebar-brand-name">Kavot</span></button>
      <button type="button" className="titlebar-button" aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'} title="Sidebar (Ctrl+\)" aria-pressed={!sidebarCollapsed} onClick={onToggleSidebar}><Icon name="sidebar" size={15}/></button>
      <button type="button" className="titlebar-button" aria-label="Back" title="Back (Alt+←)" onClick={() => window.history.back()}><Icon name="back" size={15}/></button>
      <button type="button" className="titlebar-button" aria-label="Forward" title="Forward (Alt+→)" onClick={() => window.history.forward()}><Icon name="chevron" size={15}/></button>
    </div>
    <div className="titlebar-tabs" ref={zone}>
      <div className={`titlebar-drag-fill${mac ? ' pywebview-drag-region' : ''}`}/>
      {bar.groups.length ? bar.groups.map(group => <div key={group.pane} className={`titlebar-tab-group${mac ? ' pywebview-drag-region' : ''}${dropAt?.pane === group.pane ? ' is-drop-target' : ''}`} data-tabs-pane={group.pane} style={{ left: group.left, width: group.width }}
        onDragOver={event => { if (!draggedTab) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; const list = event.currentTarget.querySelector<HTMLElement>('.titlebar-tab-list')!; setDropAt({ pane: group.pane, index: tabIndexAt(list, event.clientX) }); }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropAt(null); }}
        onDrop={event => { if (!draggedTab) return; event.preventDefault(); const list = event.currentTarget.querySelector<HTMLElement>('.titlebar-tab-list')!; void moveTab(draggedTab, group.pane, tabIndexAt(list, event.clientX)); draggedTab = null; setDropAt(null); }}>
        <div className="titlebar-tab-list" role="tablist" aria-label={group.pane === 'primary' ? 'Primary pane tabs' : 'Secondary pane tabs'}>
          {group.tabs.map((tab, index) => <span key={tab.id} className={`workspace-tab titlebar-tab${tab.active ? ' active' : ''}${dropAt?.pane === group.pane && dropAt.index === index ? ' drop-before' : ''}${dropAt?.pane === group.pane && dropAt.index === group.tabs.length && index === group.tabs.length - 1 ? ' drop-after' : ''}`}
            draggable="true" data-tab-drag={tab.id}
            onDragStart={event => {
              if ((event.target as HTMLElement).closest('.pane-drag-handle')) return;
              draggedTab = { pane: group.pane, id: tab.id };
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('application/x-kavot-tab', JSON.stringify(draggedTab));
            }}>
            <button type="button" role="tab" aria-selected={tab.active} data-workspace-tab={tab.id} data-workspace-tab-pane={group.pane} title={tab.label}><Icon name={tab.icon} size={13}/><strong>{tab.label}</strong></button>
            {tab.active && group.draggable && <span className="pane-drag-handle" draggable="true" data-pane-drag={group.pane} title="Move this panel" aria-label="Move this panel"><Icon name="grip" size={12}/></span>}
            <button type="button" className="workspace-tab-close" data-close-workspace-tab={tab.id} data-workspace-tab-pane={group.pane} aria-label="Close tab" title="Close tab">×</button>
          </span>)}
        </div>
        <button type="button" className="titlebar-button titlebar-new-tab" data-new-workspace-tab={group.pane} aria-label="New tab" title="New tab"><Icon name="plus" size={14}/></button>
      </div>) : <span className="titlebar-title"><Icon name={bar.icon} size={13}/><strong>{bar.title}</strong></span>}
    </div>
    {error && <span className="window-header-error" role="alert">{error}</span>}
    <div className="titlebar-trail">
      {runtime?.state?.view === 'notes'
        ? <label className="titlebar-search"><Icon name="search" size={13}/><input id="note-filter" type="search" placeholder="Search files…" aria-label="Search notes"/></label>
        : <button type="button" className="titlebar-button" aria-label="Search" title="Search notes" onClick={focusNoteSearch}><Icon name="search" size={15}/></button>}
      <button type="button" className={`titlebar-button${agentOpen ? ' is-active' : ''}`} aria-label={agentOpen ? 'Close assistant' : 'Open assistant'} title="Assistant" aria-pressed={agentOpen} onClick={onToggleAgent}><Icon name="sparkle" size={15}/></button>
    </div>
    {controls}
  </header>;
}
