import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useOptionalRuntime } from '../app/runtime';
import { api } from '../services/api';
import { captureAgentContext, suggestions } from '../features/externalAgents/context';
import { AgentMessageContent } from './AgentMessageContent';
import { ExternalModelPicker } from './ExternalModelPicker';
import { AssistantToolbar } from './AssistantToolbar';
import { Icon } from './Icon';
import { ContextPicker } from './ContextPicker';
import { KIND_ICONS, KIND_LABELS, loadPicked, pickedContext, pickerOptions, savePicked, type PickedItem } from '../features/externalAgents/picker';
import { lockAgentEditors, prepareAgentContext, refreshAgentArtifacts } from '../features/externalAgents/sync';
import type { ExternalEngine } from './ExternalAgentSettings';

type Message = { role: 'user' | 'assistant'; content: string; context?: any };
type Resource = { id: string; title: string; path: string; kind: string; note_id?: number; paper_id?: number };
type Activity = { id: number; kind: string; label: string; detail: string; at: string };
type Session = { id: string; engine: ExternalEngine; title: string; messages: Message[]; model: string; effort: string; active_run_id: string | null; last_run?: Run };
type Proposal = { proposal_id: string; kind?: string; label: string; target: string; diff: string; status: string; after?: string | { content?: string; title?: string }; result?: { id?: number; kind?: string }; action?: { kind?: string; id?: number; values?: { url?: string; doi?: string; content?: string } } };
type Run = { id: string; session_id: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; response: string | null; error: string | null; events: Activity[]; resources: Resource[]; model: string; effort: string; scope?: any; modified_files?: string[]; proposals?: Proposal[]; proposal_errors?: string[]; mode?: AgentMode };
type AgentMode = 'answer' | 'propose' | 'auto';

export function ExternalAgentWorkspace({ engine, name, defaultModel, defaultEffort, onBusyChange, onEngineChange, onClose, sessionId, fresh, visible, onSessionChange }: {
  engine: ExternalEngine; name: string; project?: Project; defaultModel: string; defaultEffort: string; onBusyChange: (busy: boolean) => void;
  onEngineChange: (engine: ExternalEngine) => void; onClose?: () => void;
  /** Conversation to open first; with `fresh`, none opens until the first message. */
  sessionId?: string; fresh?: boolean; onSessionChange?: (id: string) => void;
  /** With `fresh`, reopening a hidden panel starts a new conversation again. */
  visible?: boolean;
}) {
  const runtime = useOptionalRuntime();
  const state = runtime?.state;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [resources, setResources] = useState<Resource[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [excludedFiles, setExcludedFiles] = useState<string[]>([]);
  const [multipleNotes, setMultipleNotes] = useState(false);
  const [mode, setMode] = useState<AgentMode>('answer');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  // What the user picked for this conversation; it stays until removed.
  const [picked, setPicked] = useState<PickedItem[]>(() => loadPicked(sessionId || ''));
  const [picker, setPicker] = useState<'button' | 'mention' | null>(null);
  const [mentionQuery, setMentionQuery] = useState('');
  const composer = useRef<HTMLTextAreaElement>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const followConversation = useRef(true);
  const displayedSession = useRef<string | undefined>(undefined);
  const [fileSearch, setFileSearch] = useState('');
  const [showFiles, setShowFiles] = useState(false);
  const [preview, setPreview] = useState<{ resources: Resource[]; target: Resource | null; note_intent?: string; code_repository?: { name?: string; branch?: string; unavailable?: string; files?: { path: string; truncated: boolean }[] } } | null>(null);
  const [contextError, setContextError] = useState('');
  const [contextLoading, setContextLoading] = useState(true);
  const [, setActiveSignature] = useState('');
  const [targetNoteId, setTargetNoteId] = useState('');
  const [model, setModel] = useState(defaultModel || '');
  const [effort, setEffort] = useState(defaultEffort || '');
  const [draft, setDraft] = useState('');
  const [importId, setImportId] = useState('');
  const [run, setRun] = useState<Run | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const busy = working || run?.status === 'running';

  useEffect(() => {
    const suggest = (event: Event) => {
      if (busy) return;
      const text = (event as CustomEvent).detail.text;
      setDraft(text); setMode(/rédig|enrich|reformul|modifi|cré[ée]/i.test(text) ? 'propose' : 'answer');
      setActiveSignature(JSON.stringify(activeDetails()));
      composer.current?.focus();
    };
    window.addEventListener('kavot:assistant-suggestion', suggest);
    return () => window.removeEventListener('kavot:assistant-suggestion', suggest);
  }, [busy]);

  const activeDetails = () => {
    const scope = captureAgentContext(runtime);
    return { ...scope, noteId: scope.note_id, paperId: scope.paper_id, resourcePath: scope.resource_path, canvasPath: scope.canvas_path };
  };

  const contextSignature = JSON.stringify(activeDetails());
  const makeContext = (scope: any) => {
    const extra = pickedContext(picked, state, resources);
    const noteId = scope.note_id || extra.note_id;
    const general = ['chat', 'dashboard', 'projects'].includes(scope.area);
    return { ...scope,
      ...(extra.project_id ? { project_id: extra.project_id, project_name: extra.project_name } : {}),
      ...(extra.collection_id ? { collection_id: extra.collection_id, picked_collection: true } : {}),
      area: extra.project_id && general ? 'project' : scope.area, note_id: noteId,
      view_label: extra.focus.length && general ? extra.focus.map(item => String(item.title)).join(', ') : scope.view_label,
      paper_ids: extra.paper_ids, focus: extra.focus,
      target_note_id: targetNoteId === '__new__' ? null : targetNoteId || (noteId ? String(noteId) : null),
      target_choice: !!targetNoteId && targetNoteId !== '__new__',
      note_intent: targetNoteId === '__new__' ? 'create' : null,
      allow_multiple_notes: multipleNotes || extra.resource_ids.filter(id => id.startsWith('note:')).length > 1,
      resource_ids: [...new Set([...selectedFiles, ...extra.resource_ids])], excluded_resource_ids: excludedFiles,
    };
  };

  const reload = useCallback(async (preferred?: string) => {
    const list = await api<Session[]>(`/external-agents/sessions?engine=${engine}`);
    setSessions(list);
    const chosen = preferred || selectedId || sessionId || (fresh ? '' : list[0]?.id) || '';
    if (!chosen || !list.some(item => item.id === chosen)) { setSelectedId(''); setSession(null); setRun(null); return; }
    setSelectedId(chosen);
    const detail = await api<Session>(`/external-agents/sessions/${chosen}`);
    setSession(detail); setModel(detail.model ?? defaultModel ?? ''); setEffort(detail.effort ?? defaultEffort ?? '');
    if (detail.active_run_id) setRun(await api<Run>(`/external-agents/runs/${detail.active_run_id}`));
    else setRun(detail.last_run || null);
  }, [engine, selectedId, defaultModel, defaultEffort]);

  const reloadResources = useCallback(() => api<Resource[]>('/external-agents/resources').then(setResources), []);
  useEffect(() => { void reload().catch(reason => setError(reason.message)); void reloadResources().catch(reason => setError(reason.message)); }, [engine]);
  useEffect(() => {
    const update = () => { setSelectedFiles([]); setExcludedFiles([]); setTargetNoteId(''); setPreview(null); void reload().catch(reason => setError(reason.message)); void reloadResources().catch(reason => setError(reason.message)); };
    window.addEventListener('kavot:storage-updated', update);
    return () => window.removeEventListener('kavot:storage-updated', update);
  }, [reload, reloadResources]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const active = activeDetails();
      setActiveSignature(JSON.stringify(active));
    }, 700);
    return () => window.clearInterval(timer);
  }, [state]);
  useEffect(() => {
    const controller = new AbortController();
    setContextLoading(true);
    const timer = window.setTimeout(() => {
      const scope = JSON.parse(contextSignature);
      void api<{ resources: Resource[]; target: Resource | null; note_intent?: string }>('/external-agents/context', { method: 'POST', signal: controller.signal,
        body: JSON.stringify({ text: draft || 'Contexte', context: makeContext(scope) }) })
        .then(result => { if (!controller.signal.aborted) { setPreview(Array.isArray(result.resources) ? result : null); setContextError(''); } })
        .catch(reason => { if (!controller.signal.aborted) setContextError(reason.message); })
        .finally(() => { if (!controller.signal.aborted) setContextLoading(false); });
    }, 400);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [contextSignature, targetNoteId, selectedFiles, excludedFiles, draft, multipleNotes, picked]);
  // A running agent keeps its conversation open; otherwise each reopening starts blank.
  const wasVisible = useRef(visible);
  useEffect(() => {
    const reopened = visible && wasVisible.current === false;
    wasVisible.current = visible;
    if (!reopened || !fresh || busy) return;
    setSelectedId(''); setSession(null); setRun(null); setError('');
    setHistoryOpen(false); setContextOpen(false); setTargetNoteId(''); setSelectedFiles([]); setExcludedFiles([]); setMultipleNotes(false); setPicked([]);
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (selectedId) setPicked(loadPicked(selectedId)); }, [selectedId]);
  useEffect(() => { savePicked(selectedId, picked); }, [picked]); // eslint-disable-line react-hooks/exhaustive-deps
  const options = useMemo(() => picker ? pickerOptions(state, resources) : [], [picker, resources]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onBusyChange(!!busy); }, [busy, onBusyChange]);
  // Lets a conversation list follow the open session, its new messages and its runs.
  useEffect(() => { onSessionChange?.(selectedId); }, [selectedId, session?.messages.length, run?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const closeMenus = (event: PointerEvent) => {
      composer.current?.form?.querySelectorAll<HTMLDetailsElement>('.assistant-model-options[open], .assistant-ideas[open]').forEach(menu => {
        if (!menu.contains(event.target as Node)) menu.open = false;
      });
    };
    document.addEventListener('pointerdown', closeMenus);
    return () => document.removeEventListener('pointerdown', closeMenus);
  }, []);
  useLayoutEffect(() => {
    const body = conversation.current;
    if (displayedSession.current !== session?.id) {
      displayedSession.current = session?.id;
      followConversation.current = true;
    }
    if (body && followConversation.current) body.scrollTop = body.scrollHeight;
  }, [session?.id, session?.messages.length, run?.status]);
  useEffect(() => () => { onBusyChange(false); lockAgentEditors(false); }, [onBusyChange]);
  // In /auto the agent writes while it runs: keep editors read-only until it finishes.
  useEffect(() => { lockAgentEditors(run?.status === 'running' && run.mode === 'auto'); }, [run?.status, run?.mode]);
  useEffect(() => {
    if (!run || run.status !== 'running') return;
    let active = true;
    const poll = async () => {
      try {
        const next = await api<Run>(`/external-agents/runs/${run.id}`);
        if (!active) return;
        setRun(next);
        if (next.status !== 'running') {
          lockAgentEditors(false);
          await reload(next.session_id);
          setRun(next);
          // Some applied changes (e.g. outside the scanned folders) leave modified_files empty.
          if (next.modified_files?.length || next.proposals?.some(item => item.status === 'applied')) {
            await refreshAgentArtifacts(); await reloadResources();
          }
          if (next.error) setError(next.error);
        }
      } catch (reason) { if (active) setError((reason as Error).message); }
    };
    const timer = window.setInterval(() => void poll(), document.hidden ? 2500 : 900);
    return () => { active = false; window.clearInterval(timer); };
  }, [run?.id, run?.status]);

  async function create(vendorSessionId?: string) {
    setError(''); setWorking(true);
    try {
      const next = await api<Session>('/external-agents/sessions', { method: 'POST', body: JSON.stringify({ engine, vendor_session_id: vendorSessionId || null }) });
      setDraft(''); setImportId(''); setRun(null);
      await reload(next.id);
      setHistoryOpen(false); setContextOpen(false); setTargetNoteId(''); setSelectedFiles([]); setExcludedFiles([]); setMultipleNotes(false); setMode('answer'); setPicked([]);
      composer.current?.focus();
    } catch (reason) { setError((reason as Error).message); }
    finally { setWorking(false); }
  }

  async function select(id: string) {
    setError(''); setRun(null); setSelectedId(id);
    try {
      const detail = await api<Session>(`/external-agents/sessions/${id}`);
      setSession(detail); setModel(detail.model ?? defaultModel ?? ''); setEffort(detail.effort ?? defaultEffort ?? '');
      if (detail.active_run_id) setRun(await api<Run>(`/external-agents/runs/${detail.active_run_id}`));
      else setRun(detail.last_run || null);
      setHistoryOpen(false); setDraft('');
    } catch (reason) { setError((reason as Error).message); }
  }

  async function attach(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    for (const file of files) {
      try {
        const body = new FormData(); body.append('file', file);
        const result = await api<Resource>('/external-agents/attachments', { method: 'POST', body });
        setResources(previous => [...previous, result]);
        setSelectedFiles(previous => [...previous, result.id]);
      } catch (reason) { setError((reason as Error).message); }
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim() || busy) return;
    setWorking(true); setError('');
    try {
      await prepareAgentContext();
      const context = makeContext(activeDetails());
      const text = draft.trim();
      const resolved = await api<{ resources: Resource[]; target: Resource | null; note_intent?: string }>('/external-agents/context', {
        method: 'POST', body: JSON.stringify({ text, context }),
      });
      setPreview(Array.isArray(resolved.resources) ? resolved : null); setContextError('');
      let current = session;
      if (!current) {
        current = await api<Session>('/external-agents/sessions', { method: 'POST', body: JSON.stringify({ engine }) });
        savePicked(current.id, picked);
        setSession(current); setSelectedId(current.id); setSessions(previous => [current!, ...previous]);
      }
      const started = await api<Run>(`/external-agents/sessions/${current.id}/messages`, {
        method: 'POST', body: JSON.stringify({ text, context, model, effort, mode }),
      });
      followConversation.current = true;
      setRun(started); setDraft(''); setContextOpen(false); setHistoryOpen(false);
      setSession(previous => previous && ({ ...previous, title: previous.messages.length ? previous.title : text,
        active_run_id: started.id, model, effort, messages: [...previous.messages, { role: 'user', content: text, context: started.scope || context }] }));
    } catch (reason) { lockAgentEditors(false); setError((reason as Error).message); }
    finally { setWorking(false); }
  }

  async function decide(proposalId: string, decision: 'apply' | 'dismiss') {
    if (!run) return;
    setWorking(true); setError('');
    try {
      if (decision === 'apply') { await prepareAgentContext(); lockAgentEditors(true); }
      const next = await api<Run>(`/external-agents/runs/${run.id}/proposals/${proposalId}`, { method: 'POST', body: JSON.stringify({ decision }) });
      setRun(next);
      if (decision === 'apply') {
        await refreshAgentArtifacts(); await reloadResources();
        const result = next.proposals?.find(item => item.proposal_id === proposalId)?.result;
        if (result?.kind === 'note_create' && result.id) setTargetNoteId(String(result.id));
      }
    } catch (reason) { setError((reason as Error).message); }
    finally { lockAgentEditors(false); setWorking(false); }
  }

  async function cancel() {
    if (!run) return;
    try { setRun(await api<Run>(`/external-agents/runs/${run.id}/cancel`, { method: 'POST' })); lockAgentEditors(false); }
    catch (reason) { setError((reason as Error).message); }
  }

  function changeDraft(value: string) {
    const command = value.match(/^\/(plan|edit|auto)(?:\s|$)/i);
    const modes = { plan: 'answer', edit: 'propose', auto: 'auto' } as const;
    if (command) { setMode(modes[command[1].toLowerCase() as keyof typeof modes]); setDraft(value.slice(command[0].length)); }
    else setDraft(value);
    // "@" at the start of a word opens the picker on the words typed after it.
    const caret = composer.current?.selectionStart ?? value.length;
    const mention = value.slice(0, caret).match(/(?:^|\s)@([^\s@]{0,40}(?: [^\s@]{1,40}){0,2})$/);
    if (mention && !command) { setMentionQuery(mention[1]); setPicker(current => current === 'button' ? current : 'mention'); }
    else if (picker === 'mention') setPicker(null);
  }

  function pick(item: PickedItem) {
    // Picking adds (chips remove); a conversation works on one project and one collection at a time.
    setPicked(previous => previous.some(entry => entry.key === item.key) ? previous
      : [...previous.filter(entry => !((item.kind === 'project' || item.kind === 'collection') && entry.kind === item.kind)), item]);
    setExcludedFiles(previous => previous.filter(id => id !== String(item.id) && id !== `${item.kind}:${item.id}`));
    if (picker === 'mention') {
      const caret = composer.current?.selectionStart ?? draft.length;
      const before = draft.slice(0, caret).replace(/(^|\s)@[^@]*$/, '$1');
      setDraft(before + draft.slice(caret)); setPicker(null);
      window.setTimeout(() => composer.current?.focus(), 0);
    }
  }

  function useSuggestion(text: string) {
    setDraft(text); setMode(previous => /propos|rédig|enrich|décompos|reformul|cré[ée]/i.test(text) ? (previous === 'auto' ? 'auto' : 'propose') : 'answer'); composer.current?.focus();
  }

  function revealDocument() {
    if (window.matchMedia('(max-width: 820px)').matches) onClose?.();
  }

  const active = JSON.parse(contextSignature) as ReturnType<typeof activeDetails>;
  const automatic = [active.noteId && `note:${active.noteId}`, active.paperId && `paper:${active.paperId}`,
    active.resourcePath && resources.find(item => item.path === active.resourcePath)?.id,
    active.canvasPath && resources.find(item => item.path === active.canvasPath)?.id,
    targetNoteId && `note:${targetNoteId}`].filter(Boolean) as string[];
  const fileIds = [...new Set([...automatic, ...selectedFiles])].filter(id => !excludedFiles.includes(id));
  const selectedResources = preview?.resources || fileIds.map(id => resources.find(item => item.id === id)).filter(Boolean) as Resource[];
  const defaultNote = resources.find(item => item.id === `note:${active.noteId}`);
  const targetNote = resources.find(item => item.id === `note:${targetNoteId}`);
  const creatingNote = targetNoteId === '__new__' || preview?.note_intent === 'create';
  const targetLabel = creatingNote ? 'New note' : preview?.target?.title || targetNote?.title || defaultNote?.title;
  const ideas = suggestions[active.area] || [];
  const proposalErrors = run?.proposal_errors?.length ? run.proposal_errors : (run?.events || [])
    .filter(item => item.kind === 'error' && item.label === 'Proposal cannot be applied').map(item => item.detail);
  const filterLabels: Record<string, string> = { paperSearch: 'Search', paperStatusFilter: 'Reading', paperYearFilter: 'Year', paperFolderFilter: 'Folder', paperProjectFilter: 'Project', taskProjectFilter: 'Project', calendarProjectFilter: 'Project', calendarSourceFilter: 'Source', calendarCursor: 'Period', conferenceProjectFilter: 'Project', datasetProjectFilter: 'Project', noteScope: 'Espace', noteFolderId: 'Folder' };

  return <>
    <AssistantToolbar engine={engine} busy={!!busy} onEngineChange={onEngineChange} onNew={() => void create()}
      onHistory={() => setHistoryOpen(value => !value)} historyOpen={historyOpen} onClose={onClose}/>
    {historyOpen && <section className="assistant-history assistant-drawer" aria-label="Session history">
      <label>Conversations<select aria-label={'Session ' + name} value={selectedId} disabled={!!busy} onChange={event => void select(event.target.value)}>
        {!sessions.length && <option value="">No conversations</option>}
        {sessions.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select></label>
      <details><summary>Resume an external session</summary>
        <input aria-label={'Session ID ' + name} value={importId} onChange={event => setImportId(event.target.value)} placeholder="Session ID"/>
        <button type="button" disabled={!!busy || !importId.trim()} onClick={() => void create(importId.trim())}>Add this session</button>
      </details>
    </section>}
    <div ref={conversation} className="agent-panel-body agent-live-body external-agent-body" onScroll={event => {
      const body = event.currentTarget;
      followConversation.current = body.scrollHeight - body.clientHeight - body.scrollTop < 48;
    }}>
      {!session?.messages.length && <section className="assistant-welcome">
        <span className="assistant-welcome-mark"><Icon name="sparkle" size={24}/></span>
        <h3>A question, an idea?</h3>
        <p>Explore your sources or shape your notes.</p>
        <div className="assistant-starters">
          {ideas.slice(0, 2).map((text, index) => <button type="button" key={text} aria-label={text} disabled={!!busy} onClick={() => useSuggestion(text)}>
            <Icon name={index ? 'edit' : 'search'} size={15}/><span>{index ? 'Plan next steps' : active.area === 'reader' ? 'Understand this article' : active.area === 'canvas' ? 'Question this card' : active.area === 'notes' ? 'Summarize this note' : active.area === 'citations' ? 'Que lire ensuite ?' : 'Take stock'}</span><Icon name="chevron" size={12}/>
          </button>)}
          <button type="button" disabled={!!busy} onClick={() => { setTargetNoteId('__new__'); setMode('propose'); setDraft('Creates a note '); composer.current?.focus(); }}><Icon name="plus" size={15}/><span>Create a note</span><Icon name="chevron" size={12}/></button>
        </div>
      </section>}
      <div className="agent-messages" aria-live="polite">{session?.messages.map((message, index) => <article key={index} className={'agent-message ' + message.role}>
        <header><strong>{message.role === 'user' ? 'Vous' : name}</strong>
          {message.context && <span title={message.context.project_name || ''}>{message.context.focus?.length ? message.context.focus.map((item: { title?: string }) => item.title).join(', ') : message.context.view_label || message.context.view}</span>}</header>
        <AgentMessageContent content={message.content} onNavigate={revealDocument}/>
      </article>)}</div>
      {!!proposalErrors.length && <section className="assistant-proposal-errors" role="alert">
        <strong>{run?.proposals?.length ? 'Some changes could not be prepared' : 'The change was not prepared'}</strong>
        {proposalErrors.map((message, index) => <p key={index}>{message}</p>)}
        <button type="button" disabled={!!busy} onClick={() => {
          const request = session?.messages.slice().reverse().find(message => message.role === 'user');
          if (request) setDraft(request.content);
          setMode('propose'); setContextOpen(true); composer.current?.focus();
        }}>Resume the request</button>
      </section>}
      {run && <details className="assistant-activity">
        <summary><span className={run.status === 'running' ? 'assistant-working' : ''}>{run.status === 'running' ? 'Working…' : run.status === 'failed' ? 'Request interrupted' : run.status === 'cancelled' ? 'Request stopped' : 'Activity finished'}</span><span>{run.events?.length || 0} steps</span></summary>
        <ol>{(run.events || []).map(item => <li key={item.id} className={'external-event ' + item.kind}><strong>{item.label}</strong>{item.detail && <pre>{item.detail}</pre>}</li>)}</ol>
        {!!run.resources?.length && <details><summary>Sources for this request ({run.resources.length})</summary><ul>{run.resources.map(item => <li key={item.id}>{item.title}</li>)}</ul></details>}
        {!!run.modified_files?.length && <details><summary>Changed files ({run.modified_files.length})</summary><ul>{run.modified_files.map(path => <li key={path}>{path}</li>)}</ul></details>}
      </details>}
      {!!run?.proposals?.length && <section className="external-proposals" aria-label="Proposed changes">
        {run.proposals.map(proposal => {
          const kind = proposal.kind || proposal.action?.kind;
          const isDeletion = kind?.endsWith('_delete') ?? false;
          const isNewNote = kind === 'note_create';
          const isNewProject = kind === 'project_create';
          const isNote = isNewNote || ['note_update', 'note_block_update', 'note_block_insert', 'note_block_delete', 'note_content_replace', 'note_script_set'].includes(kind || '');
          const content = typeof proposal.after === 'string' ? proposal.after : proposal.after?.content;
          const noteId = proposal.result?.id || proposal.action?.id;
          return <article key={proposal.proposal_id} className={'assistant-change ' + proposal.status}>
            <header><Icon name={isNewNote || isNewProject ? 'plus' : 'edit'} size={16}/><div><strong>{proposal.label}</strong><small>{proposal.target}</small></div></header>
            {isNote && content !== undefined ? <details className="assistant-note-preview" open={proposal.status === 'pending'}><summary>{isNewNote ? 'Note preview' : 'Note after the change'}</summary><AgentMessageContent content={content} onNavigate={revealDocument}/></details> : null}
            <details className="assistant-diff" open={isDeletion && proposal.status === 'pending'}><summary>{isDeletion ? 'Items affected by the deletion' : 'View the change'}</summary><pre>{proposal.diff}</pre></details>
            {proposal.action?.values?.url && /^https?:\/\//i.test(proposal.action.values.url) && <a href={proposal.action.values.url} target="_blank" rel="noreferrer">Open the source ↗</a>}
            {proposal.action?.values?.doi && <a href={'https://doi.org/' + encodeURIComponent(proposal.action.values.doi)} target="_blank" rel="noreferrer">DOI : {proposal.action.values.doi}</a>}
            {proposal.status === 'pending' && mode === 'answer' && <small>Switch to /edit to apply this change.</small>}
            {proposal.status === 'pending' ? <div className="assistant-change-actions"><button className="assistant-apply" type="button" aria-label={isDeletion ? 'Approve this deletion' : isNewNote ? 'Create this note' : isNewProject ? 'Create this project' : 'Apply this change'} disabled={!!busy || mode === 'answer'} onClick={() => void decide(proposal.proposal_id, 'apply')}>{isDeletion ? 'Approve the deletion' : isNewNote ? 'Create the note' : isNewProject ? 'Create the project' : 'Apply'}</button>
              <button type="button" disabled={!!busy} onClick={() => void decide(proposal.proposal_id, 'dismiss')}>Dismiss</button></div>
              : <span className="assistant-change-status">{proposal.status === 'applied' ? '✓ ' + (isNewNote ? 'Note created' : isNewProject ? 'Project created' : 'Change applied') : 'Dismissed'}</span>}
            {proposal.status === 'applied' && isNote && noteId && <AgentMessageContent content={'[Open the note](./?view=notes&note_id=' + noteId + ')'} onNavigate={revealDocument}/>}
            {proposal.status === 'applied' && proposal.result?.kind === 'paper_import' && <button type="button" onClick={async () => { await runtime?.openPaper(proposal.result!.id); revealDocument(); }}>Open the article</button>}
          </article>;
        })}
      </section>}
      {error && <p className="agent-error" role="alert">{error}</p>}
    </div>
    <form className="agent-composer assistant-composer" onSubmit={event => void submit(event)} onKeyDown={event => {
      if (event.key === 'Escape') {
        event.currentTarget.querySelectorAll<HTMLDetailsElement>('.assistant-model-options[open], .assistant-ideas[open]').forEach(menu => { menu.open = false; });
        setContextOpen(false); composer.current?.focus(); event.stopPropagation();
      }
    }}>
      {contextOpen && <section className="assistant-context-drawer assistant-drawer" aria-label="Context for the next request">
        <header><strong>{active.view_label}{active.project_name ? ' · ' + active.project_name : ''}</strong><button type="button" aria-label="Close the context" onClick={() => setContextOpen(false)}><Icon name="close" size={14}/></button></header>
        {(active.selected_node_title || active.selected_node_id) && <p>Card: {active.selected_node_title || active.selected_node_id}</p>}
        {active.citation_graph && <p>Context: {(active.citation_graph.articles || active.citation_graph.candidates || []).length} related articles · every page, regardless of filters.</p>}
        {active.citation_graph?.selected && <p>Selected article : {active.citation_graph.selected.title}</p>}
        {preview?.code_repository && <section className="assistant-code-context"><strong>Project repository · {preview.code_repository.name || 'Project repository'}</strong>{preview.code_repository.unavailable ? <p>{preview.code_repository.unavailable}</p> : <><p>Structure and Git status · {preview.code_repository.branch || 'Local folder'} · Read-only</p><ul>{preview.code_repository.files?.map(file => <li key={file.path}>{file.path}{file.truncated ? ' · limited excerpt' : ''}</li>)}</ul></>}</section>}
        {active.selected_text && <blockquote>{active.selected_text}</blockquote>}
        {mode !== 'answer' && <label>Write in<select aria-label="Note cible" value={targetNoteId} disabled={!!busy} onChange={event => setTargetNoteId(event.target.value)}>
          <option value="">{defaultNote ? 'Note ouverte : ' + defaultNote.title : 'Note named in the message'}</option>
          <option value="__new__">＋ New note</option>
          {resources.filter(item => item.kind === 'note').map(item => <option key={item.id} value={item.note_id}>{item.title}</option>)}
        </select></label>}
        <div className="external-context-actions"><button type="button" disabled={!!busy} onClick={() => setShowFiles(value => !value)}>＋ Add files</button>
          <label className="external-upload">Attach a file<input aria-label="Attach a file" type="file" multiple accept=".md,.pdf,.txt,.canvas,.json,.csv" disabled={!!busy} onChange={event => void attach(event)}/></label></div>
        {showFiles ? <div className="external-file-picker"><input aria-label="Search for a file" value={fileSearch} onChange={event => setFileSearch(event.target.value)} placeholder="Search for a note or a file"/>
          <div className="agent-resource-list">{resources.filter(item => !fileSearch || (item.title + ' ' + item.path).toLowerCase().includes(fileSearch.toLowerCase())).map(item =>
            <label key={item.id}><input type="checkbox" checked={selectedResources.some(source => source.id === item.id)} disabled={!!busy} onChange={event => { setSelectedFiles(previous => event.target.checked ? [...previous, item.id] : previous.filter(id => id !== item.id)); setExcludedFiles(previous => event.target.checked ? previous.filter(id => id !== item.id) : [...previous, item.id]); }}/>
              <span>{item.title}<small>{item.path}</small></span></label>)}</div></div>
          : <ul className="assistant-source-list">{selectedResources.map(item => <li key={item.id}><span title={item.path}>{item.title}</span><button type="button" aria-label={'Retirer ' + item.title} disabled={!!busy} onClick={() => { setSelectedFiles(previous => previous.filter(id => id !== item.id)); setExcludedFiles(previous => [...previous, item.id]); }}>×</button></li>)}</ul>}
        <details><summary>Context options</summary>
          {mode !== 'answer' && <label className="assistant-checkbox"><input type="checkbox" checked={multipleNotes} disabled={!!busy} onChange={event => setMultipleNotes(event.target.checked)}/> Allow several notes in this request</label>}
          <dl>{Object.entries(active.filters || {}).filter(([, value]) => value && !['all', 'root'].includes(String(value))).map(([key, value]) => <div key={key}><dt>{filterLabels[key] || key}</dt><dd>{String(value)}</dd></div>)}</dl>
          <small>The context is frozen when sent. You can remove a source from the list.</small>
        </details>
      </section>}
      {picker && <ContextPicker options={options} picked={picked} mention={picker === 'mention'} query={picker === 'mention' ? mentionQuery : ''}
        onPick={pick} onClose={() => { setPicker(null); composer.current?.focus(); }}/>}
      <div className="assistant-picked" aria-label="Context of this conversation">
        {picked.map(item => <span key={item.key} className={'assistant-chip ' + item.kind} title={[KIND_LABELS[item.kind], item.subtitle].filter(Boolean).join(' · ')}>
          <Icon name={KIND_ICONS[item.kind]} size={12}/><span>{item.title}</span>{item.count !== undefined && <small>{item.count}</small>}
          <button type="button" aria-label={'Remove ' + item.title} disabled={!!busy} onClick={() => setPicked(previous => previous.filter(entry => entry.key !== item.key))}>×</button>
        </span>)}
        <button type="button" className="assistant-add-context" disabled={!!busy} aria-expanded={picker === 'button'} title="Add a project, note, article, folder or collection · or type @ in the message"
          onClick={() => setPicker(current => current === 'button' ? null : 'button')}><Icon name="plus" size={12}/>{picked.length ? 'Add' : 'Add context'}<small>@</small></button>
      </div>
      <div className="assistant-context-bar">
        <button type="button" className="assistant-context-toggle" aria-label="Context and files" aria-expanded={contextOpen} aria-busy={contextLoading} onClick={() => setContextOpen(value => !value)}>
          <Icon name={creatingNote ? 'plus' : 'notes'} size={13}/><span>{targetLabel || active.project_name || (active.view === 'chat' ? 'Sources and options' : active.view_label)}</span><small>{selectedResources.length + (preview?.code_repository?.files?.length || 0)} sources</small><Icon name="chevron" size={11}/>
        </button>
        <details className="assistant-ideas"><summary aria-label="Assistant suggestions" title="Suggestions">✦</summary><div>{ideas.map(text => <button type="button" key={text} disabled={!!busy} onClick={event => { useSuggestion(text); event.currentTarget.closest('details')?.removeAttribute('open'); }}>{text}</button>)}</div></details>
      </div>
      <label className="assistant-sr-only" htmlFor="external-agent-draft">Message to {name}</label>
      <textarea id="external-agent-draft" ref={composer} value={draft} disabled={!!busy} onChange={event => changeDraft(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}
        placeholder={mode === 'answer' ? 'Ask a question, explore an idea… Type @ to add a project, note or article' : 'Describe the note to create or change… Type @ to add context'} rows={3}/>
      <div className="assistant-compose-options">
        <div className="assistant-mode-switch" role="group" aria-label="Assistant mode">
          <button type="button" aria-pressed={mode === 'answer'} disabled={!!busy} title="Discuss and plan without changing files" onClick={() => setMode('answer')}>/plan</button>
          <button type="button" aria-pressed={mode === 'propose'} disabled={!!busy} title="Create and edit with a preview before applying" onClick={() => setMode('propose')}>/edit</button>
          <button type="button" aria-pressed={mode === 'auto'} disabled={!!busy} title="Let the agent apply its changes directly: notes, collections and items" onClick={() => setMode('auto')}>/auto</button>
        </div>
        <ExternalModelPicker engine={engine} name={name} model={model} effort={effort} compact disabled={!!busy} onChange={(value, level) => { setModel(value); setEffort(level); }}/>
      </div>
      <div className="assistant-compose-bottom"><small>{mode === 'answer' ? 'Read and think' : mode === 'auto' ? 'Changes applied directly · listed below' : creatingNote ? 'New note · preview before creating' : 'Changes with preview'}</small>
        {run?.status === 'running' ? <button type="button" className="assistant-send" onClick={() => void cancel()}>Stop</button>
          : <button className="assistant-send" aria-label="Send" title="Send · Enter" disabled={!!busy || !draft.trim()}>{working ? '…' : <Icon name="arrow" size={16}/>}</button>}
      </div>
      {contextError && <p className="agent-error" role="alert">{contextError}</p>}
    </form>
  </>;
}
