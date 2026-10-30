import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRuntime } from '../../app/runtime';
import { workspaceColor } from '../../styles/palette';
import { Icon } from '../../components/Icon';
import { openAtelier, openAtelierBeside, openCanvasBeside, openProjectCanvas, type AtelierSection } from '../projects/navigation';
import { setAtelierIntent, useAtelierChanged, useAtelierLocations, type AtelierIntent } from './intent';
import { ACTIVE, atelierApi, type Overview } from './types';
import '../../styles/features/atelier.css';

// The editor redraws its sidebar often: show the last known state at once, then refresh it.
const cache = new Map<number, Overview>();

type RowOptions = {
  icon?: string; dot?: string; label: string; active?: boolean; small?: boolean; title?: string; extra?: ReactNode;
  onOpen: () => void; onBeside?: () => void;
};

function Row({ icon, dot, label, active, small, title, extra, onOpen, onBeside }: RowOptions) {
  return <div className={`project-sidebar-row ${small ? 'small' : ''} ${active ? 'active' : ''}`}>
    <button className="project-sidebar-main" onClick={onOpen} title={title || label} aria-current={active ? 'page' : undefined}>
      {dot ? <span className={`atelier-dot ${dot}`}/> : <Icon name={icon || 'notes'} size={small ? 13 : 14}/>}<span>{label}</span>{extra}
    </button>
    {onBeside && <button className="project-sidebar-beside" onClick={onBeside} title="Open to the side" aria-label={`Open ${label} to the side`}><Icon name="panel" size={12}/></button>}
  </div>;
}

/** The project name, as a menu to switch to another project. */
function ProjectSwitcher({ project, projects }: { project: Project; projects: Project[] }) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!menu.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape); };
  }, [open]);
  return <div className="project-switcher" ref={menu}>
    <button className="project-switcher-button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)} title="Switch project">
      <span className="project-sidebar-dot" style={{ background: workspaceColor(project.color) }}/>
      <strong>{project.name}</strong><Icon name="chevron" size={12}/>
    </button>
    {open && <div className="project-switcher-menu" role="menu">
      <small>Projects</small>
      {projects.map(item => <button key={item.id} role="menuitemradio" aria-checked={item.id === project.id} className={item.id === project.id ? 'active' : ''}
        onClick={() => { setOpen(false); if (item.id !== project.id) void openAtelier(item.id, 'project'); }}>
        <span className="project-sidebar-dot" style={{ background: workspaceColor(item.color) }}/><span>{item.name}</span>{item.id === project.id && <Icon name="check" size={13}/>}
      </button>)}
      <hr/>
      <button role="menuitem" data-action="new-project" onClick={() => setOpen(false)}><Icon name="plus" size={13}/><span>New project</span></button>
    </div>}
  </div>;
}

/** Sidebar of a project: its sections, code folders, agents and open tasks, above its notes and files.
 * The section, folder or conversation shown in the active pane is highlighted. */
export function ProjectSidebar({ projectId }: { projectId: number }) {
  const { state } = useRuntime();
  const locations = useAtelierLocations();
  const project = state.projects.find((item: Project) => item.id === projectId);
  const [data, setData] = useState<Overview | null>(() => cache.get(projectId) || null);
  const load = useCallback(async () => {
    try {
      const next = await atelierApi<Overview>(projectId);
      cache.set(projectId, next);
      setData(next);
    } catch { /* The sidebar keeps its last state; the Atelier panel reports errors. */ }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  useAtelierChanged(projectId, load);
  const running = data?.runs.some(run => run.status === 'running');
  useEffect(() => {
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, running ? 4000 : 20000);
    return () => window.clearInterval(timer);
  }, [running, load]);
  if (!project) return null;

  const pane = state.activeNotePane === 'secondary' ? 'secondary' : 'primary';
  const activeTab = state.workspaceTabs?.[pane]?.find((tab: any) => tab.id === state.workspaceActiveTabs?.[pane]);
  const here = activeTab?.resource?.type === 'atelier' ? locations[pane] : undefined;
  const onCanvas = Boolean(project.canvas_path) && activeTab?.resource?.path === project.canvas_path;
  const onResources = here?.section === 'code' && data?.folders.find(folder => folder.id === here.folderId)?.kind === 'resources';
  const open = (section: AtelierSection, intent?: AtelierIntent) => {
    if (intent) setAtelierIntent(projectId, section, intent);
    void openAtelier(projectId, section);
  };
  const beside = (section: AtelierSection, intent?: AtelierIntent) => {
    if (intent) setAtelierIntent(projectId, section, intent);
    void openAtelierBeside(projectId, section, pane);
  };
  const activeRuns = data?.runs.filter(run => ACTIVE.includes(run.status)) || [];
  const openTasks = (state.tasks || []).filter((task: any) => task.project_id === projectId && !task.archived_at && task.status !== 'done');
  const runningCount = activeRuns.filter(run => run.status === 'running').length;

  return <div className="project-sidebar-panel">
    <header className="project-sidebar-head">
      <button className="icon-button" data-nav="notes" title="Back to the whole workspace" aria-label="Back to the whole workspace"><Icon name="back" size={14}/></button>
      <ProjectSwitcher project={project} projects={state.projects.filter((item: Project) => item.status !== 'archived' || item.id === project.id)}/>
      <button className="icon-button" data-action="edit-project" data-project-id={project.id} title="Project settings" aria-label="Project settings"><Icon name="settings" size={13}/></button>
    </header>
    {project.description && <p className="project-sidebar-description">{project.description}</p>}
    <nav className="project-sidebar-nav" aria-label="Project">
      <Row icon="home" label="Overview" active={here?.section === 'project'} onOpen={() => open('project')} onBeside={() => beside('project')}/>
      <Row icon="canvas" label="Canvas" active={onCanvas} onOpen={() => void openProjectCanvas(projectId)} onBeside={() => void openCanvasBeside(projectId, pane)}/>
      <Row icon="code" label="Code" title="Files, map and Git history of the code folders" active={here?.section === 'code' && !onResources}
        extra={data && <small>{data.folders.length}</small>} onOpen={() => open('code')} onBeside={() => beside('code')}/>
      <Row icon="agents" label="Agents" active={here?.section === 'agents'}
        extra={runningCount ? <span className="atelier-badge">{runningCount}</span> : activeRuns.length ? <small>{activeRuns.length}</small> : null}
        onOpen={() => open('agents', { runId: null })} onBeside={() => beside('agents', { runId: null })}/>
      <Row icon="tasks" label="Tasks" title="The project's tasks, on its board" active={here?.section === 'tasks'} extra={openTasks.length ? <small>{openTasks.length}</small> : null}
        onOpen={() => open('tasks')} onBeside={() => beside('tasks')}/>
    </nav>
    <section className="project-sidebar-section">
      <h3>Code<button aria-label="Link code" title="Link a repository, a folder or a script" onClick={() => open('code', { add: 'code' })}>＋</button></h3>
      {data?.folders.filter(folder => folder.kind !== 'resources').map(folder => <Row key={folder.id} icon={folder.file ? 'notes' : 'code'} small label={folder.name} title={folder.path}
        active={here?.section === 'code' && here.folderId === folder.id}
        extra={folder.available ? folder.is_git && <small>{folder.branch}{folder.changes.length ? ` · ${folder.changes.length}●` : ''}</small> : <small className="atelier-warning-text">unavailable</small>}
        onOpen={() => open('code', { folderId: folder.id })} onBeside={() => beside('code', { folderId: folder.id })}/>)}
      {data && !data.folders.some(folder => folder.kind !== 'resources') && <p className="atelier-muted">Repositories, scripts…</p>}
    </section>
    <section className="project-sidebar-section">
      <h3>Resources<button aria-label="Link a resource" title="Link documents or data: a folder or a file" onClick={() => open('code', { add: 'resources' })}>＋</button></h3>
      {data?.folders.filter(folder => folder.kind === 'resources').map(folder => <Row key={folder.id} icon={folder.file ? 'notes' : 'folder'} small label={folder.name} title={folder.path}
        active={here?.section === 'code' && here.folderId === folder.id} extra={!folder.available && <small className="atelier-warning-text">unavailable</small>}
        onOpen={() => open('code', { folderId: folder.id })} onBeside={() => beside('code', { folderId: folder.id })}/>)}
      {data && !data.folders.some(folder => folder.kind === 'resources') && <p className="atelier-muted">Documents, data, papers…</p>}
    </section>
  </div>;
}
