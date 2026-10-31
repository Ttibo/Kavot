import { useCallback, useEffect, useRef, useState } from 'react';
import { useRuntime } from '../../app/runtime';
import { publish } from '../../app/viewBridge';
import { refreshState, toast } from '../../app/navigation';
import { Icon } from '../../components/Icon';
import { openNoteBeside, openProjectCanvas, switchAtelier, type AtelierSection } from '../projects/navigation';
import { AgentSurface } from '../agents/AgentSurface';
import { TasksBoard } from './TasksBoard';
import { clearAtelierLocation, notifyAtelierChanged, setAtelierIntent, setAtelierLocation, takeAtelierIntent, useAtelierChanged, useAtelierLocations } from './intent';
import { CodeMap } from './CodeMap';
import { FilesPanel } from './FilesPanel';
import { GitPanel } from './GitPanel';
import { atelierApi, openInEditor, post, relative, type Folder, type Overview } from './types';
import { needsAttention, STATUS_LABELS, statusOf } from '../agents/api';
import { registerAgentContext } from '../externalAgents/context';
import '../../styles/features/atelier.css';

type Pane = 'primary' | 'secondary';
type CodeTab = 'files' | 'map' | 'git';

// Per-pane choices survive the editor's redraws, which remount the panel.
const memory = new Map<string, any>();
function useRemembered<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => memory.has(key) ? memory.get(key) : initial);
  return [value, (next: T) => { memory.set(key, next); setValue(next); }];
}

type Kind = 'code' | 'resources';
const KINDS: [Kind, string, string][] = [
  ['code', 'Code', 'A repository or a script: history, map of the code, agents that change it in a worktree.'],
  ['resources', 'Resource', 'Documents and data (.docx, .xlsx, .csv, .pdf…), a folder or a single file: previews, opened with their app, read by agents.'],
];

function AddFolder({ projectId, kind: initialKind = 'code', onAdded, onCancel }: { projectId: number; kind?: Kind; onAdded: () => void; onCancel?: () => void }) {
  const [kind, setKind] = useState<Kind>(initialKind);
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const desktop = (window as any).pywebview?.api;
  async function submit() {
    setBusy(true);
    try { await atelierApi(projectId, '/folders', post({ path: path.trim(), name, kind })); onAdded(); }
    catch (reason) { toast((reason as Error).message, 'error'); }
    finally { setBusy(false); }
  }
  return <form className="atelier-add-folder" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <div className="atelier-kinds" role="radiogroup" aria-label="Kind of folder">{KINDS.map(([id, label, hint]) =>
      <button key={id} type="button" role="radio" aria-checked={kind === id} className={kind === id ? 'active' : ''} onClick={() => setKind(id)}>
        <Icon name={id === 'code' ? 'code' : 'folder'} size={15}/><strong>{label}</strong><small>{hint}</small></button>)}</div>
    <label><span>Folder or file on this computer</span><span className="atelier-inline">
      <input value={path} onChange={event => setPath(event.target.value)} placeholder={kind === 'code' ? 'C:\\Users\\me\\code\\my-app' : 'C:\\Users\\me\\Documents\\report.docx'} required autoFocus/>
      {desktop?.pick_project_resource_folder && <button type="button" className="button" onClick={async () => { const selected = await desktop.pick_project_resource_folder(); if (selected) setPath(selected); }}>Folder…</button>}
      {desktop?.pick_project_resource_file && <button type="button" className="button" onClick={async () => { const selected = await desktop.pick_project_resource_file(); if (selected) setPath(selected); }}>File…</button>}
    </span></label>
    <label><span>Name <small>(optional)</small></span><input value={name} onChange={event => setName(event.target.value)} placeholder={kind === 'code' ? 'Ex. API, Frontend' : 'Ex. Data, Papers, Reports'} maxLength={120}/></label>
    <div className="atelier-form-actions">{onCancel && <button type="button" className="button" onClick={onCancel}>Cancel</button>}<button className="button button-primary" disabled={busy || !path.trim()}>{busy ? 'Linking…' : 'Link'}</button></div>
    <p className="atelier-muted">{kind === 'code' ? 'Kavot reads the code and its Git history; it never changes it. Only agents you start write, each in its own Git worktree of a repository.'
      : 'Kavot and its agents only read it: nothing is ever changed.'}</p>
  </form>;
}

function ProjectHome({ projectId, data, pane, onCode, onAgents, onAddFolder, onRemoveFolder }: {
  projectId: number; data: Overview; pane: Pane; onCode: (folderId: string, tab: CodeTab) => void;
  onAgents: (options: { runId?: string | null; taskId?: number | null }) => void; onAddFolder: (kind: Kind) => void; onRemoveFolder: (folder: Folder) => void;
}) {
  const code = data.folders.filter(folder => folder.kind !== 'resources');
  const resources = data.folders.filter(folder => folder.kind === 'resources');
  const openTasks = data.tasks.filter(task => task.status !== 'done');
  const activeRuns = data.conversations.filter(item => needsAttention(statusOf(item)));
  const notes = [...data.notes].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''))).slice(0, 8);
  return <div className="atelier-home">
    <section className="atelier-home-intro">
      <h2>{data.project.name}</h2>
      {data.project.description && <p>{data.project.description}</p>}
      <div className="atelier-card-actions">
        <button className="button button-small" onClick={() => void openProjectCanvas(projectId)}><Icon name="canvas" size={12}/> Open the canvas</button>
        <button className="button button-small" onClick={() => onAgents({ runId: null })}><Icon name="agents" size={12}/> New agent</button>
        <button className="button button-small" onClick={() => onAddFolder('code')}><Icon name="plus" size={12}/> Code</button>
        <button className="button button-small" onClick={() => onAddFolder('resources')}><Icon name="plus" size={12}/> Resource</button>
      </div>
    </section>
    <div className="atelier-home-grid">
      <section className="atelier-home-block wide">
        <h3>Code</h3>
        {code.length ? <div className="atelier-folder-grid">{code.map(folder => <article key={folder.id} className="atelier-folder-card">
          <header><Icon name="folder" size={15}/><h4>{folder.name}</h4>
            {folder.available && (folder.is_git ? <span className="atelier-branch"><Icon name="workflow" size={11}/>{folder.branch}</span> : <span className="atelier-muted">No Git</span>)}
            <button className="icon-button atelier-remove" aria-label={`Unlink ${folder.name}`} title="Unlink this folder (the files are not touched)" onClick={() => onRemoveFolder(folder)}><Icon name="close" size={12}/></button></header>
          <code className="atelier-path" title={folder.path}>{folder.path}</code>
          {!folder.available ? <p className="atelier-warning">{folder.error}</p> : <>
            {folder.is_git && <p className="atelier-muted">{folder.changes.length ? `${folder.changes.length} uncommitted change${folder.changes.length > 1 ? 's' : ''}` : 'Clean checkout'}{folder.commits[0] ? ` · last commit ${relative(folder.commits[0].date)}` : ''}</p>}
            <div className="atelier-card-actions">
              <button className="button button-small" onClick={() => onCode(folder.id, 'files')}>Files</button>
              {!folder.file && <button className="button button-small" onClick={() => onCode(folder.id, 'map')}>Map</button>}
              {folder.is_git && <button className="button button-small" onClick={() => onCode(folder.id, 'git')}>History</button>}
              <button className="button button-small" onClick={() => openInEditor(projectId, folder.id).catch(reason => toast(reason.message, 'error'))}>VS Code</button>
            </div>
          </>}
        </article>)}</div> : <button className="atelier-placeholder" onClick={() => onAddFolder('code')}><Icon name="plus" size={14}/> Link the project's code: a repository, a frontend, a script…</button>}
      </section>
      <section className="atelier-home-block wide">
        <h3>Resources</h3>
        {resources.length ? <div className="atelier-folder-grid">{resources.map(folder => <article key={folder.id} className="atelier-folder-card">
          <header><Icon name={folder.file ? 'notes' : 'folder'} size={15}/><h4>{folder.name}</h4><span className="atelier-muted">read only</span>
            <button className="icon-button atelier-remove" aria-label={`Unlink ${folder.name}`} title="Unlink this folder (the files are not touched)" onClick={() => onRemoveFolder(folder)}><Icon name="close" size={12}/></button></header>
          <code className="atelier-path" title={folder.path}>{folder.path}</code>
          {!folder.available ? <p className="atelier-warning">{folder.error}</p>
            : <div className="atelier-card-actions"><button className="button button-small" onClick={() => onCode(folder.id, 'files')}>Browse and preview</button>
              <button className="button button-small" onClick={() => openInEditor(projectId, folder.id, '', 1, 'system').catch(reason => toast(reason.message, 'error'))}>Show in folder</button></div>}
        </article>)}</div> : <button className="atelier-placeholder" onClick={() => onAddFolder('resources')}><Icon name="plus" size={14}/> Link documents and data: a folder of papers, a report, a spreadsheet…</button>}
      </section>
      <section className="atelier-home-block">
        <h3>Agents<button className="text-link" onClick={() => onAgents({ runId: null })}>New</button></h3>
        {activeRuns.length ? activeRuns.map(run => <button key={run.id} className="atelier-home-row" onClick={() => onAgents({ runId: run.id })}>
          <span className={`atelier-dot ${statusOf(run)}`}/><span>{run.title}</span><small>{STATUS_LABELS[statusOf(run)]}</small></button>)
          : <p className="atelier-muted">No agent at work. Give a task to an agent, or start one from the Agents section.</p>}
      </section>
      <section className="atelier-home-block">
        <h3>Open tasks<button className="text-link" data-project-area="tasks" data-project-id={projectId}>All</button></h3>
        {openTasks.slice(0, 8).map(task => <div key={task.id} className="atelier-home-row static">
          <span className={`atelier-task-status ${task.status}`}/><button className="text-link" onClick={() => void import('../tasks/dialogs').then(({ newTaskModal }) => newTaskModal(projectId, null, task.id, () => refreshState(['tasks'])))}>{task.title}</button>
          <button className="atelier-run-task" title="Give this task to an agent" aria-label={`Give “${task.title}” to an agent`} onClick={() => onAgents({ runId: null, taskId: task.id })}><Icon name="agents" size={12}/></button>
        </div>)}
        {!openTasks.length && <p className="atelier-muted">No open task.</p>}
      </section>
      <section className="atelier-home-block">
        <h3>Recent notes</h3>
        {notes.map(note => <button key={note.id} className="atelier-home-row" onClick={() => void openNoteBeside(note.id, pane)} title="Open beside">
          <Icon name="notes" size={13}/><span>{note.title}</span><small>{relative(note.updated_at)}</small></button>)}
        {!notes.length && <p className="atelier-muted">No note yet. Create one from the project folder in the explorer.</p>}
      </section>
    </div>
  </div>;
}

/** A section of a project in an editor tab; a Code tab opened on a linked folder (`folder`) starts on it. */
export function AtelierPane({ projectId, section, pane, folder: initialFolder }: { projectId: number; section: AtelierSection; pane: Pane; folder?: string }) {
  const { state } = useRuntime();
  const key = `${projectId}:${section}:${pane}${initialFolder ? `:${initialFolder}` : ''}`;
  const projects = state.projects.filter((project: Project) => project.status !== 'archived' || project.id === projectId);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState<Kind | null>(null);
  const [folderId, setFolderId] = useRemembered(`${key}:folder`, initialFolder || '');
  const [codeTab, setCodeTab] = useRemembered<CodeTab>(`${key}:tab`, 'files');
  const [runId, setRunId] = useRemembered<string | null>(`${projectId}:run:${pane}`, null);
  const [taskForRun, setTaskForRun] = useState<number | null>(null);
  const [fileTarget, setFileTarget] = useState<{ path: string; line?: number } | null>(null);
  const [mapFocus, setMapFocus] = useState<string | null>(null);
  const locations = useAtelierLocations();

  const load = useCallback(async () => {
    try { setData(await atelierApi<Overview>(projectId)); setError(''); }
    catch (reason) { setError((reason as Error).message); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  // Other panels and the sidebar of the project hear about a change made here, and this one about theirs.
  useAtelierChanged(projectId, load);
  const changed = () => notifyAtelierChanged(projectId);
  useEffect(() => {
    if (data && !data.folders.some(folder => folder.id === folderId)) setFolderId(data.folders[0]?.id || '');
  }, [data]);
  const running = data?.conversations.filter(item => item.active_run_id).length || 0;
  useEffect(() => {
    if (!running || section === 'agents') return;
    const timer = window.setInterval(() => { void load(); }, 4000);
    return () => window.clearInterval(timer);
  }, [running, section, load]);
  // What the sidebar or another section asked to show (a folder, a conversation) is applied on mount.
  useEffect(() => {
    const apply = () => {
      const pending = takeAtelierIntent(projectId, section);
      if (!pending) return;
      if (pending.folderId) setFolderId(pending.folderId);
      if (pending.codeTab) setCodeTab(pending.codeTab);
      if ('runId' in pending) setRunId(pending.runId ?? null);
      if (pending.taskId) setTaskForRun(pending.taskId);
      if (pending.add) setAdding(pending.add);
    };
    apply();
    const listener = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.projectId === projectId && detail?.section === section) apply();
    };
    window.addEventListener('kavot:atelier-intent', listener);
    return () => window.removeEventListener('kavot:atelier-intent', listener);
  }, [projectId, section]);

  const go = (next: AtelierSection, pending?: Parameters<typeof setAtelierIntent>[2]) => {
    if (pending) setAtelierIntent(projectId, next, pending);
    switchAtelier(projectId, next, pane);
  };
  async function removeFolder(folder: Folder) {
    if (!window.confirm(`Unlink “${folder.name}” from the project? The folder itself is not touched.`)) return;
    try { await atelierApi(projectId, `/folders/${folder.id}`, { method: 'DELETE' }); changed(); }
    catch (reason) { toast((reason as Error).message, 'error'); }
  }
  const folder = data?.folders.find(item => item.id === folderId);
  const project = projects.find((item: Project) => item.id === projectId);

  // Tell the project sidebar where this pane is, and name the Code tab after its folder.
  useEffect(() => {
    const location = { projectId, section, folderId: section === 'code' ? folderId : undefined, runId: section === 'agents' ? runId : undefined };
    setAtelierLocation(pane, location);
    return () => clearAtelierLocation(pane, location);
  }, [projectId, section, folderId, runId, pane]);
  useEffect(() => {
    if (section !== 'code' || !folder) return;
    const tab = state.workspaceTabs[pane]?.find((item: any) => item.resource?.path === `atelier/${projectId}/code${initialFolder ? `/${initialFolder}` : ''}`);
    const title = `${folder.kind === 'resources' ? 'Files' : 'Code'} · ${folder.name}`;
    if (tab && tab.resource.title !== title) { tab.resource.title = title; publish(); }
  }, [section, folder?.name, pane]);

  // The assistant follows this pane: the project, its section and the code shown, suggested to an agent.
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    return registerAgentContext(host.current, () => ({
      area: 'project', project_id: projectId, project_name: project?.name,
      view_label: `Atelier · ${{ project: 'Overview', code: folder?.kind === 'resources' ? 'Resources' : 'Code', agents: 'Agents', tasks: 'Tasks' }[section]}${section === 'code' && folder ? ` · ${folder.name}` : ''}`,
      ...(section === 'code' && folder ? { code_folder_id: folder.id } : {}),
    }));
  }, [projectId, section, folder?.id, folder?.name, project?.name]);
  const task = taskForRun ? data?.tasks.find(item => item.id === taskForRun) : undefined;
  return <div className="atelier-view atelier-pane" ref={host}>
    {error ? <p className="atelier-empty">{error}</p> : !data ? <p role="status" className="atelier-empty">Loading…</p>
      : adding ? <div className="atelier-centered"><h3>Link code or a resource</h3><AddFolder key={adding} projectId={projectId} kind={adding} onAdded={() => { setAdding(null); changed(); }} onCancel={() => setAdding(null)}/></div>
      : section === 'project' ? <ProjectHome projectId={projectId} data={data} pane={pane} onAddFolder={kind => setAdding(kind)} onRemoveFolder={item => void removeFolder(item)}
          onCode={(id, tab) => go('code', { folderId: id, codeTab: tab })} onAgents={({ runId: run, taskId }) => go('agents', { runId: run ?? null, taskId })}/>
      : section === 'tasks' ? <TasksBoard projectId={projectId} onAgent={taskId => go('agents', { runId: null, taskId })}/>
      : section === 'agents' ? <AgentSurface layout="page" projectId={projectId} pane={pane} selected={runId} onSelect={id => { setRunId(id); if (id) setTaskForRun(null); }}
          onChanged={changed} preset={task ? [{ key: `task:${task.id}`, kind: 'task', id: task.id, title: task.title, project_id: projectId }] : undefined}/>
      : !data.folders.length ? <div className="atelier-centered"><h3>Link the project's code</h3><p className="atelier-muted">Each folder gets a file browser, its Git history, a map of the code and development agents.</p><AddFolder projectId={projectId} onAdded={changed}/></div>
      : <div className="atelier-code-section">
        <header className="atelier-code-head">
          <Icon name={folder?.file ? 'notes' : folder?.kind === 'resources' ? 'folder' : 'code'} size={16}/>
          <div className="atelier-code-title">
            {data.folders.length > 1
              ? <select aria-label="Folder" value={folderId} onChange={event => event.target.value === '+' ? setAdding('code') : setFolderId(event.target.value)}>
                  {([['code', 'Code'], ['resources', 'Resources']] as const).map(([kind, label]) => data.folders.some(item => (item.kind || 'code') === kind) &&
                    <optgroup key={kind} label={label}>{data.folders.filter(item => (item.kind || 'code') === kind).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>)}
                  <option value="+">＋ Link more…</option>
                </select>
              : <strong>{folder?.name}</strong>}
            {folder?.is_git && <span className="atelier-branch"><Icon name="workflow" size={11}/>{folder.branch}{folder.changes.length ? ` · ${folder.changes.length} changed` : ''}</span>}
            <code title={folder?.path}>{folder?.path}</code>
          </div>
          <div className="atelier-segmented" role="tablist" aria-label="View">
            {((folder?.kind === 'resources' || folder?.file ? [['files', 'Files', 'notes']] : [['files', 'Files', 'notes'], ['map', 'Map', 'graph'], ['git', 'History', 'workflow']]) as [CodeTab, string, string][]).map(([id, label, icon]) => <button key={id} role="tab" aria-selected={codeTab === id} className={codeTab === id ? 'active' : ''} onClick={() => setCodeTab(id)}><Icon name={icon} size={12}/>{label}</button>)}
          </div>
          {folder?.available && folder.kind !== 'resources' && <button className="button button-small" onClick={() => openInEditor(projectId, folder.id).catch(reason => toast(reason.message, 'error'))} title="Open the folder in VS Code"><Icon name="code" size={12}/> VS Code</button>}
          {data.folders.length === 1 && <button className="icon-button" aria-label="Link more" title="Link more code or resources" onClick={() => setAdding('code')}><Icon name="plus" size={13}/></button>}
        </header>
        <div className="atelier-panel">
          {!folder ? <p className="atelier-empty">Choose code or a resource in the sidebar.</p>
            : !folder.available ? <p className="atelier-empty">{folder.error}</p>
            : codeTab === 'files' || folder.kind === 'resources' || folder.file ? <FilesPanel projectId={projectId} folder={folder} target={fileTarget} onShowInMap={path => { setMapFocus(path); setCodeTab('map'); }}/>
            : codeTab === 'map' ? <CodeMap projectId={projectId} folder={folder} focusPath={mapFocus} onOpen={(path, line) => { setFileTarget({ path, line }); setCodeTab('files'); }}/>
            : <GitPanel projectId={projectId} folder={folder}/>}
        </div>
      </div>}
  </div>;
}
