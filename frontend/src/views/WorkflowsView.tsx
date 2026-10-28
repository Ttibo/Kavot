import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { getRuntime, useRuntime } from '../app/runtime';
import { refreshData, refreshState, toast } from '../app/navigation';
import { Icon } from '../components/Icon';
import { OverlayPanel, ViewHeader, ViewPage } from '../components/ViewLayout';
import { openWatchers } from '../features/collections/CollectionWatchers';
import { api } from '../services/api';
import '../styles/features/workflows.css';

type NodeType = 'start' | 'watcher' | 'collection_read' | 'note_read' | 'project' | 'paper_folder' | 'local_folder'
  | 'summarize' | 'filter_sort' | 'extract' | 'compare' | 'build' | 'agent_task'
  | 'collection_write' | 'note_update' | 'note_create' | 'task' | 'paper_folder_file' | 'local_changes';
type Group = 'Sources' | 'Agent' | 'Outputs';
type FlowNode = { id: string; type: NodeType; x: number; y: number; label: string; config: Record<string, any> };
type FlowEdge = { id: string; source: string; target: string };
type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled';
type Change = { proposal_id: string; label: string; target: string; kind: string; diff?: string; status: 'pending' | 'applied' | 'dismissed' };
type AgentEvent = { id?: number; kind: string; label: string; detail?: string; at?: string };
type AgentCall = { run_id: string; started_at: string; finished_at?: string; status: string; mode: string; prompt: string; events: AgentEvent[]; response: string; error: string | null };
type Step = {
  status: StepStatus; summary?: string; error?: string; detail?: string; output?: string; item_count?: number;
  started_at?: string; finished_at?: string; agent_run?: string | null; agent_calls?: AgentCall[];
  input?: { item_count: number; items: { key: string; title: string }[]; text: string };
  items?: { key: string; title: string; reason?: string }[]; changes?: Change[];
};
type LogEntry = { at: string; level: 'info' | 'warning' | 'error'; node_id: string | null; message: string; detail?: string };
type Run = { id: string; trigger: string; status: string; started_at: string; finished_at: string | null; error: string | null; steps: Record<string, Step>; log?: LogEntry[] };
type Workflow = {
  id?: number; name: string; description: string; scope: { project_id: number | null };
  engine: string; model: string; interval_hours: number; timeout_minutes: number; enabled: boolean;
  nodes: FlowNode[]; edges: FlowEdge[]; runs?: Run[]; running?: boolean; last_error?: string | null; next_run_at?: string | null;
};
type WatcherSummary = { id: number; name: string; direct: boolean; target: { type: string; collection_id?: string } };
type Filter = { field: string; op: string; value: string };

const NODE_W = 216;
const NODE_H = 74;
const KINDS: Record<NodeType, { title: string; icon: string; group: Group; hint: string; defaults?: Record<string, any> }> = {
  start: { title: 'Start', icon: 'sparkle', group: 'Sources', hint: 'Manual run or schedule' },
  watcher: { title: 'Watcher', icon: 'search', group: 'Sources', hint: 'Runs a watcher and passes on what it found', defaults: { min_rating: 0 } },
  collection_read: { title: 'Collection', icon: 'database', group: 'Sources', hint: 'Items of a collection, filtered as you want', defaults: { limit: 20, filters: [] } },
  note_read: { title: 'Note', icon: 'notes', group: 'Sources', hint: 'The content of a note as input' },
  project: { title: 'Project', icon: 'projects', group: 'Sources', hint: 'Articles, notes and tasks of a project', defaults: { articles: true, notes: true, limit: 30 } },
  paper_folder: { title: 'Article folder', icon: 'folder', group: 'Sources', hint: 'Articles of a library folder', defaults: { include_subfolders: true, limit: 20 } },
  local_folder: { title: 'Local folder', icon: 'folder', group: 'Sources', hint: 'Files of a folder on this computer (code, data…)', defaults: { patterns: '', limit: 40 } },
  summarize: { title: 'Summarize', icon: 'notes', group: 'Agent', hint: 'One summary per item or for all of them', defaults: { per_item: true, max_items: 10, prompt: 'Write a structured summary: question, method, main results and limits, in 150 to 250 words.' } },
  filter_sort: { title: 'Filter and sort', icon: 'search', group: 'Agent', hint: 'Keeps and ranks the items by your criteria', defaults: { max_items: 30 } },
  extract: { title: 'Extract fields', icon: 'database', group: 'Agent', hint: 'Precise data per item, as fields', defaults: { max_items: 20, fields: '' } },
  compare: { title: 'Compare', icon: 'graph', group: 'Agent', hint: 'Comparison table and analysis of all the items', defaults: { max_items: 20 } },
  build: { title: 'Build', icon: 'canvas', group: 'Agent', hint: 'A synthesis or structure built from the items', defaults: { max_items: 30 } },
  agent_task: { title: 'Agent task', icon: 'sparkle', group: 'Agent', hint: 'Any task written on the fly', defaults: { per_item: false, max_items: 10 } },
  collection_write: { title: 'Fill a collection', icon: 'database', group: 'Outputs', hint: 'The agent adds or updates items (Library included)', defaults: { apply_mode: 'review' } },
  note_update: { title: 'Update a note', icon: 'edit', group: 'Outputs', hint: 'Adds or replaces a section of a note', defaults: { position: 'append' } },
  note_create: { title: 'New note', icon: 'notes', group: 'Outputs', hint: 'A new note on each run, or one per item', defaults: { per_item: false, title: '{workflow} — {date}' } },
  task: { title: 'Create tasks', icon: 'tasks', group: 'Outputs', hint: 'Tasks on the board' },
  paper_folder_file: { title: 'File articles', icon: 'folder', group: 'Outputs', hint: 'Files the incoming articles in a folder' },
  local_changes: { title: 'Change local files', icon: 'edit', group: 'Outputs', hint: 'Proposes file changes; you approve each diff' },
};
const LEGACY: Record<string, NodeType> = { article_watch: 'watcher', note: 'note_create', global_note: 'note_update', collection: 'collection_write' };
const OPS: [string, string][] = [['contains', 'contains'], ['not_contains', 'does not contain'], ['equals', 'is'], ['not_equals', 'is not'], ['gt', '>'], ['lt', '<'], ['not_empty', 'is filled'], ['empty', 'is empty']];
const INTERVALS: [number, string][] = [[0, 'Manual only'], [6, 'Every 6 hours'], [12, 'Every 12 hours'], [24, 'Daily'], [72, 'Every 3 days'], [168, 'Weekly'], [720, 'Monthly']];
const STATUS_LABELS: Record<string, string> = { pending: 'Waiting', running: 'Running', done: 'Done', completed: 'Completed', failed: 'Failed', skipped: 'Skipped', cancelled: 'Stopped', interrupted: 'Interrupted' };
const AGENT_TYPES = new Set<NodeType>(['watcher', 'summarize', 'filter_sort', 'extract', 'compare', 'build', 'agent_task', 'collection_write', 'local_changes']);

const uid = () => Math.random().toString(36).slice(2, 10);
const blank = (): Workflow => ({
  name: 'New workflow', description: '', scope: { project_id: null }, engine: 'claude', model: '',
  interval_hours: 0, timeout_minutes: 20, enabled: true, edges: [],
  nodes: [{ id: uid(), type: 'start', x: 60, y: 160, label: '', config: {} }],
});
const normalize = (flow: Workflow): Workflow => ({ ...flow, scope: { project_id: flow.scope?.project_id ?? null },
  nodes: flow.nodes.map(node => ({ ...node, type: LEGACY[node.type as string] || node.type })) });
const payload = (flow: Workflow) => ({
  name: flow.name.trim() || 'Workflow', description: flow.description, scope: flow.scope, engine: flow.engine, model: flow.model,
  interval_hours: flow.interval_hours, timeout_minutes: flow.timeout_minutes, enabled: flow.enabled, nodes: flow.nodes, edges: flow.edges,
});
const when = (value?: string | null) => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—';
const clock = (value?: string | null) => value ? new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
/** Elapsed time between two dates, or until now while the end is unknown. */
const duration = (start?: string | null, end?: string | null) => {
  const ms = (end ? Date.parse(end) : Date.now()) - Date.parse(start || '');
  if (!start || !Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
};
/** Streamed text fragments of an agent read as one message. */
const coalesce = (events: AgentEvent[]) => events.reduce<AgentEvent[]>((merged, event) => {
  const last = merged[merged.length - 1];
  if (last && event.kind === 'message' && last.kind === 'message' && last.label === event.label) merged[merged.length - 1] = { ...last, detail: (last.detail || '') + (event.detail || '') };
  else merged.push(event);
  return merged;
}, []);
const stepName = (flow: Workflow, nodeId: string | null) => {
  const node = flow.nodes.find(item => item.id === nodeId);
  return node ? node.label || KINDS[node.type]?.title || node.type : nodeId || '';
};
const edgePath = (sx: number, sy: number, tx: number, ty: number) => {
  const dx = Math.max(40, Math.abs(tx - sx) / 2);
  return `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
};
const collectionLabel = (state: any, id?: string) => id === 'articles' ? 'Library' : state.databases.find((d: any) => d.id === id)?.name || '';

export function WorkflowsView() {
  const runtime = useRuntime();
  const state = runtime.state;
  const flows: Workflow[] = state.workflows || [];
  const [draft, setDraft] = useState<Workflow | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [journal, setJournal] = useState(false);
  const [watcherList, setWatcherList] = useState<WatcherSummary[]>([]);
  const [engines, setEngines] = useState<{ id: string; name: string }[]>([]);

  const load = useCallback(async () => {
    await refreshState(['workflows']);
    return (getRuntime().state.workflows || []) as Workflow[];
  }, []);
  // The sidebar picks the workflow: follow state.workflowId, keeping unsaved edits on request.
  // No workflow chosen: the page lists them all.
  const wanted = state.workflowId ?? null;
  useEffect(() => {
    if (!wanted) {
      // Left for the list from the sidebar: keep the edits instead of leaving a stale "unsaved" flag behind.
      if (dirty && draft?.id) void api(`/workflows/${draft.id}`, { method: 'PUT', body: JSON.stringify(payload(draft)) }).then(load).catch(error => toast(error.message, 'error'));
      setDraft(null); setDirty(false); return;
    }
    if (draft?.id === wanted) return;
    if (draft && dirty && !confirm('Discard the unsaved changes of this workflow?')) { state.workflowId = draft.id ?? null; void refreshState([]); return; }
    void api<Workflow>(`/workflows/${wanted}`).then(show).catch(error => toast(error.message, 'error'));
  }, [wanted]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Opens the editor on a workflow and makes it the one the sidebar follows. */
  function show(flow: Workflow) {
    state.workflowId = flow.id ?? null;
    setDraft(normalize(flow)); setDirty(false); setSelected(null); setRunId(null); setJournal(false);
  }
  useEffect(() => {
    void api<WatcherSummary[]>('/watchers').then(setWatcherList).catch(() => setWatcherList([]));
    void api<{ engines: { id: string; name: string; enabled: boolean }[] }>('/external-agents/settings')
      .then(value => setEngines(value.engines.filter(engine => engine.enabled))).catch(() => setEngines([]));
  }, []);

  const refreshRuns = useCallback((next: Workflow) => setDraft(current => current && current.id === next.id
    ? { ...current, runs: next.runs, running: next.running, last_error: next.last_error, next_run_at: next.next_run_at } : current), []);
  // Follow a running workflow without touching the graph being edited.
  useEffect(() => {
    if (!draft?.id || !draft.running) return;
    const timer = setInterval(() => {
      void api<Workflow>(`/workflows/${draft.id}`).then(next => {
        refreshRuns(next);
        if (!next.running) { void load(); void refreshData(); }
      }).catch(() => undefined);
    }, 1500);
    return () => clearInterval(timer);
  }, [draft?.id, draft?.running, load, refreshRuns]);

  const change = (update: (flow: Workflow) => Workflow) => { setDraft(current => current && update(current)); setDirty(true); };
  const updateNode = (id: string, values: Partial<FlowNode>) => change(flow => ({ ...flow, nodes: flow.nodes.map(node => node.id === id ? { ...node, ...values } : node) }));
  const updateConfig = (id: string, values: Record<string, any>) => change(flow => ({ ...flow, nodes: flow.nodes.map(node => node.id === id ? { ...node, config: { ...node.config, ...values } } : node) }));
  const removeSelection = () => {
    if (!selected) return;
    change(flow => selected.kind === 'edge'
      ? { ...flow, edges: flow.edges.filter(edge => edge.id !== selected.id) }
      : { ...flow, nodes: flow.nodes.filter(node => node.id !== selected.id), edges: flow.edges.filter(edge => edge.source !== selected.id && edge.target !== selected.id) });
    setSelected(null);
  };

  const create = async () => {
    if (dirty && !confirm('Discard the unsaved changes of this workflow?')) return;
    try {
      const flow = await api<Workflow>('/workflows', { method: 'POST', body: JSON.stringify(payload({ ...blank(), engine: engines[0]?.id || 'claude' })) });
      // Straight into the editor of the new workflow.
      show(flow);
      await load();
    } catch (error) { toast((error as Error).message, 'error'); }
  };

  async function save(): Promise<Workflow | null> {
    if (!draft) return null;
    setBusy(true);
    try {
      const saved = await api<Workflow>(draft.id ? `/workflows/${draft.id}` : '/workflows', { method: draft.id ? 'PUT' : 'POST', body: JSON.stringify(payload(draft)) });
      setDraft(normalize(saved)); setDirty(false);
      await load();
      return saved;
    } catch (error) { toast((error as Error).message, 'error'); return null; } finally { setBusy(false); }
  }
  async function run() {
    const saved = dirty || !draft?.id ? await save() : draft;
    if (!saved?.id) return;
    try {
      const next = await api<Workflow>(`/workflows/${saved.id}/run`, { method: 'POST' });
      setDraft(current => ({ ...current, runs: next.runs, running: next.running })); setRunId(null); void load();
      toast('Workflow started');
    } catch (error) { toast((error as Error).message, 'error'); }
  }
  /** Deletes one run with its journal, or every finished run when no id is given. */
  async function deleteRuns(id?: string) {
    if (!draft?.id || !confirm(id ? 'Delete this run and its journal?' : 'Delete every finished run and its journal?')) return;
    try {
      const next = await api<Workflow>(`/workflows/${draft.id}/runs${id ? `/${id}` : ''}`, { method: 'DELETE' });
      if (!id || id === currentRun?.id) { setJournal(false); setRunId(null); }
      refreshRuns(next);
      toast(id ? 'Run deleted' : 'Run history cleared');
    } catch (error) { toast((error as Error).message, 'error'); }
  }
  async function stop() {
    if (!draft?.id) return;
    try { await api(`/workflows/${draft.id}/cancel`, { method: 'POST' }); toast('Stopping after the current step…'); }
    catch (error) { toast((error as Error).message, 'error'); }
  }
  /** Deletes a workflow with its runs, from the list or from its own editor. */
  async function remove(flow: Workflow | null = draft) {
    if (!flow?.id || !confirm(`Delete the workflow “${flow.name}” and its run history? This cannot be undone.`)) return;
    try {
      await api(`/workflows/${flow.id}`, { method: 'DELETE' });
      if (flow.id === draft?.id) { setDirty(false); setSelected(null); state.workflowId = null; }
      await load();
      toast('Workflow deleted');
    } catch (error) { toast((error as Error).message, 'error'); }
  }
  function showAll() {
    if (dirty && !confirm('Discard the unsaved changes of this workflow?')) return;
    setDirty(false); setSelected(null);
    state.workflowId = null;
    void load();
  }
  async function newWatcher() {
    // The watcher form lives on the Watchers page; keep this workflow's edits first.
    if (dirty && !(await save())) return;
    openWatchers({ create: true });
  }

  const currentRun = draft?.runs?.find(item => item.id === runId) || draft?.runs?.[0] || null;
  const node = selected?.kind === 'node' ? draft?.nodes.find(item => item.id === selected.id) : undefined;
  const needsAgent = !!draft?.nodes.some(item => AGENT_TYPES.has(item.type) && !(item.type === 'watcher' && watcherList.find(w => w.id === Number(item.config.watcher_id))?.direct));

  return <ViewPage className="workflows-view" label="Workflows">
    <ViewHeader icon="workflow" title="Workflows" count={flows.length}>
      <button className="button button-primary" onClick={() => void create()}><Icon name="plus" size={13}/>New workflow</button>
    </ViewHeader>
    <div className="wf-layout">
      {draft ? <>
        <section className="wf-main">
          <div className="wf-toolbar">
            <button className="icon-button" aria-label="All workflows" title="All workflows" onClick={showAll}><Icon name="back" size={14}/></button>
            <input className="wf-name" aria-label="Workflow name" value={draft.name} onChange={event => change(flow => ({ ...flow, name: event.target.value }))}/>
            <AddStep onAdd={(type, x, y) => {
              const id = uid();
              change(flow => ({ ...flow, nodes: [...flow.nodes, { id, type, x, y, label: '', config: { ...(KINDS[type].defaults || {}) } }] }));
              setSelected({ kind: 'node', id });
            }} flow={draft}/>
            <span className="wf-spacer"/>
            {dirty && <><span className="wf-dirty">Unsaved changes</span><button className="button" disabled={busy} onClick={() => void save()}><Icon name="check" size={13}/>Save</button></>}
            {draft.running
              ? <button className="button" onClick={() => void stop()}><Icon name="close" size={13}/>Stop</button>
              : <button className="button button-primary" disabled={busy || (!engines.length && needsAgent)} title={engines.length || !needsAgent ? 'Save and run the workflow' : 'Enable an agent engine in Settings → AI and agents'} onClick={() => void run()}><Icon name="sparkle" size={13}/>Run</button>}
            <button type="button" className="button button-danger wf-delete" aria-label="Delete the workflow" title={draft.running ? 'Stop the workflow before deleting it' : 'Delete the workflow'} disabled={draft.running} onClick={() => void remove()}><Icon name="trash" size={14}/></button>
          </div>
          <FlowCanvas flow={draft} run={currentRun} onRun={setRunId} selected={selected} onSelect={setSelected} onMove={(id, x, y) => updateNode(id, { x, y })}
            onConnect={(source, target) => change(flow => flow.edges.some(edge => edge.source === source && edge.target === target) ? flow : { ...flow, edges: [...flow.edges, { id: `${source}->${target}`, source, target }] })}
            onDelete={removeSelection} describe={item => describeNode(item, { state, watchers: watcherList })}/>
        </section>
        <aside className="wf-inspector" aria-label={node ? 'Step settings' : 'Workflow settings'}>
          {node ? <NodeInspector key={node.id} node={node} flow={draft} run={currentRun} step={currentRun?.steps[node.id]} watchers={watcherList} state={state}
              onLabel={label => updateNode(node.id, { label })} onConfig={values => updateConfig(node.id, values)} onRun={setRunId}
              onNewWatcher={() => void newWatcher()} onDecided={refreshRuns} onRemove={removeSelection} onClose={() => setSelected(null)}/>
            : selected?.kind === 'edge' ? <div className="wf-panel"><h2>Connection</h2><p className="wf-hint">The target step receives the items and the text produced by the source step.</p><button className="button" onClick={removeSelection}><Icon name="trash" size={13}/>Remove the connection</button></div>
            : <WorkflowPanel key={draft.id} flow={draft} engines={engines} state={state} onChange={values => change(flow => ({ ...flow, ...values }))} onRemove={() => void remove()}
              currentRun={currentRun} onRun={setRunId} onJournal={id => { setRunId(id); setJournal(true); }} onDelete={id => void deleteRuns(id)} onDecided={refreshRuns}
              onStep={id => setSelected({ kind: 'node', id })}/>}
        </aside>
        {journal && currentRun && <RunJournal key={currentRun.id} flow={draft} run={currentRun} onDecided={refreshRuns} onClose={() => setJournal(false)} onDelete={() => void deleteRuns(currentRun.id)}
          onStep={id => setSelected({ kind: 'node', id })}/>}
      </> : flows.length ? <WorkflowList flows={flows} engines={engines} onOpen={id => { const flow = flows.find(item => item.id === id); if (flow) show(flow); void api<Workflow>(`/workflows/${id}`).then(show).catch(error => toast(error.message, 'error')); }} onCreate={() => void create()} onDelete={flow => void remove(flow)}/>
        : <section className="wf-main wf-blank"><Icon name="workflow" size={30}/><h2>Build your first workflow</h2><p>Chain watchers, collections, notes, projects or a local folder with agent blocks (summarize, sort, extract, compare, build) and outputs: collections, notes, tasks, files.</p><button className="button button-primary" onClick={() => void create()}><Icon name="plus" size={13}/>New workflow</button></section>}
    </div>
  </ViewPage>;
}

function WorkflowList({ flows, engines, onOpen, onCreate, onDelete }: { flows: Workflow[]; engines: { id: string; name: string }[]; onOpen: (id: number) => void; onCreate: () => void; onDelete: (flow: Workflow) => void }) {
  const [query, setQuery] = useState('');
  const shown = flows.filter(flow => `${flow.name} ${flow.description || ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  const schedule = (hours: number) => INTERVALS.find(([value]) => value === hours)?.[1] || `Every ${hours} h`;
  return <section className="wf-main wf-overview" aria-label="All workflows">
    <div className="wf-overview-toolbar"><input type="search" aria-label="Search workflows" placeholder="Search workflows" value={query} onChange={event => setQuery(event.target.value)}/></div>
    <div className="wf-overview-grid">
      <button className="wf-card wf-card-new" onClick={onCreate}><Icon name="plus" size={20}/><strong>New workflow</strong><small>Chain sources, agent steps and outputs</small></button>
      {shown.map(flow => {
        const lastRun = flow.runs?.[0];
        const status = flow.running ? 'running' : flow.last_error ? 'failed' : lastRun?.status;
        return <div key={flow.id} className="wf-card-wrap"><button className="wf-card" onClick={() => flow.id && onOpen(flow.id)}>
          <span className="wf-card-head"><Icon name="workflow" size={15}/><strong>{flow.name}</strong>{status && <span className={`wf-card-status ${status}`}>{STATUS_LABELS[status] || status}</span>}</span>
          {flow.description && <small className="wf-card-description">{flow.description}</small>}
          <span className="wf-card-meta">
            <span>{flow.interval_hours ? schedule(flow.interval_hours) : 'Manual only'}{flow.interval_hours && !flow.enabled ? ' · paused' : ''}</span>
            {flow.engine && <span>{engines.find(engine => engine.id === flow.engine)?.name || flow.engine}</span>}
            {!!flow.nodes?.length && <span>{flow.nodes.length} steps</span>}
            {lastRun?.started_at && <span>Last run {when(lastRun.started_at)}</span>}
            {flow.next_run_at && flow.enabled && !!flow.interval_hours && <span>Next {when(flow.next_run_at)}</span>}
          </span>
        </button>
        <button type="button" className="button button-danger wf-card-delete" aria-label={`Delete the workflow “${flow.name}”`} title={flow.running ? 'Stop the workflow before deleting it' : 'Delete the workflow'} disabled={flow.running} onClick={() => onDelete(flow)}><Icon name="trash" size={13}/></button></div>;
      })}
    </div>
    {!shown.length && <p className="wf-hint">No workflow matches “{query}”.</p>}
  </section>;
}

function describeNode(node: FlowNode, { state, watchers }: { state: any; watchers: WatcherSummary[] }): string {
  const c = node.config;
  const note = (id: unknown) => state.notes.find((n: Note) => n.id === Number(id))?.title;
  const folder = (id: unknown) => state.paperFolders.find((f: PaperFolder) => f.id === Number(id))?.name;
  const project = (id: unknown) => state.projects.find((p: Project) => p.id === Number(id))?.name;
  switch (node.type) {
    case 'start': return 'Manual run or schedule';
    case 'watcher': return watchers.find(w => w.id === Number(c.watcher_id))?.name || 'Choose a watcher';
    case 'collection_read': return c.collection_id ? `${collectionLabel(state, c.collection_id)}${(c.filters || []).length ? ` · ${(c.filters || []).length} filter(s)` : ''}${c.only_new ? ' · new only' : ''}` : 'Choose a collection';
    case 'note_read': return note(c.note_id) || 'Choose a note';
    case 'project': return project(c.project_id) || 'Workflow project';
    case 'paper_folder': return folder(c.folder_id) ? `${folder(c.folder_id)}${c.only_new ? ' · new only' : ''}` : 'Choose a folder';
    case 'local_folder': return c.path ? `${String(c.path).split(/[\\/]/).filter(Boolean).pop()}${c.allow_changes ? ' · changes allowed' : ' · read only'}` : 'Choose a folder';
    case 'summarize': return c.per_item ? 'One summary per item' : 'One summary for all';
    case 'filter_sort': return c.keep_max ? `Keeps the ${c.keep_max} best` : 'Keeps the relevant items';
    case 'extract': return c.fields || 'Choose the fields';
    case 'compare': case 'build': return (c.prompt || KINDS[node.type].hint).slice(0, 60);
    case 'agent_task': return (c.prompt || 'Write the task').slice(0, 60);
    case 'collection_write': return c.collection_id ? `${collectionLabel(state, c.collection_id)} · ${c.apply_mode === 'auto' ? 'direct' : 'review'}` : 'Choose a collection';
    case 'note_update': return note(c.note_id) ? `${note(c.note_id)} · ${c.position === 'replace' ? 'replace section' : c.position === 'prepend' ? 'at the top' : 'at the end'}` : 'Choose a note';
    case 'note_create': return c.per_item ? 'One note per item' : 'One note per run';
    case 'task': return c.per_item ? 'One task per item' : 'One task per run';
    case 'paper_folder_file': return folder(c.folder_id) || 'Choose a folder';
    case 'local_changes': return 'Diffs to approve';
  }
}

const GROUP_LABELS: Record<Group, string> = { Sources: 'Read from', Agent: 'Process with the agent', Outputs: 'Write to' };

/** One button that opens the catalogue of steps, grouped by role, each with what it does. */
function AddStep({ onAdd, flow }: { onAdd: (type: NodeType, x: number, y: number) => void; flow: Workflow }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape); };
  }, [open]);
  const place = () => {
    const right = flow.nodes.reduce((max, item) => Math.max(max, item.x), 0);
    return [right + NODE_W + 60, 80 + (flow.nodes.length % 4) * 100] as const;
  };
  return <div className="wf-add" ref={box}>
    <button type="button" className="button" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(value => !value)}><Icon name="plus" size={13}/>Add a step</button>
    {open && <div className="wf-add-menu" role="menu" aria-label="Add a step">
      {(['Sources', 'Agent', 'Outputs'] as Group[]).map(group => <div key={group} className={`wf-add-group wf-${group.toLowerCase()}`}><span>{GROUP_LABELS[group]}</span>
        {(Object.keys(KINDS) as NodeType[]).filter(type => KINDS[type].group === group && type !== 'start').map(type =>
          <button key={type} type="button" role="menuitem" onClick={() => { setOpen(false); onAdd(type, ...place()); }}>
            <span className="wf-node-icon"><Icon name={KINDS[type].icon} size={13}/></span><span><strong>{KINDS[type].title}</strong><small>{KINDS[type].hint}</small></span>
          </button>)}
      </div>)}
    </div>}
  </div>;
}

/** Switches the run shown on the canvas and in the inspector, newest first. */
function RunPicker({ runs, current, onPick }: { runs: Run[]; current: Run | null; onPick: (id: string) => void }) {
  const index = runs.findIndex(item => item.id === current?.id);
  return <div className="wf-run-picker">
    <button type="button" aria-label="Previous run" title="Previous run" disabled={index < 0 || index >= runs.length - 1} onClick={() => onPick(runs[index + 1].id)}><Icon name="back" size={12}/></button>
    <select aria-label="Run" value={current?.id ?? ''} onChange={event => onPick(event.target.value)}>
      {runs.map((item, position) => <option key={item.id} value={item.id}>#{runs.length - position} · {when(item.started_at)} · {STATUS_LABELS[item.status] || item.status}</option>)}
    </select>
    <button type="button" aria-label="Next run" title="Next run" disabled={index <= 0} onClick={() => onPick(runs[index - 1].id)}><Icon name="chevron" size={12}/></button>
  </div>;
}

function FlowCanvas({ flow, run, onRun, selected, onSelect, onMove, onConnect, onDelete, describe }: {
  flow: Workflow; run: Run | null; onRun: (id: string) => void; selected: { kind: 'node' | 'edge'; id: string } | null;
  onSelect: (value: { kind: 'node' | 'edge'; id: string } | null) => void; onMove: (id: string, x: number, y: number) => void;
  onConnect: (source: string, target: string) => void; onDelete: () => void; describe: (node: FlowNode) => string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  const [link, setLink] = useState<{ source: string; x: number; y: number } | null>(null);
  const byId = useMemo(() => new Map(flow.nodes.map(item => [item.id, item])), [flow.nodes]);
  const toCanvas = (clientX: number, clientY: number) => {
    const box = host.current!.getBoundingClientRect();
    return { x: (clientX - box.left - view.x) / view.zoom, y: (clientY - box.top - view.y) / view.zoom };
  };
  const drag = (event: ReactPointerEvent, onMoveTo: (dx: number, dy: number, e: PointerEvent) => void, onEnd?: (e: PointerEvent) => void) => {
    const startX = event.clientX, startY = event.clientY;
    const move = (e: PointerEvent) => onMoveTo(e.clientX - startX, e.clientY - startY, e);
    const up = (e: PointerEvent) => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); onEnd?.(e); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const pan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest('.wf-node, .wf-edge')) return;
    onSelect(null);
    const origin = view;
    drag(event, (dx, dy) => setView({ ...origin, x: origin.x + dx, y: origin.y + dy }));
  };
  const moveNode = (event: ReactPointerEvent, item: FlowNode) => {
    if (event.button !== 0 || (event.target as Element).closest('.wf-port')) return;
    event.stopPropagation();
    onSelect({ kind: 'node', id: item.id });
    // A click is not a move: only a real drag changes the layout (and marks the workflow unsaved).
    let moved = false;
    drag(event, (dx, dy) => {
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      onMove(item.id, Math.round(item.x + dx / view.zoom), Math.round(item.y + dy / view.zoom));
    });
  };
  const startLink = (event: ReactPointerEvent, item: FlowNode) => {
    event.stopPropagation(); event.preventDefault();
    const at = toCanvas(event.clientX, event.clientY);
    setLink({ source: item.id, ...at });
    drag(event, (_dx, _dy, e) => setLink({ source: item.id, ...toCanvas(e.clientX, e.clientY) }), e => {
      setLink(null);
      const target = (document.elementFromPoint(e.clientX, e.clientY) as Element | null)?.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
      if (target && target !== item.id && byId.get(target)?.type !== 'start') onConnect(item.id, target);
    });
  };
  const zoom = (factor: number) => setView(current => ({ ...current, zoom: Math.min(1.8, Math.max(.4, current.zoom * factor)) }));
  const fit = () => {
    if (!host.current || !flow.nodes.length) return setView({ x: 0, y: 0, zoom: 1 });
    const box = host.current.getBoundingClientRect();
    const minX = Math.min(...flow.nodes.map(n => n.x)), minY = Math.min(...flow.nodes.map(n => n.y));
    const maxX = Math.max(...flow.nodes.map(n => n.x + NODE_W)), maxY = Math.max(...flow.nodes.map(n => n.y + NODE_H));
    const scale = Math.min(1.2, Math.max(.4, Math.min((box.width - 80) / (maxX - minX), (box.height - 80) / (maxY - minY))));
    setView({ zoom: scale, x: (box.width - (maxX - minX) * scale) / 2 - minX * scale, y: (box.height - (maxY - minY) * scale) / 2 - minY * scale });
  };
  useEffect(() => { fit(); }, [flow.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Bring a newly added step into view.
  const count = useRef(flow.nodes.length);
  useEffect(() => {
    const added = flow.nodes.length > count.current;
    count.current = flow.nodes.length;
    const last = flow.nodes[flow.nodes.length - 1];
    if (!added || !last || !host.current) return;
    const box = host.current.getBoundingClientRect();
    setView(current => {
      const left = last.x * current.zoom + current.x, top = last.y * current.zoom + current.y;
      const dx = left < 20 ? 20 - left : left + NODE_W * current.zoom > box.width - 20 ? box.width - 20 - NODE_W * current.zoom - left : 0;
      const dy = top < 20 ? 20 - top : top + NODE_H * current.zoom > box.height - 60 ? box.height - 60 - NODE_H * current.zoom - top : 0;
      return dx || dy ? { ...current, x: current.x + dx, y: current.y + dy } : current;
    });
  }, [flow.nodes]);
  // Native listener: React's wheel handler is passive and cannot stop the page zoom.
  useEffect(() => {
    const element = host.current;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) zoom(event.deltaY < 0 ? 1.1 : .9);
      else setView(current => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }));
    };
    element?.addEventListener('wheel', wheel, { passive: false });
    return () => element?.removeEventListener('wheel', wheel);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!selected || !['Delete', 'Backspace'].includes(event.key)) return;
      if ((event.target as Element)?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      if (selected.kind === 'node' && byId.get(selected.id)?.type === 'start' && flow.nodes.filter(n => n.type === 'start').length === 1) return;
      event.preventDefault(); onDelete();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [selected, byId, flow.nodes, onDelete]);

  const linkSource = link && byId.get(link.source);
  return <div className="wf-canvas" ref={host} onPointerDown={pan}
    style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${20 * view.zoom}px ${20 * view.zoom}px` }}>
    <div className="wf-stage" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
      <svg className="wf-edges" aria-hidden="false">
        <defs><marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 10 5 0 10z" fill="currentColor"/></marker></defs>
        {flow.edges.map(edge => {
          const source = byId.get(edge.source), target = byId.get(edge.target);
          if (!source || !target) return null;
          const d = edgePath(source.x + NODE_W, source.y + NODE_H / 2, target.x, target.y + NODE_H / 2);
          const active = selected?.kind === 'edge' && selected.id === edge.id;
          const flowing = run?.steps[edge.source]?.status === 'done' && run.steps[edge.target]?.status === 'running';
          return <g key={edge.id} className={`wf-edge ${active ? 'selected' : ''} ${flowing ? 'flowing' : ''}`} onPointerDown={event => { event.stopPropagation(); onSelect({ kind: 'edge', id: edge.id }); }}>
            <path className="wf-edge-hit" d={d}/><path className="wf-edge-line" d={d} markerEnd="url(#wf-arrow)"/>
          </g>;
        })}
        {link && linkSource && <path className="wf-edge-line wf-edge-draft" d={edgePath(linkSource.x + NODE_W, linkSource.y + NODE_H / 2, link.x, link.y)}/>}
      </svg>
      {flow.nodes.map(item => {
        const kind = KINDS[item.type];
        const step = run?.steps[item.id];
        return <div key={item.id} data-node-id={item.id} className={`wf-node wf-${kind.group.toLowerCase()} ${selected?.kind === 'node' && selected.id === item.id ? 'selected' : ''} ${step ? `is-${step.status}` : ''}`}
          style={{ left: item.x, top: item.y, width: NODE_W, height: NODE_H }} onPointerDown={event => moveNode(event, item)} title={step?.error || step?.summary || kind.hint}>
          {item.type !== 'start' && <span className="wf-port wf-port-in" aria-hidden="true"/>}
          <span className="wf-node-icon"><Icon name={kind.icon} size={15}/></span>
          <span className="wf-node-copy"><strong>{item.label || kind.title}</strong><small>{describe(item)}</small>
            {step && step.status !== 'pending' && <em className="wf-node-status">{STATUS_LABELS[step.status]}{step.detail ? ` · ${step.detail}` : step.summary ? ` · ${step.summary}` : ''}</em>}</span>
          <span className="wf-port wf-port-out" role="button" aria-label={`Connect “${item.label || kind.title}” to another step`} title="Drag to another step to connect" onPointerDown={event => startLink(event, item)}/>
        </div>;
      })}
    </div>
    <div className="wf-zoom" role="toolbar" aria-label="Zoom">
      <button type="button" aria-label="Zoom out" onClick={() => zoom(.85)}>−</button>
      <button type="button" aria-label="Fit the workflow" title="Fit" onClick={fit}>{Math.round(view.zoom * 100)} %</button>
      <button type="button" aria-label="Zoom in" onClick={() => zoom(1.15)}>+</button>
    </div>
    {!!flow.runs?.length && <div className="wf-canvas-run" onPointerDown={event => event.stopPropagation()}><span>Showing run</span><RunPicker runs={flow.runs} current={run} onPick={onRun}/></div>}
    {flow.nodes.length <= 1 && <p className="wf-canvas-hint">Use “Add a step”, then drag from the ● on the right of a step to the next one.</p>}
  </div>;
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="wf-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

/** Workflow inspector: the runs with every step's output, and the settings. */
function WorkflowPanel({ flow, engines, state, onChange, onRemove, currentRun, onRun, onJournal, onDelete, onDecided, onStep }: {
  flow: Workflow; engines: { id: string; name: string }[]; state: any; onChange: (values: Partial<Workflow>) => void; onRemove: () => void;
  currentRun: Run | null; onRun: (id: string) => void; onJournal: (id: string) => void; onDelete: (id?: string) => void;
  onDecided: (flow: Workflow) => void; onStep: (id: string) => void;
}) {
  const runs = flow.runs || [];
  const [tab, setTab] = useState<'runs' | 'settings'>(runs.length ? 'runs' : 'settings');
  useEffect(() => { if (flow.running) setTab('runs'); }, [flow.running]);
  return <div className="wf-panel">
    <div className="wf-tabs" role="tablist" aria-label="Workflow view">
      <button type="button" role="tab" aria-selected={tab === 'runs'} onClick={() => setTab('runs')}>Runs{runs.length > 0 && <span className="wf-count">{runs.length}</span>}</button>
      <button type="button" role="tab" aria-selected={tab === 'settings'} onClick={() => setTab('settings')}>Settings</button>
    </div>
    {tab === 'runs'
      ? <RunHistory flow={flow} currentRun={currentRun} onRun={onRun} onJournal={onJournal} onDelete={onDelete} onDecided={onDecided} onStep={onStep}/>
      : <WorkflowSettings flow={flow} engines={engines} state={state} onChange={onChange} onRemove={onRemove}/>}
  </div>;
}

/** Every run, newest first; the open run lists each step with what it produced. */
function RunHistory({ flow, currentRun, onRun, onJournal, onDelete, onDecided, onStep }: {
  flow: Workflow; currentRun: Run | null; onRun: (id: string) => void; onJournal: (id: string) => void; onDelete: (id?: string) => void;
  onDecided: (flow: Workflow) => void; onStep: (id: string) => void;
}) {
  const runs = flow.runs || [];
  if (!runs.length) return <p className="wf-hint">No run yet. Press Run: the output of every step will be listed here, run by run.</p>;
  return <>
    <ul className="wf-runs">{runs.map((item, position) => {
      const open = currentRun?.id === item.id;
      return <li key={item.id} className={open ? 'active' : ''}>
        <div className="wf-run-row">
          <button type="button" className="wf-run-open" aria-expanded={open} onClick={() => onRun(item.id)}>
            <span className="wf-run-caret"><Icon name="chevron" size={11}/></span>
            <span className="wf-run-copy"><strong>Run #{runs.length - position} · {when(item.started_at)}</strong><small>{item.trigger === 'schedule' ? 'Scheduled' : 'Manual'} · {duration(item.started_at, item.finished_at)}</small></span>
            <span className={`wf-badge is-${item.status}`}>{STATUS_LABELS[item.status] || item.status}</span>
          </button>
        </div>
        {open && <div className="wf-run-body">
          {item.error && <p className="wf-error">{item.error}</p>}
          <RunSteps flow={flow} run={item} onDecided={onDecided} onStep={onStep}/>
          <div className="wf-run-links">
            <button type="button" className="text-link" onClick={() => onJournal(item.id)}>Full journal</button>
            <button type="button" className="text-link wf-link-danger" disabled={item.status === 'running'} title={item.status === 'running' ? 'Stop the run before deleting it' : undefined} onClick={() => onDelete(item.id)}>Delete this run</button>
          </div>
        </div>}
      </li>;
    })}</ul>
    {runs.some(item => item.status !== 'running') && runs.length > 1 && <button type="button" className="text-link wf-link-danger" onClick={() => onDelete()}>Clear the history</button>}
  </>;
}

/** The steps of one run in execution order, each opening on its output. */
function RunSteps({ flow, run, onDecided, onStep }: { flow: Workflow; run: Run; onDecided: (flow: Workflow) => void; onStep: (id: string) => void }) {
  const position = new Map(flow.nodes.map((node, index) => [node.id, index]));
  const steps = Object.entries(run.steps).filter(([id]) => flow.nodes.find(node => node.id === id)?.type !== 'start').sort(([a, x], [b, y]) =>
    (Date.parse(x.started_at || '') || Infinity) - (Date.parse(y.started_at || '') || Infinity) || (position.get(a) ?? 0) - (position.get(b) ?? 0));
  return <ol className="wf-run-steps">{steps.map(([id, step]) => <li key={id}>
    <details open={step.status === 'running' || step.status === 'failed' || undefined}>
      <summary><span className={`wf-dot is-${step.status}`} aria-label={STATUS_LABELS[step.status]}/><span className="wf-run-step-copy"><strong>{stepName(flow, id)}</strong>
        <small>{step.error ? STATUS_LABELS[step.status] : step.summary || STATUS_LABELS[step.status]}</small></span>
        <button type="button" className="wf-run-step-locate" title="Show this step on the canvas" aria-label={`Show “${stepName(flow, id)}” on the canvas`} onClick={event => { event.preventDefault(); onStep(id); }}><Icon name="arrow" size={11}/></button></summary>
      <StepResult flow={flow} run={run} nodeId={id} step={step} onDecided={onDecided} badge={false}/>
    </details>
  </li>)}</ol>;
}

function WorkflowSettings({ flow, engines, state, onChange, onRemove }: {
  flow: Workflow; engines: { id: string; name: string }[]; state: any; onChange: (values: Partial<Workflow>) => void; onRemove: () => void;
}) {
  return <>
    <Field label="Description"><textarea rows={2} value={flow.description} onChange={event => onChange({ description: event.target.value })} placeholder="What this workflow is for"/></Field>
    <Field label="Project" hint="Optional: notes and tasks are created in it, and agents see its context, unless a step chooses otherwise.">
      <select value={flow.scope.project_id ?? ''} onChange={event => onChange({ scope: { project_id: Number(event.target.value) || null } })}>
        <option value="">No project</option>{state.projects.map((p: Project) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </Field>
    <div className="wf-row">
      <Field label="Agent"><select value={flow.engine} onChange={event => onChange({ engine: event.target.value })}>
        {engines.length ? engines.map(engine => <option key={engine.id} value={engine.id}>{engine.name}</option>) : <option value={flow.engine}>No engine enabled</option>}
      </select></Field>
      <Field label="Model"><input value={flow.model} placeholder="Default" onChange={event => onChange({ model: event.target.value })}/></Field>
    </div>
    <div className="wf-row">
      <Field label="Schedule"><select value={flow.interval_hours} onChange={event => onChange({ interval_hours: Number(event.target.value) })}>
        {INTERVALS.map(([hours, label]) => <option key={hours} value={hours}>{label}</option>)}
      </select></Field>
      <Field label="Agent timeout"><select value={flow.timeout_minutes} onChange={event => onChange({ timeout_minutes: Number(event.target.value) })}>
        {[10, 20, 30, 60, 120].map(minutes => <option key={minutes} value={minutes}>{minutes} min</option>)}
      </select></Field>
    </div>
    <label className="wf-check"><input type="checkbox" checked={flow.enabled} onChange={event => onChange({ enabled: event.target.checked })}/>Scheduled runs enabled</label>
    {flow.interval_hours > 0 && flow.enabled && flow.next_run_at && <p className="wf-hint">Next run: {when(flow.next_run_at)}</p>}
    {flow.last_error && <p className="wf-error" role="status">{flow.last_error}</p>}
    <button type="button" className="button button-danger wf-remove" onClick={onRemove}><Icon name="trash" size={13}/>Delete the workflow</button>
  </>;
}

function fieldsOf(state: any, collectionId?: string): string[] {
  const definition = state.databases.find((d: any) => d.id === collectionId);
  const own = (definition?.fields || []).map((f: any) => f.id);
  const builtin: Record<string, string[]> = { articles: ['title', 'abstract', 'doi', 'status', 'tags', 'publication'], notes: ['title', 'project_id', 'folder_id'],
    tasks: ['title', 'status', 'priority', 'due_date', 'labels'], conferences: ['title', 'deadline', 'location'], datasets: ['title', 'domain', 'license'] };
  return [...new Set(['title', ...(builtin[collectionId || ''] || []), ...own])];
}

function FilterBuilder({ filters, fields, onChange }: { filters: Filter[]; fields: string[]; onChange: (filters: Filter[]) => void }) {
  const set = (index: number, patch: Partial<Filter>) => onChange(filters.map((filter, i) => i === index ? { ...filter, ...patch } : filter));
  return <div className="wf-filters">
    {filters.map((filter, index) => <div key={index} className="wf-filter">
      <input list="wf-filter-fields" aria-label="Field" value={filter.field} placeholder="field" onChange={event => set(index, { field: event.target.value })}/>
      <select aria-label="Condition" value={filter.op} onChange={event => set(index, { op: event.target.value })}>{OPS.map(([op, label]) => <option key={op} value={op}>{label}</option>)}</select>
      {!['empty', 'not_empty'].includes(filter.op) && <input aria-label="Value" value={filter.value} placeholder="value" onChange={event => set(index, { value: event.target.value })}/>}
      <button type="button" className="icon-button" aria-label="Remove the filter" onClick={() => onChange(filters.filter((_, i) => i !== index))}><Icon name="close" size={12}/></button>
    </div>)}
    <datalist id="wf-filter-fields">{fields.map(field => <option key={field} value={field}/>)}</datalist>
    <button type="button" className="text-link" onClick={() => onChange([...filters, { field: fields[0] || 'title', op: 'contains', value: '' }])}>＋ Add a filter</button>
  </div>;
}

function NodeInspector({ node, flow, run, step, watchers, state, onLabel, onConfig, onRun, onNewWatcher, onDecided, onRemove, onClose }: {
  node: FlowNode; flow: Workflow; run: Run | null; step?: Step; watchers: WatcherSummary[]; state: any;
  onLabel: (label: string) => void; onConfig: (values: Record<string, any>) => void; onRun: (id: string) => void; onNewWatcher: () => void;
  onDecided: (flow: Workflow) => void; onRemove: () => void; onClose: () => void;
}) {
  // A step that ran opens on its output; a new run switches to it so it can be followed live.
  const [tab, setTab] = useState<'settings' | 'result'>(step ? 'result' : 'settings');
  useEffect(() => { if (run?.status === 'running') setTab('result'); }, [run?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const c = node.config;
  const kind = KINDS[node.type];
  const projectId = c.project_id ?? flow.scope.project_id ?? null;
  const check = (key: string, label: string, fallback = false) => <label className="wf-check"><input type="checkbox" checked={c[key] ?? fallback} onChange={event => onConfig({ [key]: event.target.checked })}/>{label}</label>;
  const number = (key: string, label: string, fallback: number, max = 50, hint?: string) => <Field label={label} hint={hint}><input type="number" min={1} max={max} value={c[key] ?? fallback} onChange={event => onConfig({ [key]: Number(event.target.value) })}/></Field>;
  const prompt = (label: string, placeholder: string, rows = 6) => <Field label={label}><textarea rows={rows} value={c.prompt || ''} placeholder={placeholder} onChange={event => onConfig({ prompt: event.target.value })}/></Field>;
  const projectSelect = <Field label="Project"><select value={c.project_id ?? ''} onChange={event => onConfig({ project_id: Number(event.target.value) || null, folder_id: null })}>
    <option value="">{flow.scope.project_id ? 'Workflow project' : 'No project'}</option>{state.projects.map((p: Project) => <option key={p.id} value={p.id}>{p.name}</option>)}
  </select></Field>;
  const collections = <>{state.databases.map((d: any) => <option key={d.id} value={d.id}>{d.id === 'articles' ? 'Library (articles)' : d.name}</option>)}</>;
  const notes = state.notes.filter((n: Note) => !n.trashed_at).sort((a: Note, b: Note) => a.title.localeCompare(b.title));
  const noteSelect = <Field label="Note"><select value={c.note_id ?? ''} onChange={event => onConfig({ note_id: Number(event.target.value) || null })}>
    <option value="">Choose a note</option>{notes.map((n: Note) => <option key={n.id} value={n.id}>{n.title}</option>)}
  </select></Field>;
  const folderSelect = (label: string) => <Field label={label}><select value={c.folder_id ?? ''} onChange={event => onConfig({ folder_id: Number(event.target.value) || null })}>
    <option value="">Choose a folder</option>{state.paperFolders.map((f: PaperFolder) => <option key={f.id} value={f.id}>{f.name}</option>)}
  </select></Field>;
  const perItem = (one: string, each: string) => <Field label="Run"><select value={c.per_item ? 'item' : 'all'} onChange={event => onConfig({ per_item: event.target.value === 'item' })}>
    <option value="item">{each}</option><option value="all">{one}</option></select></Field>;

  return <div className="wf-panel">
    <header className="wf-panel-head"><span className="wf-node-icon"><Icon name={kind.icon} size={15}/></span><h2>{node.label || kind.title}</h2>
      <button type="button" className="icon-button" aria-label="Back to the workflow settings" title="Workflow settings" onClick={onClose}><Icon name="close" size={13}/></button></header>
    {run && <div className="wf-tabs" role="tablist" aria-label="Step view">
      <button type="button" role="tab" aria-selected={tab === 'result'} onClick={() => setTab('result')}>
        Output{step && step.status !== 'pending' && <span className={`wf-tab-dot is-${step.status}`} aria-label={STATUS_LABELS[step.status]}/>}</button>
      <button type="button" role="tab" aria-selected={tab === 'settings'} onClick={() => setTab('settings')}>Settings</button>
    </div>}
    {tab === 'result' && run ? <>
      <RunPicker runs={flow.runs || []} current={run} onPick={onRun}/>
      {step ? <StepResult flow={flow} run={run} nodeId={node.id} step={step} onDecided={onDecided}/> : <p className="wf-hint">This step did not exist yet during this run.</p>}
    </> : <>
    <p className="wf-hint">{kind.hint}</p>
    {node.type !== 'start' && <Field label="Step name"><input value={node.label} placeholder={kind.title} onChange={event => onLabel(event.target.value)}/></Field>}

    {node.type === 'start' && <p className="wf-hint">The schedule and the agent are set in the workflow settings (click the empty canvas).</p>}

    {node.type === 'watcher' && <>
      <Field label="Watcher"><select value={c.watcher_id ?? ''} onChange={event => onConfig({ watcher_id: Number(event.target.value) || null })}>
        <option value="">Choose a watcher</option>{watchers.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
      </select></Field>
      <button type="button" className="text-link" onClick={onNewWatcher}>＋ Create a watcher (opens Watchers)</button>
      {watchers.find(w => w.id === Number(c.watcher_id))?.direct ? <>
        <Field label="Minimum interest"><select value={c.min_rating ?? 0} onChange={event => onConfig({ min_rating: Number(event.target.value) })}>
          {[0, 1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value ? `${value}/5 or more` : 'Every suggestion'}</option>)}
        </select></Field>
        {check('auto_import', 'Import the new articles into the library')}
        <p className="wf-hint">Without import, the next steps receive the suggestions (title, abstract, DOI).</p>
      </> : c.watcher_id ? <p className="wf-hint">The next steps receive what the watcher added or proposed, and its report.</p> : null}
    </>}

    {node.type === 'collection_read' && <>
      <Field label="Collection"><select value={c.collection_id ?? ''} onChange={event => onConfig({ collection_id: event.target.value || null, filters: [] })}>
        <option value="">Choose a collection</option>{collections}</select></Field>
      {c.collection_id && <>
        <span className="wf-field"><span>Filters</span></span>
        <FilterBuilder filters={c.filters || []} fields={fieldsOf(state, c.collection_id)} onChange={filters => onConfig({ filters })}/>
        {c.collection_id === 'articles' && folderSelect('Library folder (optional)')}
        {check('only_new', 'Only items added or changed since the last successful run')}
        {number('limit', 'At most', 20)}
      </>}
    </>}

    {node.type === 'note_read' && noteSelect}

    {node.type === 'project' && <>
      {projectSelect}
      {check('articles', 'Articles', true)}{check('notes', 'Notes', true)}{check('tasks', 'Tasks')}
      {number('limit', 'At most per kind', 30)}
    </>}

    {node.type === 'paper_folder' && <>
      {folderSelect('Folder')}
      {check('include_subfolders', 'Include subfolders', true)}
      {check('only_new', 'Only articles added since the last successful run')}
      {number('limit', 'At most', 20)}
    </>}

    {node.type === 'local_folder' && <>
      <Field label="Folder on this computer" hint="Absolute path, e.g. C:\Users\me\project. Checked when you save.">
        <input value={c.path || ''} placeholder="C:\path\to\folder" onChange={event => onConfig({ path: event.target.value })}/></Field>
      <Field label="Files" hint="Patterns separated by commas, e.g. *.py, src/*.ts. Empty: every file."><input value={c.patterns || ''} placeholder="*.py, *.md" onChange={event => onConfig({ patterns: event.target.value })}/></Field>
      {number('limit', 'At most', 40, 200, 'Files listed with an excerpt; the agent can read any file of the folder.')}
      {check('allow_changes', 'Allow proposing changes (each diff waits for your approval)')}
    </>}

    {node.type === 'summarize' && <>{prompt('What the summary must contain', 'Question, method, results, limits…')}{perItem('Once for all the items', 'Once per item')}{number('max_items', 'At most', 10)}</>}
    {node.type === 'filter_sort' && <>{prompt('Criteria', 'E.g. keep only clinical studies with more than 100 patients, best evidence first.')}<Field label="Keep at most" hint="Empty: every relevant item."><input type="number" min={1} max={50} value={c.keep_max ?? ''} placeholder="All" onChange={event => onConfig({ keep_max: Number(event.target.value) || null })}/></Field>{number('max_items', 'Items examined', 30)}</>}
    {node.type === 'extract' && <>
      <Field label="Fields to extract" hint="Separated by commas; they become fields of each item."><input value={c.fields || ''} placeholder="sample size, method, main result, dataset" onChange={event => onConfig({ fields: event.target.value })}/></Field>
      {prompt('Precisions', 'E.g. give numbers with their units; quote the page when possible.', 3)}{number('max_items', 'At most', 20)}</>}
    {node.type === 'compare' && <>{prompt('What to compare', 'E.g. methods, populations, effect sizes and limits.')}{number('max_items', 'At most', 20)}</>}
    {node.type === 'build' && <>{prompt('What to build', 'E.g. a state of the art in three parts with references; or a protocol; or a plan of the paper.')}{number('max_items', 'At most', 30)}</>}
    {node.type === 'agent_task' && <>{prompt('Instructions for the agent', 'Describe precisely what to produce…', 8)}{perItem('Once for all the items', 'Once per item')}{number('max_items', 'At most', 10)}</>}

    {node.type === 'collection_write' && <>
      <Field label="Collection"><select value={c.collection_id ?? ''} onChange={event => onConfig({ collection_id: event.target.value || null })}>
        <option value="">Choose a collection</option>{collections}</select></Field>
      <Field label="How to fill it"><textarea rows={5} value={c.instructions || ''} placeholder="E.g. one row per article; fill Method, Sample size and Main result from the extracted fields." onChange={event => onConfig({ instructions: event.target.value })}/></Field>
      <Field label="Changes"><select value={c.apply_mode || 'review'} onChange={event => onConfig({ apply_mode: event.target.value })}>
        <option value="review">To review before applying</option><option value="auto">Applied directly</option></select></Field>
    </>}

    {node.type === 'note_update' && <>
      {noteSelect}
      <NewNoteButton flow={flow} onCreated={id => onConfig({ note_id: id })}/>
      <Field label="Where"><select value={c.position || 'append'} onChange={event => onConfig({ position: event.target.value })}>
        <option value="append">Add a section at the end</option><option value="prepend">Add a section at the beginning</option><option value="replace">Replace the section with this heading</option>
      </select></Field>
      <Field label="Section heading" hint={c.position === 'replace' ? 'The section with exactly this heading is replaced on each run (added if missing).' : 'Variables: {date}, {workflow}'}>
        <input value={c.heading ?? ''} placeholder={c.position === 'replace' ? 'Latest synthesis' : '{date} — {workflow}'} onChange={event => onConfig({ heading: event.target.value })}/></Field>
    </>}

    {node.type === 'note_create' && <>
      <Field label="Create"><select value={c.per_item ? 'item' : 'one'} onChange={event => onConfig({ per_item: event.target.value === 'item' })}>
        <option value="one">One new note per run</option><option value="item">One note per item</option></select></Field>
      <Field label="Title" hint="Variables: {title}, {date}, {workflow}, {doi}"><input value={c.title ?? ''} placeholder={c.per_item ? '{title}' : '{workflow} — {date}'} onChange={event => onConfig({ title: event.target.value })}/></Field>
      {projectSelect}
      <Field label="Notes folder"><select value={c.folder_id ?? ''} onChange={event => onConfig({ folder_id: Number(event.target.value) || null })}>
        <option value="">Root</option>{state.noteFolders.filter((f: NoteFolder) => (f.project_id ?? null) === projectId).map((f: NoteFolder) => <option key={f.id} value={f.id}>{f.name}</option>)}
      </select></Field>
      {c.per_item && check('link_article', 'Attach each note to its article', true)}
    </>}

    {node.type === 'task' && <>
      <Field label="Create"><select value={c.per_item ? 'item' : 'one'} onChange={event => onConfig({ per_item: event.target.value === 'item' })}>
        <option value="item">One task per item</option><option value="one">One task for the whole run</option></select></Field>
      <Field label="Title" hint="Variables: {title}, {date}, {workflow}"><input value={c.title ?? ''} placeholder={c.per_item ? 'Review “{title}”' : '{workflow}'} onChange={event => onConfig({ title: event.target.value })}/></Field>
      {projectSelect}
      <div className="wf-row">
        <Field label="Column"><select value={c.column_id ?? ''} onChange={event => onConfig({ column_id: Number(event.target.value) || null })}>
          <option value="">First column</option>{state.taskColumns.map((col: any) => <option key={col.id} value={col.id}>{col.name}</option>)}
        </select></Field>
        <Field label="Due in"><select value={c.due_in_days ?? ''} onChange={event => onConfig({ due_in_days: Number(event.target.value) || null })}>
          <option value="">No date</option>{[1, 3, 7, 14, 30].map(days => <option key={days} value={days}>{days} day{days > 1 ? 's' : ''}</option>)}
        </select></Field>
      </div>
      <Field label="Priority"><select value={c.priority || 'medium'} onChange={event => onConfig({ priority: event.target.value })}>
        <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></Field>
    </>}

    {node.type === 'paper_folder_file' && folderSelect('Folder')}

    {node.type === 'local_changes' && <>
      {prompt('Changes to make', 'E.g. update the analysis script to use the extracted parameters; keep the style of the code.')}
      <p className="wf-hint">Connect a “Local folder” step with “Allow proposing changes” before this step. Every change waits here as a diff.</p>
    </>}

    {node.type !== 'start' && <button type="button" className="button wf-remove" onClick={onRemove}><Icon name="trash" size={13}/>Remove this step</button>}
    </>}
  </div>;
}

/** Everything one step of a run received, did and produced. */
function StepResult({ flow, run, nodeId, step, onDecided, badge = true }: { flow: Workflow; run: Run; nodeId: string; step: Step; onDecided: (flow: Workflow) => void; badge?: boolean }) {
  if (step.status === 'pending') return <p className="wf-hint">{run.status === 'running' ? 'Waiting for the previous steps…' : 'This step did not run.'}</p>;
  const running = step.status === 'running';
  return <section className="wf-step-result">
    <div className="wf-result-head">{badge && <span className={`wf-badge is-${step.status}`}>{STATUS_LABELS[step.status]}</span>}
      {step.started_at && <small>Started {clock(step.started_at)}{` · ${duration(step.started_at, step.finished_at)}`}</small>}</div>
    {running && <p className="wf-live"><span className="wf-pulse" aria-hidden="true"/>{step.detail || (step.agent_run ? 'The agent is working…' : 'Working…')}</p>}
    {step.summary && <p className="wf-result-summary">{step.summary}</p>}
    {step.error && <p className="wf-error">{step.error}</p>}
    {step.output && <div className="wf-output"><div className="wf-output-head"><strong>Output</strong>
      <button type="button" className="text-link" onClick={() => navigator.clipboard.writeText(step.output || '').then(() => toast('Output copied'), () => toast('Copy failed', 'error'))}>Copy</button></div>
      <pre>{step.output}</pre></div>}
    {!!step.items?.length && <details open={!step.output || undefined}><summary>Items passed on ({step.item_count ?? step.items.length})</summary><ol className="wf-items">{step.items.map(item => <li key={item.key}>{item.title}{item.reason && <small>{item.reason}</small>}</li>)}</ol></details>}
    {!!step.changes?.length && flow.id && <StepChanges workflowId={flow.id} runId={run.id} nodeId={nodeId} changes={step.changes} onDecided={onDecided}/>}
    {(step.input || !!step.agent_calls?.length) && <details className="wf-trace" open={running || undefined}><summary>How it was produced</summary>
      {step.input && <details><summary>Input · {step.input.item_count} item(s){step.input.text ? ' and text' : ''}</summary>
        {!!step.input.items.length && <ol className="wf-items">{step.input.items.map(item => <li key={item.key}>{item.title}</li>)}</ol>}
        {step.input.text && <pre>{step.input.text}</pre>}
        {!step.input.item_count && !step.input.text && <p className="wf-hint">Nothing received from the previous steps.</p>}
      </details>}
      {step.agent_calls?.map((call, index) => <AgentActivity key={call.run_id} call={call} label={step.agent_calls!.length > 1 ? `Agent request ${index + 1}/${step.agent_calls!.length}` : 'Agent request'}
        showAnswer={call.response.trim() !== (step.output || '').trim()}/>)}
    </details>}
  </section>;
}

/** One agent request of a step: its prompt, its activity (followed live while it runs) and its answer. */
function AgentActivity({ call, label, showAnswer = true }: { call: AgentCall; label: string; showAnswer?: boolean }) {
  const live = call.status === 'running';
  const [current, setCurrent] = useState<{ events: AgentEvent[]; response: string | null } | null>(null);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (!live) { setCurrent(null); return; }
    let stopped = false;
    const poll = () => api<{ events: AgentEvent[]; response: string | null }>(`/external-agents/runs/${call.run_id}`)
      .then(value => { if (!stopped) setCurrent(value); }).catch(() => undefined);
    void poll();
    const timer = setInterval(poll, 1500);
    return () => { stopped = true; clearInterval(timer); };
  }, [live, call.run_id]);
  const events = coalesce((live ? current?.events : call.events) || []);
  const response = live ? current?.response : showAnswer ? call.response : '';
  useEffect(() => { if (live && list.current) list.current.scrollTop = list.current.scrollHeight; }, [events.length, live]);
  return <div className="wf-agent-call">
    <div className="wf-result-head"><strong>{label}</strong><span className={`wf-badge is-${call.status === 'completed' ? 'done' : call.status}`}>{live ? 'Working' : STATUS_LABELS[call.status] || call.status}</span>
      <small>{clock(call.started_at)} · {duration(call.started_at, call.finished_at)}</small></div>
    <details><summary>Prompt sent</summary><pre>{call.prompt}</pre></details>
    {events.length > 0 && <details open={live || undefined}><summary>Activity ({events.length})</summary>
      <ol ref={list} className="wf-activity">{events.map((event, index) => <li key={event.id ?? index} className={`is-${event.kind}`}>
        <span>{event.at && <time>{clock(event.at)}</time>}<strong>{event.label}</strong></span>{event.detail && <pre>{event.detail}</pre>}</li>)}</ol></details>}
    {live && !events.length && <p className="wf-hint">Waiting for the agent's first action…</p>}
    {response && <details open={!live || undefined}><summary>Answer</summary><pre>{response}</pre></details>}
    {call.error && <p className="wf-error">{call.error}</p>}
  </div>;
}

/** The full record of a run: a timeline of its events and the data of every step, exportable as JSON. */
function RunJournal({ flow, run, onDecided, onClose, onStep, onDelete }: { flow: Workflow; run: Run; onDecided: (flow: Workflow) => void; onClose: () => void; onStep: (id: string) => void; onDelete: () => void }) {
  const [filter, setFilter] = useState('all');
  const log = run.log || [];
  const shown = log.filter(entry => filter === 'all' || (filter === 'issues' ? entry.level !== 'info' : entry.node_id === filter));
  const position = new Map(flow.nodes.map((node, index) => [node.id, index]));
  const steps = Object.entries(run.steps).sort(([a, x], [b, y]) =>
    (Date.parse(x.started_at || '') || Infinity) - (Date.parse(y.started_at || '') || Infinity) || (position.get(a) ?? 0) - (position.get(b) ?? 0));
  const count = (status: StepStatus) => steps.filter(([, step]) => step.status === status).length;
  const data = () => JSON.stringify({ workflow: { id: flow.id, name: flow.name, engine: flow.engine, model: flow.model, nodes: flow.nodes, edges: flow.edges }, run }, null, 2);
  const download = () => {
    const url = URL.createObjectURL(new Blob([data()], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${flow.name.replace(/[^\w-]+/g, '-')}-${run.started_at.slice(0, 19).replace(/[:T]/g, '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const copy = () => navigator.clipboard.writeText(data()).then(() => toast('Run data copied'), () => toast('Copy failed', 'error'));
  return <OverlayPanel className="wf-journal" label="Run journal" title={`Run journal · ${when(run.started_at)}`} onClose={onClose} closeLabel="Close the journal"
    actions={<><button type="button" className="button" onClick={() => void copy()}>Copy JSON</button><button type="button" className="button" onClick={download}>Download</button>
      <button type="button" className="button button-danger" disabled={run.status === 'running'} title={run.status === 'running' ? 'Stop the run before deleting it' : 'Delete this run and its journal'} onClick={onDelete}><Icon name="trash" size={13}/>Delete</button></>}>
    <div className="wf-journal-body">
      <section className="wf-journal-summary">
        <span className={`wf-badge is-${run.status}`}>{STATUS_LABELS[run.status] || run.status}</span>
        <dl>
          <div><dt>Trigger</dt><dd>{run.trigger === 'schedule' ? 'Scheduled' : 'Manual'}</dd></div>
          <div><dt>Started</dt><dd>{when(run.started_at)}</dd></div>
          <div><dt>Duration</dt><dd>{duration(run.started_at, run.finished_at)}{run.status === 'running' ? ' (running)' : ''}</dd></div>
          <div><dt>Steps</dt><dd>{count('done')} done{count('failed') ? ` · ${count('failed')} failed` : ''}{count('skipped') ? ` · ${count('skipped')} skipped` : ''}{count('running') ? ' · 1 running' : ''}</dd></div>
        </dl>
        {run.error && <p className="wf-error">{run.error}</p>}
      </section>
      <section>
        <header className="wf-journal-head"><h3>Timeline</h3>
          <select aria-label="Filter the timeline" value={filter} onChange={event => setFilter(event.target.value)}>
            <option value="all">All events</option><option value="issues">Warnings and errors</option>
            {flow.nodes.filter(node => run.steps[node.id]).map(node => <option key={node.id} value={node.id}>{stepName(flow, node.id)}</option>)}
          </select></header>
        {log.length ? <ol className="wf-log">{shown.map((entry, index) => <li key={index} className={`is-${entry.level}`}>
          <time>{clock(entry.at)}</time>
          <div>{entry.node_id && <button type="button" className="wf-log-step" title="Show this step" onClick={() => onStep(entry.node_id!)}>{stepName(flow, entry.node_id)}</button>}<span>{entry.message}</span>
            {entry.detail && <details><summary>Details</summary><pre>{entry.detail}</pre></details>}</div>
        </li>)}{!shown.length && <li className="wf-hint">No event matches this filter.</li>}</ol>
          : <p className="wf-hint">This run was recorded before the journal existed: only the step results below are available.</p>}
      </section>
      <section>
        <h3>Steps</h3>
        {steps.map(([id, step]) => <details key={id} className="wf-journal-step" open={step.status === 'running' || step.status === 'failed' || undefined}>
          <summary><span className={`wf-badge is-${step.status}`}>{STATUS_LABELS[step.status]}</span><strong>{stepName(flow, id)}</strong>
            <small>{step.started_at ? duration(step.started_at, step.finished_at) : ''}</small></summary>
          <StepResult flow={flow} run={run} nodeId={id} step={step} onDecided={onDecided} badge={false}/>
        </details>)}
      </section>
    </div>
  </OverlayPanel>;
}

function NewNoteButton({ flow, onCreated }: { flow: Workflow; onCreated: (id: number) => void }) {
  const create = async () => {
    const title = prompt('Title of the new note', `${flow.name} — synthesis`);
    if (!title?.trim()) return;
    try {
      const note = await api<Note>('/notes', { method: 'POST', body: JSON.stringify({ title: title.trim(), content: `# ${title.trim()}\n\n`, project_id: flow.scope.project_id }) });
      await refreshData(); onCreated(note.id);
    } catch (error) { toast((error as Error).message, 'error'); }
  };
  return <button type="button" className="text-link" onClick={() => void create()}>＋ Create a new note</button>;
}

function StepChanges({ workflowId, runId, nodeId, changes, onDecided }: {
  workflowId: number; runId: string; nodeId: string; changes: Change[]; onDecided: (flow: Workflow) => void;
}) {
  const [busy, setBusy] = useState(false);
  const decide = async (items: Change[], decision: 'apply' | 'dismiss') => {
    setBusy(true);
    try {
      let latest: Workflow | null = null;
      for (const change of items) {
        latest = await api<Workflow>(`/workflows/${workflowId}/changes/decide`, { method: 'POST',
          body: JSON.stringify({ run_id: runId, node_id: nodeId, proposal_id: change.proposal_id, decision }) });
      }
      if (latest) onDecided(latest);
      if (decision === 'apply') { void refreshData(); toast(`${items.length} change(s) applied`); }
    } catch (failure) { toast((failure as Error).message, 'error'); } finally { setBusy(false); }
  };
  const pending = changes.filter(change => change.status === 'pending');
  return <div className="wf-changes">
    <div className="wf-changes-head"><strong>Changes</strong><span>{pending.length} to review</span>
      {pending.length > 1 && <button type="button" className="button button-primary" disabled={busy} onClick={() => void decide(pending, 'apply')}>Apply all</button>}</div>
    <ul className="wf-proposals">{changes.map(item => <li key={item.proposal_id}>
      <span><strong>{item.label}</strong><small>{item.target}</small>
        {item.diff && <details><summary>Diff</summary><pre className="wf-diff">{item.diff}</pre></details>}</span>
      {item.status === 'pending' ? <span className="wf-proposal-actions"><button type="button" className="button" disabled={busy} onClick={() => void decide([item], 'dismiss')}>Ignore</button><button type="button" className="button button-primary" disabled={busy} onClick={() => void decide([item], 'apply')}>Apply</button></span>
        : <span className={`wf-badge is-${item.status === 'applied' ? 'done' : 'skipped'}`}>{item.status === 'applied' ? 'Applied' : 'Ignored'}</span>}
    </li>)}</ul>
  </div>;
}
