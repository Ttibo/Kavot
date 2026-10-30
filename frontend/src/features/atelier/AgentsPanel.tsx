import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { toast } from '../../app/navigation';
import { Icon } from '../../components/Icon';
import { AgentMessageContent } from '../../components/AgentMessageContent';
import { api } from '../../services/api';
import { DiffView } from './DiffView';
import { openAtelierBeside, openNoteBeside } from '../projects/navigation';
import { setAtelierIntent } from './intent';
import { ACTIVE, atelierApi, cost, duration, post, relative, STATUS_LABELS, tokens, totalTokens, type Diff, type Engine, type Folder, type Overview, type Run, type RunDetail, type RunEvent, type Usage } from './types';

type Message = { kind: 'user' | 'agent'; at: string; text: string; final?: boolean };
type Activity = { kind: 'tool' | 'status' | 'error'; at: string; label: string; detail: string };
type Item = Message | Activity;

const QUIET = /^(Session started|Step |Run finished|Tool result|Sortie de l'outil|Done)/;
const KEPT_STATUS = /^(Worktree created|Ready for review|Stopped|Committed|Merged|Discarded)/;

/** The run as a conversation: messages, the agent's text and tool calls, in time order, without duplicates. */
function timeline(run: RunDetail): Item[] {
  const items: { item: Item; order: number }[] = [];
  const add = (item: Item) => items.push({ item, order: items.length });
  run.messages.forEach(message => add({ kind: message.role === 'user' ? 'user' : 'agent', at: message.at, text: message.content, final: message.role === 'assistant' }));
  run.events.forEach((event: RunEvent) => {
    if (event.kind === 'raw' || event.kind === 'log' || QUIET.test(event.label)) return;
    if (event.kind === 'message') add({ kind: 'agent', at: event.at, text: event.detail });
    else if (event.kind === 'tool' || event.kind === 'error') add({ kind: event.kind, at: event.at, label: event.label, detail: event.detail });
    else if (KEPT_STATUS.test(event.label) || event.kind === 'write') add({ kind: 'status', at: event.at, label: event.label, detail: event.detail });
  });
  items.sort((a, b) => a.item.at.localeCompare(b.item.at) || a.order - b.order);
  const result: Item[] = [];
  for (const { item } of items) {
    const previous = result[result.length - 1];
    if (item.kind === 'agent' && item.final) {
      // The final answer usually repeats the agent's last streamed message.
      const last = [...result].reverse().find(entry => entry.kind === 'agent' || entry.kind === 'user');
      if (last?.kind === 'agent' && last.text.trim() === item.text.trim()) continue;
    }
    if (item.kind === 'tool' && previous?.kind === 'tool' && previous.label === item.label && (!previous.detail || previous.detail === item.detail)) {
      result[result.length - 1] = item;
      continue;
    }
    result.push(item);
  }
  return result;
}

/** A tool call in one line: the file, command or pattern it used. */
function describeTool(detail: string) {
  try {
    const input = JSON.parse(detail);
    if (input && typeof input === 'object')
      return String(input.file_path || input.path || input.command || input.pattern || input.query || input.url || '');
  } catch { /* Plain text detail (Codex, OpenCode). */ }
  const first = detail.split('\n').find(line => line.trim()) || '';
  return first.length > 140 ? `${first.slice(0, 139)}…` : first;
}

function ToolLine({ label, detail }: { label: string; detail: string }) {
  const target = describeTool(detail);
  const icon = /edit|write|patch|file change/i.test(label) ? 'edit' : /bash|command|shell|exec/i.test(label) ? 'code' : /read|glob|grep|search|list/i.test(label) ? 'search' : 'sparkle';
  const body = <><Icon name={icon} size={12}/><strong>{label}</strong>{target && <code>{target}</code>}</>;
  return detail && detail.trim() !== target.trim()
    ? <details className="atelier-tool"><summary>{body}</summary><pre>{detail}</pre></details>
    : <div className="atelier-tool">{body}</div>;
}

function elapsed(from: string) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(from).getTime()) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function Composer({ value, onChange, onSend, disabled, busy, placeholder, children, autoFocus, actionLabel = 'Send' }: {
  value: string; onChange: (value: string) => void; onSend: () => void; disabled?: boolean; busy?: boolean;
  placeholder: string; children?: ReactNode; autoFocus?: boolean; actionLabel?: string;
}) {
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !disabled) { event.preventDefault(); onSend(); }
  };
  return <form className="atelier-composer" onSubmit={event => { event.preventDefault(); if (!disabled) onSend(); }}>
    <textarea rows={3} value={value} onChange={event => onChange(event.target.value)} onKeyDown={keys} placeholder={placeholder} autoFocus={autoFocus} aria-label="Message to the agent"/>
    <div className="atelier-composer-bar">{children}<span className="atelier-head-spacer"/><small className="atelier-muted">Ctrl+Enter</small>
      <button className="button button-primary atelier-send" disabled={disabled || busy}><Icon name="arrow" size={13}/>{busy ? 'Starting…' : actionLabel}</button></div>
  </form>;
}

function Picker({ legend, children }: { legend: string; children: ReactNode }) {
  return <fieldset className="atelier-note-picker"><legend>{legend}</legend>{children}</fieldset>;
}

function NewThread({ projectId, data, initialFolder, initialTask, onStarted }: {
  projectId: number; data: Overview; initialFolder?: string; initialTask?: number | null; onStarted: (run: RunDetail) => void;
}) {
  // The Code button picks the code given to the agent: repositories it may change (each in a worktree),
  // other folders and scripts it reads. Nothing picked is a chat.
  const codeItems = data.folders.filter(folder => folder.available && folder.kind !== 'resources');
  const writable = (folder: Folder) => Boolean(folder.is_git && !folder.file);
  const resourceFolders = data.folders.filter(folder => folder.available && folder.kind === 'resources');
  const openTasks = data.tasks.filter(item => item.status !== 'done');
  const [engines, setEngines] = useState<Engine[]>([]);
  // Nothing linked is given by default; the project's own notes are (the most recent ones, up to the limit).
  const [codeIds, setCodeIds] = useState<string[]>([]);
  const [engine, setEngine] = useState<Engine['id'] | ''>('');
  const [model, setModel] = useState('');
  const [taskId, setTaskId] = useState<number | ''>(initialTask ?? '');
  const [noteIds, setNoteIds] = useState<number[]>(() => [...data.notes].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''))).slice(0, 6).map(note => note.id));
  const [resourceIds, setResourceIds] = useState<string[]>([]);
  const [picker, setPicker] = useState<'code' | 'resources' | 'notes' | null>(null);
  const picked = codeItems.filter(folder => codeIds.includes(folder.id));
  const repositories = picked.filter(writable);
  const readCode = picked.filter(folder => !writable(folder));
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<Engine[]>('/atelier/engines').then(list => {
      setEngines(list);
      setEngine(current => current || list.find(item => item.enabled && item.available)?.id || '');
    }).catch(reason => toast(reason.message, 'error'));
  }, []);
  useEffect(() => { if (initialTask) setTaskId(initialTask); }, [initialTask]);
  const task = data.tasks.find(item => item.id === taskId);
  const ready = engines.filter(item => item.enabled && item.available);
  const toggle = (setter: (update: (ids: any[]) => any[]) => void, id: any, limit: number) => (checked: boolean) =>
    setter(ids => checked ? (ids.length < limit ? [...ids, id] : ids) : ids.filter(item => item !== id));
  async function start() {
    setBusy(true);
    try {
      onStarted(await atelierApi<RunDetail>(projectId, '/runs', post({
        folder_id: repositories[0]?.id || null, extra_folder_ids: repositories.slice(1, 5).map(folder => folder.id),
        resource_folder_ids: [...resourceIds, ...readCode.map(folder => folder.id)], engine, model, task_id: taskId || null, note_ids: noteIds,
        prompt: prompt.trim() || (task ? `Do the task "${task.title}".` : ''),
      })));
    } catch (reason) { toast((reason as Error).message, 'error'); }
    finally { setBusy(false); }
  }
  const main = repositories[0];
  const count = (items: unknown[], word: string) => items.length ? `${items.length} ${word}${items.length > 1 ? 's' : ''}` : '';
  return <div className="atelier-thread">
    <div className="atelier-thread-scroll"><div className="atelier-thread-empty">
      <Icon name="agents" size={22}/>
      <h3>{main ? 'What should the agent build?' : 'Ask the agent'}</h3>
      <p>{main ? <>It works on a copy of <strong>{repositories.map(f => f.name).join(', ')}</strong>{readCode.length ? <> and reads <strong>{readCode.map(f => f.name).join(', ')}</strong></> : null}: you review its changes before anything reaches your folders.</>
        : <>A conversation about the project{picked.length || resourceIds.length ? ', with the chosen code and resources' : ''}. The agent reads; it changes no file. Pick code with the <strong>Code</strong> button to let it build.</>}</p>
      {!!openTasks.length && <div className="atelier-suggestions">{openTasks.slice(0, 4).map(item =>
        <button key={item.id} className={taskId === item.id ? 'active' : ''} onClick={() => setTaskId(taskId === item.id ? '' : item.id)}><Icon name="tasks" size={12}/>{item.title}</button>)}</div>}
      {!ready.length && <p className="atelier-warning">No agent is enabled. <button className="text-link" onClick={() => window.dispatchEvent(new Event('kavot:open-settings'))}>Enable Claude Code, Codex or OpenCode in Settings → AI and agents</button>.</p>}
    </div></div>
    {picker === 'code' && <Picker legend="Code given to the agent — a repository is changed in its own worktree; other folders and scripts are read">
      {codeItems.map(folder => <label key={folder.id} className="atelier-check"><input type="checkbox" checked={codeIds.includes(folder.id)} onChange={event => toggle(setCodeIds, folder.id, 8)(event.target.checked)}/>
        <Icon name={folder.file ? 'notes' : 'code'} size={12}/>{folder.name} <small className="atelier-muted">{writable(folder) ? `${folder.branch} · changes` : 'read only'}</small></label>)}
      {!codeItems.length && <span className="atelier-muted">No code yet: link a repository, a folder or a script from the sidebar (Code ＋).</span>}
    </Picker>}
    {picker === 'resources' && <Picker legend="Resources it may read (documents, data, scripts — never changed)">
      {resourceFolders.map(folder => <label key={folder.id} className="atelier-check"><input type="checkbox" checked={resourceIds.includes(folder.id)} onChange={event => toggle(setResourceIds, folder.id, 6)(event.target.checked)}/><Icon name={folder.file ? 'notes' : 'folder'} size={12}/>{folder.name}</label>)}
      {!resourceFolders.length && <span className="atelier-muted">No resource yet: link one from the sidebar (Resources ＋).</span>}
    </Picker>}
    {picker === 'notes' && <Picker legend="Notes given as context (up to 6)">
      {data.notes.map(note => <label key={note.id} className="atelier-check"><input type="checkbox" checked={noteIds.includes(note.id)} onChange={event => toggle(setNoteIds, note.id, 6)(event.target.checked)}/>{note.title}</label>)}
      {!data.notes.length && <span className="atelier-muted">This project has no note yet.</span>}
    </Picker>}
    <Composer value={prompt} onChange={setPrompt} onSend={() => void start()} busy={busy} autoFocus actionLabel={main ? 'Start' : 'Ask'}
      disabled={!engine || (!prompt.trim() && !task)}
      placeholder={task ? `Leave empty to do “${task.title}”, or add instructions…` : main ? 'Describe the change: “Add a CSV export to the reports page, with a test.”' : 'Ask about the project, its notes or its documents…'}>
      <button type="button" className={`atelier-chip ${picked.length ? 'active' : ''}`} aria-pressed={picker === 'code'} onClick={() => setPicker(value => value === 'code' ? null : 'code')} title="Choose the code given to the agent">
        <Icon name="code" size={12}/>{picked.length === 1 ? picked[0].name : picked.length ? `${picked.length} code items` : 'Code'}</button>
      <button type="button" className={`atelier-chip ${resourceIds.length ? 'active' : ''}`} aria-pressed={picker === 'resources'} onClick={() => setPicker(value => value === 'resources' ? null : 'resources')}><Icon name="folder" size={12}/>{count(resourceIds, 'resource') || 'Resources'}</button>
      <button type="button" className={`atelier-chip ${noteIds.length ? 'active' : ''}`} aria-pressed={picker === 'notes'} onClick={() => setPicker(value => value === 'notes' ? null : 'notes')}><Icon name="notes" size={12}/>{count(noteIds, 'note') || 'Notes'}</button>
      <select className="atelier-chip" aria-label="Task" value={taskId} onChange={event => setTaskId(event.target.value ? Number(event.target.value) : '')}>
        <option value="">No task</option>{openTasks.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select>
      <select className="atelier-chip" aria-label="Agent" value={engine} onChange={event => setEngine(event.target.value as Engine['id'])}>
        {!ready.length && <option value="">No agent</option>}
        {engines.map(item => <option key={item.id} value={item.id} disabled={!item.enabled || !item.available}>{item.name}{!item.available ? ' · not installed' : !item.enabled ? ' · disabled' : ''}</option>)}
      </select>
      <input className="atelier-chip atelier-chip-input" aria-label="Model" value={model} onChange={event => setModel(event.target.value)} placeholder={engines.find(item => item.id === engine)?.model || 'Default model'}/>
    </Composer>
  </div>;
}

/** What the agent works on: its code folders (each in its own worktree), the resources it reads, its task and notes. */
function ContextBar({ run, data, projectId, pane }: { run: RunDetail; data: Overview; projectId: number; pane: string }) {
  const spaces = run.workspaces || [];
  const task = data.tasks.find(item => item.id === run.task_id);
  const notes = data.notes.filter(note => run.note_ids?.includes(note.id));
  const showFolder = (folderId: string) => { setAtelierIntent(projectId, 'code', { folderId }); void openAtelierBeside(projectId, 'code', pane); };
  return <div className="atelier-context" aria-label="Context of this agent">
    <span className="atelier-context-label">{spaces.length ? 'Works in' : 'Chat'}</span>
    {spaces.map((space, index) => {
      const changed = space.files?.length || 0;
      const name = space.name || data.folders.find(folder => folder.id === space.folder_id)?.name || 'Folder';
      return <button key={space.folder_id} className={`atelier-context-folder ${space.open === false && !space.commit ? 'closed' : ''}`} onClick={() => showFolder(space.folder_id)}
        title={`${name} — open its code beside\nWorktree: ${space.worktree || 'closed'}\nBranch ${space.branch} from ${space.base_branch || space.base_sha.slice(0, 8)}`}>
        <Icon name="code" size={12}/><strong>{name}</strong>{index === 0 && spaces.length > 1 && <em>main</em>}
        <small>{space.base_branch || 'HEAD'}</small>{changed > 0 && <span className="atelier-context-count">{changed}</span>}
        {space.merged ? <span className="atelier-context-state">merged</span> : space.commit ? <span className="atelier-context-state">committed</span> : null}
      </button>;
    })}
    {(run.resources || []).map(item => <button key={item.folder_id} className="atelier-context-folder resource" onClick={() => showFolder(item.folder_id)} title={`${item.name} — read only\n${item.path}`}>
      <Icon name={(item as any).file ? 'notes' : 'folder'} size={12}/><strong>{item.name}</strong><small>read only</small></button>)}
    {!spaces.length && !run.resources?.length && <span className="atelier-muted">reads the project and its notes</span>}
    {task && <span className="atelier-context-chip" title="Task given to the agent"><Icon name="tasks" size={12}/>{task.title}</span>}
    {notes.map(note => <button key={note.id} className="atelier-context-chip" onClick={() => void openNoteBeside(note.id, pane)} title="Note given as context — open it beside"><Icon name="notes" size={12}/>{note.title}</button>)}
  </div>;
}

function RunMenu({ items }: { items: [string, () => void, boolean?][] }) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!menu.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  if (!items.length) return null;
  return <div className="atelier-run-menu" ref={menu}>
    <button className="icon-button" aria-label="More actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>⋯</button>
    {open && <div className="atelier-run-menu-list" role="menu">{items.map(([label, action, danger]) =>
      <button key={label} role="menuitem" className={danger ? 'danger' : ''} onClick={() => { setOpen(false); action(); }}>{label}</button>)}</div>}
  </div>;
}

function UsagePanel({ run }: { run: RunDetail }) {
  const usage: Usage = run.usage || {};
  const total = totalTokens(usage);
  const tiles: [string, string, string?][] = [
    ['Total', tokens(total), 'tokens'], ['Input', tokens(usage.input || 0)], ['Output', tokens(usage.output || 0)],
    ['Cache read', tokens(usage.cache_read || 0)], ['Cache write', tokens(usage.cache_write || 0)],
    ...(usage.reasoning ? [['Reasoning', tokens(usage.reasoning)] as [string, string]] : []),
    ['Cost', cost(usage.cost_usd) || '—'], ['Turns', String(usage.turns || 0)], ['Agent time', duration(usage.duration_ms || 0)],
  ];
  const history = run.usage_history || [];
  return <div className="atelier-usage">
    {run.status === 'running' && <p className="atelier-live"><i className="atelier-spinner"/>Counting while the agent works…</p>}
    <div className="atelier-usage-grid">{tiles.map(([label, value, unit]) => <div key={label}><span>{label}</span><strong>{value}</strong>{unit && <small>{unit}</small>}</div>)}</div>
    {total > 0 && <div className="atelier-usage-bar" aria-hidden="true">
      {(['input', 'output', 'cache_read', 'cache_write', 'reasoning'] as const).map(key => (usage[key] || 0) > 0 && <i key={key} className={key} style={{ flexGrow: usage[key] }} title={`${key.replace('_', ' ')}: ${usage[key]}`}/>)}
    </div>}
    <h4>Per message</h4>
    {history.length ? <table className="atelier-usage-table"><thead><tr><th>Message</th><th>In</th><th>Out</th><th>Cache</th><th>Cost</th><th>Time</th></tr></thead>
      <tbody>{history.map((row, index) => <tr key={index}><td title={row.prompt}>{row.prompt || `Message ${index + 1}`}</td><td>{tokens(row.input || 0)}</td><td>{tokens(row.output || 0)}</td>
        <td>{tokens((row.cache_read || 0) + (row.cache_write || 0))}</td><td>{cost(row.cost_usd) || '—'}</td><td>{duration(row.duration_ms || 0)}</td></tr>)}</tbody></table>
      : <p className="atelier-muted">Each message to the agent adds a line here when it finishes.</p>}
    <p className="atelier-muted">Counted from what {run.engine} reports. The cost is the engine's estimate; it stays empty when the engine gives none (a subscription, for example).</p>
  </div>;
}

function Thread({ projectId, runId, data, pane, onChanged }: { projectId: number; runId: string; data: Overview; pane: string; onChanged: () => void }) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [panel, setPanel] = useState<'changes' | 'usage' | null>(null);
  const [message, setMessage] = useState('');
  const [follow, setFollow] = useState('');
  const [merge, setMerge] = useState(true);
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  async function load() {
    const next = await atelierApi<RunDetail>(projectId, `/runs/${runId}`);
    setRun(previous => {
      if (previous?.status === 'running' && next.status !== 'running') { onChanged(); if (next.files.length) setPanel('changes'); }
      return next;
    });
  }
  useEffect(() => { setRun(null); setDiff(null); pinned.current = true; void load().catch(reason => toast(reason.message, 'error')); }, [projectId, runId]);
  useEffect(() => {
    if (run?.status !== 'running') return;
    const timer = window.setInterval(() => { void load().catch(() => undefined); tick(value => value + 1); }, 1000);
    return () => window.clearInterval(timer);
  }, [run?.status, runId]);
  useEffect(() => {
    if (!run || run.status === 'running' || !run.workspaces?.length) return;
    atelierApi<Diff>(projectId, `/runs/${run.id}/diff`).then(setDiff).catch(() => setDiff({ files: [], truncated: false }));
  }, [run?.status, run?.id, run?.commit]);
  useEffect(() => { if (run && !message) setMessage(run.title); }, [run?.id]);
  const items = useMemo(() => run ? timeline(run) : [], [run]);
  useEffect(() => {
    if (pinned.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [items.length, run?.draft, run?.status]);
  async function act(path: string, body?: unknown, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    try {
      const next = await atelierApi<RunDetail | null>(projectId, `/runs/${runId}${path}`, path ? post(body) : { method: 'DELETE' });
      if (next) { setRun(next); setDiff(null); pinned.current = true; }
      onChanged();
    } catch (reason) { toast((reason as Error).message, 'error'); }
    finally { setBusy(false); }
  }
  if (!run) return <p className="atelier-empty">Loading the conversation…</p>;
  const task = data.tasks.find(item => item.id === run.task_id);
  const code = (run.workspaces || []).length > 0;
  const open = code && ['review', 'failed', 'cancelled'].includes(run.status) && run.worktree_exists;
  const continuable = ['review', 'answered', 'failed', 'cancelled'].includes(run.status) && (!code || run.worktree_exists);
  const additions = run.files.reduce((sum, file) => sum + file.additions, 0), deletions = run.files.reduce((sum, file) => sum + file.deletions, 0);
  const lastUser = [...run.messages].reverse().find(item => item.role === 'user');
  const total = totalTokens(run.usage);
  const into = run.base_branch || 'the checkout';
  const menu: [string, () => void, boolean?][] = [
    ...(run.status === 'running' ? [['Stop the agent', () => void act('/cancel')] as [string, () => void]] : []),
    ...(open ? [['Discard the changes', () => void act('/discard', undefined, 'Discard this run? Its worktrees and its branch are deleted.'), true] as [string, () => void, boolean]] : []),
    ...(run.status === 'accepted' ? [['Delete the branch', () => void act('/discard', undefined, `Delete the branch ${run.branch} and its commit?`), true] as [string, () => void, boolean]] : []),
    ...(run.status !== 'running' && (!code || ['merged', 'discarded', 'accepted'].includes(run.status)) ? [['Remove from the list', () => void act('', undefined, 'Remove this conversation from the list?')] as [string, () => void]] : []),
  ];
  return <div className={`atelier-thread-layout ${panel ? 'with-changes' : ''}`}>
    <div className="atelier-thread">
      <header className="atelier-thread-head">
        <div><h3 title={run.title}>{run.title}</h3>
          <p className="atelier-muted"><span className={`atelier-status ${run.status}`}>{run.status === 'running' && <i className="atelier-spinner"/>}{STATUS_LABELS[run.status]}</span> {run.engine}{run.model ? ` · ${run.model}` : ''}{task ? ` · ${task.title}` : ''} · {relative(run.created_at)}</p></div>
        <button className={`atelier-pill ${panel === 'usage' ? 'active' : ''}`} onClick={() => setPanel(value => value === 'usage' ? null : 'usage')} aria-pressed={panel === 'usage'} title="Tokens and cost of this agent">
          <Icon name="sparkle" size={12}/>{total ? tokens(total) : '—'}{run.usage?.cost_usd ? ` · ${cost(run.usage.cost_usd)}` : ''}</button>
        {code && <button className={`atelier-pill ${panel === 'changes' ? 'active' : ''}`} onClick={() => setPanel(value => value === 'changes' ? null : 'changes')} aria-pressed={panel === 'changes'} title="Files changed by the agent">
          <Icon name="panel" size={12}/>{run.files.length ? <>{run.files.length} <span className="add">+{additions}</span> <span className="del">−{deletions}</span></> : 'No change'}</button>}
        <RunMenu items={menu}/>
      </header>
      <ContextBar run={run} data={data} projectId={projectId} pane={pane}/>
      <div className="atelier-thread-scroll" ref={scroller} onScroll={event => { const el = event.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>
        <div className="atelier-messages">
          {items.map((item, index) => item.kind === 'user' ? <div key={index} className="atelier-bubble user"><p>{item.text}</p><small>{relative(item.at)}</small></div>
            : item.kind === 'agent' ? <div key={index} className="atelier-bubble agent"><AgentMessageContent content={item.text}/></div>
            : item.kind === 'tool' ? <ToolLine key={index} label={item.label} detail={item.detail}/>
            : item.kind === 'error' ? <div key={index} className="atelier-warning"><strong>{item.label}</strong> {item.detail}</div>
            : <div key={index} className="atelier-system"><span>{(item as Activity).label}</span>{(item as Activity).detail && <code>{(item as Activity).detail}</code>}</div>)}
          {run.status === 'running' && run.draft && <div className="atelier-bubble agent streaming"><AgentMessageContent content={run.draft}/></div>}
          {run.status === 'running' && <div className="atelier-working"><i className="atelier-spinner"/>Working · {elapsed(lastUser?.at || run.created_at)}</div>}
          {run.error && run.status !== 'running' && !items.some(item => item.kind === 'error') && <div className="atelier-warning">{run.error}</div>}
        </div>
      </div>
      {open && run.files.length > 0 && panel !== 'changes' && <button className="atelier-changes-banner" onClick={() => setPanel('changes')}>
        <Icon name="check" size={13}/><strong>{run.files.length} file{run.files.length > 1 ? 's' : ''} changed</strong><span className="add">+{additions}</span><span className="del">−{deletions}</span>
        <span className="atelier-head-spacer"/>Review and commit<Icon name="arrow" size={12}/></button>}
      {run.status === 'accepted' && <div className="atelier-changes-banner static"><Icon name="check" size={13}/><span>Committed on <code>{run.branch}</code></span><span className="atelier-head-spacer"/>
        <button className="button button-small button-primary" disabled={busy} onClick={() => void act('/merge')}>Merge into {into}</button></div>}
      {run.status === 'running' ? <div className="atelier-composer stopped"><span className="atelier-muted"><i className="atelier-spinner"/> The agent is working{code ? <> in <code>{run.branch}</code></> : ''}…</span><span className="atelier-head-spacer"/><button className="button" disabled={busy} onClick={() => void act('/cancel')}>Stop</button></div>
        : continuable && <Composer value={follow} onChange={setFollow} busy={busy} disabled={!follow.trim()} placeholder={code ? 'Ask for changes: the agent continues in the same worktrees…' : 'Reply…'}
            onSend={() => { const text = follow; setFollow(''); void act('/messages', { prompt: text }); }}/>}
    </div>
    {panel === 'changes' && <aside className="atelier-changes" aria-label="Changes">
      <header><strong>Changes</strong><code className="atelier-muted">{run.branch}</code><span className="atelier-head-spacer"/><button className="icon-button" aria-label="Close the changes" onClick={() => setPanel(null)}><Icon name="close" size={12}/></button></header>
      {open && run.files.length > 0 && <form className="atelier-commit" onSubmit={event => { event.preventDefault(); void act('/accept', { message, merge }); }}>
        <input value={message} onChange={event => setMessage(event.target.value)} maxLength={2000} aria-label="Commit message" placeholder="Commit message"/>
        <div className="atelier-commit-row">
          <label className="atelier-check"><input type="checkbox" checked={merge} onChange={event => setMerge(event.target.checked)}/> then merge into <code>{into}</code></label>
          <span className="atelier-head-spacer"/>
          <button className="button button-primary button-small" disabled={busy || !message.trim()}>{merge ? 'Commit & merge' : 'Commit'}</button>
        </div>
      </form>}
      <div className="atelier-changes-body">{run.status === 'running' ? <p className="atelier-empty">The diff appears when the agent finishes.</p>
        : !diff ? <p className="atelier-empty">Loading the diff…</p>
        : (diff.folders?.length || 0) > 1 ? diff.folders!.map(item => <section key={item.folder_id} className="atelier-diff-folder">
            <h4><Icon name="code" size={13}/>{item.name}<small>{item.files.length ? `${item.files.length} file${item.files.length > 1 ? 's' : ''}` : 'no change'}</small></h4>
            {item.error ? <p className="atelier-warning">{item.error}</p> : <DiffView files={item.files} truncated={item.truncated} empty="No change in this folder."/>}
          </section>)
        : <DiffView files={diff.files} truncated={diff.truncated} empty="The agent did not change any file."/>}</div>
    </aside>}
    {panel === 'usage' && <aside className="atelier-changes" aria-label="Usage">
      <header><strong>Usage</strong><span className="atelier-muted">{run.engine}{run.model ? ` · ${run.model}` : ''}</span><span className="atelier-head-spacer"/><button className="icon-button" aria-label="Close the usage" onClick={() => setPanel(null)}><Icon name="close" size={12}/></button></header>
      <div className="atelier-changes-body"><UsagePanel run={run}/></div>
    </aside>}
  </div>;
}

export function AgentsPanel({ projectId, data, pane, selectedRun, onSelectRun, initialFolder, initialTask, onChanged }: {
  projectId: number; data: Overview; pane: string; selectedRun: string | null; onSelectRun: (id: string | null) => void;
  initialFolder?: string; initialTask?: number | null; onChanged: () => void;
}) {
  const active = data.runs.filter((run: Run) => ACTIVE.includes(run.status));
  const done = data.runs.filter((run: Run) => !ACTIVE.includes(run.status));
  const row = (run: Run) => <button key={run.id} className={`atelier-run-item ${selectedRun === run.id ? 'active' : ''}`} onClick={() => onSelectRun(run.id)} title={run.title}>
    <span className={`atelier-dot ${run.status}`}/><span className="atelier-run-copy"><strong>{run.title}</strong>
      <small>{STATUS_LABELS[run.status]} · {(run.workspaces || []).map(space => space.name).filter(Boolean).join(' + ') || run.engine}{totalTokens(run.usage) ? ` · ${tokens(totalTokens(run.usage))} tok` : ''} · {relative(run.updated_at)}</small></span>
  </button>;
  const selected = selectedRun && data.runs.some(run => run.id === selectedRun) ? selectedRun : null;
  return <div className="atelier-agents" data-pane={pane}>
    <nav className="atelier-run-list" aria-label="Conversations">
      <button className={`atelier-run-item new ${!selected ? 'active' : ''}`} onClick={() => onSelectRun(null)}><Icon name="plus" size={12}/> New agent</button>
      {!!active.length && <h4>In progress</h4>}{active.map(row)}
      {!!done.length && <h4>Done</h4>}{done.map(row)}
    </nav>
    <section className="atelier-run-panel">
      {selected ? <Thread key={selected} projectId={projectId} runId={selected} data={data} pane={pane} onChanged={onChanged}/>
        : <NewThread projectId={projectId} data={data} initialFolder={initialFolder} initialTask={initialTask} onStarted={run => { onChanged(); onSelectRun(run.id); }}/>}
    </section>
  </div>;
}
