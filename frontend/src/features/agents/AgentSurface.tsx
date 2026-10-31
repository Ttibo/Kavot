import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { toast } from '../../app/navigation';
import { useOptionalRuntime } from '../../app/runtime';
import type { ExternalEngine } from '../../components/ExternalAgentSettings';
import { Icon } from '../../components/Icon';
import { lockAgentEditors, prepareAgentContext, refreshAgentArtifacts } from '../externalAgents/sync';
import { cost, tokens } from '../atelier/types';
import { budgetAlert, budgetOf, budgetTitle } from './budget';
import { openAtelier } from '../projects/navigation';
import { agents, ENGINE_NAMES, STATUS_LABELS, statusOf, type Code, type Mode, type Run, type Session, type Summary } from './api';
import type { PickedItem } from '../externalAgents/picker';
import { Composer, type EngineChoice, type NewConversationDraft, type Outgoing } from './Composer';
import { ConversationList } from './ConversationList';
import { ChangesPanel, ContextBar, UsagePanel } from './Panels';
import { Thread } from './Thread';
import { onRunUpdate, rememberedSelection, rememberSelection, watchRun } from './runWatcher';
import '../../styles/components/agent-workspace.css';
import '../../styles/components/assistant-chat.css';
import '../../styles/features/atelier.css';
import '../../styles/features/agents.css';

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

/** Agent conversations, the same everywhere: the assistant panel, the Chat view and the Atelier.
 * `page` shows the list beside the conversation and the changes beside the thread; `panel` (narrow)
 * puts the list in a drawer and the changes over the thread. With `projectId`, it lists and starts
 * the conversations of that project. */
export function AgentSurface({ layout, projectId, scopeLabel, pane = 'primary', selected, onSelect, visible = true, onClose, onChanged, emptyHint, preset }: {
  layout: 'page' | 'panel'; projectId?: number | null; pane?: string; preset?: PickedItem[];
  /** The project the page is filtered on, named at the top of the list. */
  scopeLabel?: string;
  selected?: string | null; onSelect?: (id: string | null) => void;
  visible?: boolean; onClose?: () => void; onChanged?: () => void; emptyHint?: ReactNode;
}) {
  const runtime = useOptionalRuntime();
  const [engines, setEngines] = useState<EngineChoice[]>([]);
  const [engine, setEngine] = useState<ExternalEngine>('claude');
  // What the next conversation will start with: its model and its mode, chosen in the message bar.
  const [modelDraft, setModelDraft] = useState<NewConversationDraft>({ model: '', effort: '', mode: 'answer' });
  const [list, setList] = useState<Summary[]>([]);
  // The open conversation survives the view being rebuilt (a hidden tab, a redrawn pane).
  const selectionKey = `${layout}:${projectId || 'all'}:${pane}`;
  const [ownSelection, setOwnSelection] = useState<string | null>(() => rememberedSelection(selectionKey));
  const selectedId = selected !== undefined ? selected : ownSelection;
  const [session, setSession] = useState<Session | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [side, setSide] = useState<'changes' | 'usage' | null>(null);
  // The budget alert dismissed for one request of one conversation; a later request can raise it again.
  const [dismissed, setDismissed] = useState('');
  const [listOpen, setListOpen] = useState(false);
  // A page too narrow for the list beside the thread (an editor pane) takes the compact layout of the panel.
  const host = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (layout !== 'page' || !host.current) return;
    // A margin around the threshold: a scrollbar appearing must not flip the layout back and forth.
    const observer = new ResizeObserver(([entry]) => setNarrow(current => current ? entry.contentRect.width < 840 : entry.contentRect.width < 780));
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [layout]);
  // The list of conversations can be folded away on a wide page too; the choice is remembered.
  const [listHidden, setListHidden] = useState(() => { try { return localStorage.getItem('kavot-agents-list-hidden') === 'true'; } catch { return false; } });
  const toggleList = () => setListHidden(hidden => { try { localStorage.setItem('kavot-agents-list-hidden', String(!hidden)); } catch { /* Kept for this session. */ } return !hidden; });
  const compact = layout === 'panel' || narrow || listHidden;
  const [busy, setBusy] = useState(false);
  const running = run?.status === 'running';

  const select = useCallback((id: string | null) => {
    if (selected === undefined) { setOwnSelection(id); rememberSelection(selectionKey, id); }
    onSelect?.(id);
    setListOpen(false);
  }, [selected, onSelect, selectionKey]);

  useEffect(() => {
    const load = () => { void agents.settings().then(value => {
      const enabled = (value.engines || []).filter(item => item.enabled).map(item => ({ id: item.id, name: item.name, model: item.model, effort: item.effort }));
      setEngines(enabled);
      setEngine(current => {
        const next = enabled.some(item => item.id === current) ? current : enabled[0]?.id || current;
        if (next !== current) {
          const picked = enabled.find(item => item.id === next);
          if (picked) setModelDraft(draft => draft.model ? draft : { ...draft, model: picked.model, effort: picked.effort });
        }
        return next;
      });
    }).catch(() => setEngines([])); };
    load(); window.addEventListener('kavot:external-agent-settings-updated', load);
    return () => window.removeEventListener('kavot:external-agent-settings-updated', load);
  }, []);

  const loadList = useCallback(async () => {
    try { setList(await agents.list(projectId)); } catch { /* The list keeps its last state. */ }
  }, [projectId]);
  useEffect(() => { void loadList(); }, [loadList]);
  // Other conversations finish too: refresh the list while one of them runs.
  const anyRunning = list.some(item => item.active_run_id);
  useEffect(() => {
    if (!anyRunning || !visible) return;
    const timer = window.setInterval(() => void loadList(), 4000);
    return () => window.clearInterval(timer);
  }, [anyRunning, visible, loadList]);

  // The conversation open now: a slower load of one left meanwhile does not replace it.
  const openId = useRef(selectedId);
  openId.current = selectedId;
  const loadSession = useCallback(async (id: string) => {
    const next = await agents.get(id);
    const current = next.active_run_id ? await agents.run(next.active_run_id) : next.last_run || null;
    if (openId.current !== id) return next;
    setSession(next);
    setRun(current);
    watchRun(current);
    return next;
  }, []);
  useEffect(() => {
    setSide(null);
    if (!selectedId) { setSession(null); setRun(null); return; }
    if (session?.id === selectedId) return;
    void loadSession(selectedId).catch(reason => { toast((reason as Error).message, 'error'); select(null); });
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The panel starts blank each time it is reopened, unless an agent is at work.
  const wasVisible = useRef(visible);
  useEffect(() => {
    const reopened = visible && wasVisible.current === false;
    wasVisible.current = visible;
    if (reopened && layout === 'panel' && !running && !busy) select(null);
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  // The run itself (editor locking in /auto, reloading what it changed) is followed by runWatcher;
  // this view only renders the ticks it broadcasts, so a hidden tab polls no less than a visible one.
  // Coming back to the view (another tab, another window), the open conversation is read again:
  // whatever happened while it was hidden shows without reopening it.
  useEffect(() => {
    const refresh = () => {
      if (document.hidden || !visible || busy || !openId.current) return;
      void loadSession(openId.current).catch(() => undefined);
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    let shown = true;
    const observer = host.current ? new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !shown) refresh();
      shown = entry.isIntersecting;
    }) : null;
    if (host.current) observer?.observe(host.current);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); observer?.disconnect(); };
  }, [visible, busy, loadSession]);

  useEffect(() => {
    if (!run || run.status !== 'running') return;
    const runId = run.id;
    // A run shown as running is always followed, even if its watcher ended or never started here.
    watchRun(run);
    const unsubscribe = onRunUpdate(next => {
      if (next.id !== runId) return;
      setRun(next);
      if (next.status === 'running') return;
      // The run ended: reload the conversation once, with its full transcript.
      void loadSession(next.session_id).then(loaded => {
        // Not saved on the conversation yet: keep showing the finished run rather than the one before it.
        if (openId.current === loaded.id && !loaded.messages.some(message => message.run_id === next.id)) setRun(next);
        void loadList(); onChanged?.();
      });
      void agents.get(next.session_id).then(session => { if (session.code?.status === 'review') setSide(current => current || (layout === 'page' ? 'changes' : current)); });
    });
    return unsubscribe;
  }, [run?.id, run?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function send(message: Outgoing): Promise<boolean> {
    setBusy(true);
    let created: Session | null = null;
    try {
      await prepareAgentContext();
      let current = session;
      if (!current) {
        current = created = await agents.create(message.engine, projectId);
        setSession(current);
        select(current.id);
      }
      const started = await agents.send(current.id, { text: message.text, context: message.context, model: message.model, effort: message.effort, mode: message.mode });
      setRun(started);
      watchRun(started);
      setSession(previous => previous && ({ ...previous, title: previous.messages.length ? previous.title : message.text.slice(0, 64), active_run_id: started.id,
        model: message.model, effort: message.effort,
        messages: [...previous.messages, { role: 'user', content: message.text, context: started.scope, at: new Date().toISOString(), mode: message.mode }] }));
      void loadList();
      // The code given with this message is now part of the conversation.
      if (message.context.code_folder_ids?.length || message.context.resource_folder_ids?.length) {
        void agents.get(current.id).then(next => setSession(previous => previous && previous.id === next.id ? { ...previous, code: next.code, project_id: next.project_id } : previous));
        onChanged?.();
      }
      return true;
    } catch (reason) {
      lockAgentEditors(false);
      toast((reason as Error).message, 'error');
      // A conversation created for a message that could not start stays out of the list.
      if (created) { await agents.remove(created.id).catch(() => undefined); select(null); void loadList(); }
      return false;
    } finally { setBusy(false); }
  }

  async function decide(runId: string, proposalId: string, decision: 'apply' | 'dismiss') {
    if (!session) return;
    setBusy(true);
    try {
      if (decision === 'apply') { await prepareAgentContext(); lockAgentEditors(true); }
      await agents.decide(runId, proposalId, decision);
      await loadSession(session.id);
      if (decision === 'apply') await refreshAgentArtifacts();
    } catch (reason) { toast((reason as Error).message, 'error'); }
    finally { lockAgentEditors(false); setBusy(false); }
  }

  /** Several proposals of one answer, applied in order: each one on the note as the previous left it. */
  async function applyAll(runId: string, proposalIds: string[]) {
    if (!session) return;
    setBusy(true);
    try {
      await prepareAgentContext(); lockAgentEditors(true);
      for (const id of proposalIds) await agents.decide(runId, id, 'apply');
    } catch (reason) { toast((reason as Error).message, 'error'); }
    finally {
      await loadSession(session.id).catch(() => undefined);
      await refreshAgentArtifacts().catch(() => undefined);
      lockAgentEditors(false); setBusy(false);
    }
  }

  async function stop() {
    if (!run) return;
    try { setRun(await agents.cancel(run.id)); lockAgentEditors(false); }
    catch (reason) { toast((reason as Error).message, 'error'); }
  }

  async function remove() {
    if (!session || !window.confirm(`Remove “${session.title}” from the list?`)) return;
    try { await agents.remove(session.id); select(null); void loadList(); onChanged?.(); }
    catch (reason) { toast((reason as Error).message, 'error'); }
  }

  async function rename() {
    if (!session) return;
    const title = window.prompt('Name of the conversation', session.title)?.trim();
    if (!title || title === session.title) return;
    try { setSession(await agents.rename(session.id, title)); void loadList(); }
    catch (reason) { toast((reason as Error).message, 'error'); }
  }

  const codeChanged = (code: Code | null) => {
    setSession(previous => previous && ({ ...previous, code }));
    void loadList(); onChanged?.();
  };
  const reveal = () => { if (layout === 'panel' && window.matchMedia('(max-width: 820px)').matches) onClose?.(); };

  const status = session ? statusOf({ ...session, active_run_id: running ? run!.id : null }) : 'new';
  const code = session?.code;
  const files = code?.workspaces.flatMap(space => space.files || []) || [];
  const additions = files.reduce((sum, file) => sum + file.additions, 0), deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const usage = session?.usage;
  const budget = budgetOf(session, run);
  const alert = budgetAlert(budget);
  const alertKey = `${session?.id}:${budget.runId}:${budget.level}`;
  const projectName = (id?: number) => id ? runtime?.state.projects.find((project: Project) => project.id === id)?.name : undefined;
  const sessionProject = session?.project_id;
  const name = session ? ENGINE_NAMES[session.engine] : engines.find(item => item.id === engine)?.name || 'The agent';
  const menu: [string, () => void, boolean?][] = session ? [
    ['Rename', () => void rename()],
    ...(sessionProject && !projectId ? [['Open in the Atelier', () => void openAtelier(sessionProject, 'agents')] as [string, () => void]] : []),
    ...(!running ? [['Remove from the list', () => void remove(), true] as [string, () => void, boolean]] : []),
  ] : [];

  const empty = <div className="atelier-thread-empty">
    <Icon name="agents" size={22}/>
    <h3>{projectId ? 'Ask the agent, or have it build' : 'A question, an idea, a change?'}</h3>
    <p>{emptyHint || <>The agent reads your workspace through Kavot's tools: notes, articles, collections, tasks, canvas.
      In <strong>/edit</strong> it prepares changes you approve; give it a project's <strong>code</strong> (＋ or @) and it changes it in a worktree you review before any commit.</>}</p>
    {!engines.length && <p className="atelier-warning">No agent is enabled. <button className="text-link" onClick={() => window.dispatchEvent(new Event('kavot:open-settings'))}>Enable Claude Code, Codex or OpenCode in Settings → AI and agents</button>.</p>}
  </div>;

  // Another agent starts from its own default model.
  const changeEngine = (next: ExternalEngine) => {
    setEngine(next);
    const picked = engines.find(item => item.id === next);
    setModelDraft(draft => ({ ...draft, model: picked?.model || '', effort: picked?.effort || '' }));
  };
  // The conversations open on the left, so their button sits on the left of the header.
  const listTool = compact && <span className="agent-list-tool">
    {layout === 'page' && !narrow
      ? <button type="button" className="agent-tool" aria-label="Show the conversations" title="Show the conversations" onClick={toggleList}><Icon name="sidebar" size={15}/></button>
      : <button type="button" className="agent-tool" aria-label="Conversations" title="Conversations" aria-expanded={listOpen} onClick={() => setListOpen(value => !value)}><Icon name="sidebar" size={15}/></button>}
  </span>;
  const compactTools = <>
    {!!session && <button type="button" className="agent-tool" aria-label="New conversation" title="New conversation" disabled={busy} onClick={() => select(null)}><Icon name="plus" size={16}/></button>}
    {onClose && <button type="button" className="agent-tool" aria-label="Close the assistant" title="Close the assistant" onClick={onClose}><Icon name="close" size={15}/></button>}
  </>;
  const thread = <div className={`atelier-thread-layout ${side && !compact ? 'with-changes' : ''}`}>
    <div className="atelier-thread">
      {/* No conversation yet: a slim header; the agent, model and mode are chosen in the message bar. */}
      {!session && <header className="atelier-thread-head agent-new-head">
        {listTool}
        <h3 title="New conversation"><Icon name="sparkle" size={14}/><span>New conversation</span></h3>
        {compact && onClose && <span className="agent-head-tools">{compactTools}</span>}
      </header>}
      {session && <header className="atelier-thread-head">
        {listTool}
        <div><h3 title={session.title}>{session.title}</h3>
          <p className="atelier-muted" title={`${STATUS_LABELS[status]} · ${ENGINE_NAMES[session.engine]}${session.model ? ` · ${session.model}` : ''}${sessionProject && !projectId ? ` · ${projectName(sessionProject) || 'Project'}` : ''}`}>
            <span className={`atelier-status ${status}`}>{running && <i className="atelier-spinner"/>}{STATUS_LABELS[status]}</span>
            <span className="atelier-head-sep" aria-hidden="true"/><span className="agent-head-meta">{ENGINE_NAMES[session.engine]}{session.model ? ` · ${session.model}` : ''}{sessionProject && !projectId ? ` · ${projectName(sessionProject) || 'Project'}` : ''}</span></p></div>
        <button className={`atelier-pill agent-budget ${budget.level} ${side === 'usage' ? 'active' : ''}`} style={{ '--budget-hue': budget.hue } as CSSProperties}
          onClick={() => setSide(value => value === 'usage' ? null : 'usage')} aria-pressed={side === 'usage'} title={budgetTitle(budget)}>
          <i className="agent-budget-dot" aria-hidden="true"/>{budget.total ? tokens(budget.total) : '—'}
          {budget.last > 0 && <small>last {tokens(budget.last)}</small>}{usage?.cost_usd ? <small className="agent-budget-cost">· {cost(usage.cost_usd)}</small> : null}</button>
        {!!code?.workspaces.length && <button className={`atelier-pill ${side === 'changes' ? 'active' : ''}`} onClick={() => setSide(value => value === 'changes' ? null : 'changes')} aria-pressed={side === 'changes'} title="Files changed by the agent">
          <Icon name="panel" size={12}/>{files.length ? <>{files.length}<span className="add">+{additions}</span><span className="del">−{deletions}</span></> : <span className="agent-label">No change</span>}</button>}
        <RunMenu items={menu}/>
        {compact && <span className="agent-head-tools">{compactTools}</span>}
      </header>}
      {session && <ContextBar session={session} pane={pane}/>}
      <Thread session={session} run={run} name={name} busy={busy} empty={empty} onDecide={(runId, proposalId, decision) => void decide(runId, proposalId, decision)} onApplyAll={(runId, ids) => void applyAll(runId, ids)} onNavigate={reveal}/>
      {session && alert && dismissed !== alertKey && <div className={`agent-budget-alert ${budget.level}`} role="alert" style={{ '--budget-hue': budget.hue } as CSSProperties}>
        <Icon name="sparkle" size={13}/><span>{alert}</span>
        <button type="button" disabled={running} onClick={() => select(null)}>New conversation</button>
        <button type="button" className="icon-button" aria-label="Hide this alert" onClick={() => setDismissed(alertKey)}><Icon name="close" size={11}/></button>
      </div>}
      {code?.status === 'review' && files.length > 0 && side !== 'changes' && <button className="atelier-changes-banner" onClick={() => setSide('changes')}>
        <Icon name="check" size={13}/><strong>{files.length} file{files.length > 1 ? 's' : ''} changed</strong><span className="add">+{additions}</span><span className="del">−{deletions}</span>
        <span className="atelier-head-spacer"/>Review and commit<Icon name="arrow" size={12}/></button>}
      {code?.status === 'accepted' && side !== 'changes' && <button className="atelier-changes-banner" onClick={() => setSide('changes')}>
        <Icon name="check" size={13}/><span>Committed on <code>{code.workspaces[0]?.branch}</code></span><span className="atelier-head-spacer"/>Merge<Icon name="arrow" size={12}/></button>}
      <Composer session={session} engines={engines} engine={session?.engine || engine} onEngineChange={changeEngine} projectId={projectId || sessionProject}
        running={running} busy={busy} onSend={send} onStop={() => void stop()} autoFocus={layout === 'page'} preset={preset}
        draft={modelDraft} onDraftChange={setModelDraft}/>
    </div>
    {session && side === 'changes' && code && <ChangesPanel session={session} onChanged={codeChanged} onClose={() => setSide(null)}/>}
    {session && side === 'usage' && <UsagePanel session={session} run={run} onClose={() => setSide(null)}/>}
  </div>;

  const conversations = (withNew: boolean) => <ConversationList items={list} selected={selectedId} engines={engines.map(item => item.id)} showProject={!projectId}
    onSelect={id => select(id)} onNew={withNew ? () => select(null) : undefined}/>;
  const surface = compact ? <div className={`agent-surface panel ${layout === 'page' ? 'in-page' : ''} ${side ? 'with-side' : ''}`}>
    {listOpen && <div className="agent-surface-drawer">{conversations(true)}</div>}
    {thread}
  </div> : <div className="atelier-agents agent-surface page">
    <div className="agent-list-column">
      {/* One line: fold the list, what it lists, and a new conversation. */}
      <div className="agent-list-head">
        <button type="button" className="agent-tool" aria-label="Hide the conversations" title="Hide the conversations" onClick={toggleList}><Icon name="sidebar" size={15}/></button>
        <span className="agent-list-title" title={scopeLabel ? `Conversations · ${scopeLabel}` : 'Conversations of every project'}>Conversations{scopeLabel && <small>{scopeLabel}</small>}</span>
        <button type="button" className={`agent-tool ${!selectedId ? 'active' : ''}`} aria-label="New conversation" title="New conversation" disabled={busy} onClick={() => select(null)}><Icon name="plus" size={16}/></button>
      </div>
      {conversations(false)}
    </div>
    {thread}
  </div>;
  return layout === 'page' ? <div className="agent-surface-host" ref={host}>{surface}</div> : surface;
}
