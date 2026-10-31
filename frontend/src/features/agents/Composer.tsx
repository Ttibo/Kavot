import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useOptionalRuntime } from '../../app/runtime';
import { ContextPicker } from '../../components/ContextPicker';
import { ExternalModelPicker } from '../../components/ExternalModelPicker';
import type { ExternalEngine } from '../../components/ExternalAgentSettings';
import { Icon } from '../../components/Icon';
import { api } from '../../services/api';
import { captureAgentContext, suggestions, takePendingSuggestion } from '../externalAgents/context';
import { folderOptions, KIND_ICONS, KIND_LABELS, loadPicked, pickedContext, pickerOptions, savePicked, type PickedItem, type ProjectFolder } from '../externalAgents/picker';
import { agents, ENGINE_NAMES, type Mode, type Resource, type Session } from './api';

export type EngineChoice = { id: ExternalEngine; name: string; model: string; effort: string };
export type Outgoing = { text: string; context: any; model: string; effort: string; mode: Mode; engine: ExternalEngine };
/** What a new conversation starts with, chosen in the message bar before the first message. */
export type NewConversationDraft = { model: string; effort: string; mode: Mode };

const MODES: [Mode, string, string][] = [
  ['answer', '/plan', 'Discuss and plan: nothing is changed'],
  ['propose', '/edit', 'Prepare changes: notes and data are applied after your review, code is changed in a worktree'],
  ['auto', '/auto', 'Apply changes to notes and data directly; code changes are still reviewed before any commit'],
];
const COMMANDS = { plan: 'answer', edit: 'propose', auto: 'auto' } as const;
// A project's linked folders, kept while the app runs: the picker opens at once.
const projectFolders = new Map<number, { name: string; folders: ProjectFolder[] }>();

function useProjectFolders(projectId: number | null) {
  const [value, setValue] = useState(() => projectId ? projectFolders.get(projectId) || null : null);
  useEffect(() => {
    if (!projectId) { setValue(null); return; }
    setValue(projectFolders.get(projectId) || null);
    let active = true;
    api<{ project: { name: string }; folders: ProjectFolder[] }>(`/atelier/projects/${projectId}`).then(result => {
      const next = { name: result.project.name, folders: result.folders };
      projectFolders.set(projectId, next);
      if (active) setValue(next);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [projectId]);
  return value;
}

/** The message box of every agent conversation: what to send, with which context, mode, engine and model.
 * The context follows the view (the open note, article, canvas, project or code) unless the user turns it off,
 * and the user adds or removes items by hand (＋ or @). */
export function Composer({ session, engines, engine, onEngineChange, projectId, running, busy, onSend, onStop, autoFocus, preset, draft: draftChoice, onDraftChange }: {
  session: Session | null; engines: EngineChoice[]; engine: ExternalEngine; onEngineChange: (engine: ExternalEngine) => void;
  projectId?: number | null; running: boolean; busy: boolean; autoFocus?: boolean;
  /** Context a new conversation starts with, such as the task given to an agent from the board. */
  preset?: PickedItem[];
  /** Model and mode of a conversation that does not exist yet, kept by the surface until its first message. */
  draft?: NewConversationDraft; onDraftChange?: (draft: NewConversationDraft) => void;
  onSend: (message: Outgoing) => Promise<boolean>; onStop: () => void;
}) {
  const runtime = useOptionalRuntime();
  const state = runtime?.state;
  const chosen = engines.find(item => item.id === engine);
  const [draft, setDraft] = useState('');
  const [modeLocal, setModeLocal] = useState<Mode>('answer');
  const [model, setModel] = useState(session?.model ?? chosen?.model ?? '');
  const [effort, setEffort] = useState(session?.effort ?? chosen?.effort ?? '');
  // A conversation that does not exist yet keeps its model and mode in the surface's draft.
  const fresh = draftChoice ?? { model: '', effort: '', mode: 'answer' as Mode };
  const isNew = !session;
  const mode = isNew ? fresh.mode : modeLocal;
  const pickMode = (next: Mode) => { if (isNew) onDraftChange?.({ ...fresh, mode: next }); else setModeLocal(next); };
  const sendModel = isNew ? fresh.model : model;
  const sendEffort = isNew ? fresh.effort : effort;
  const [picked, setPicked] = useState<PickedItem[]>(() => loadPicked(session?.id || ''));
  const [useView, setUseView] = useState(true);
  const [picker, setPicker] = useState<'button' | 'mention' | null>(null);
  const [mentionQuery, setMentionQuery] = useState('');
  const [drawer, setDrawer] = useState(false);
  const [targetNoteId, setTargetNoteId] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [excludedFiles, setExcludedFiles] = useState<string[]>([]);
  const [multipleNotes, setMultipleNotes] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [fileSearch, setFileSearch] = useState('');
  const [resources, setResources] = useState<Resource[]>([]);
  const [preview, setPreview] = useState<{ resources: Resource[]; target: Resource | null; note_intent?: string } | null>(null);
  const [error, setError] = useState('');
  const [viewSignature, setViewSignature] = useState(() => JSON.stringify(captureAgentContext(runtime)));
  const composer = useRef<HTMLTextAreaElement>(null);

  // Another conversation: its own model and context. A new one keeps what was picked before its first message.
  const shownSession = useRef(session?.id || '');
  useEffect(() => {
    const previous = shownSession.current;
    shownSession.current = session?.id || '';
    if (!previous && session?.id) { savePicked(session.id, picked); return; }
    if (!session) { setModeLocal('answer'); } // A new conversation follows the draft.
    else { setModel(session.model ?? chosen?.model ?? ''); setEffort(session.effort ?? chosen?.effort ?? ''); }
    setPicked(loadPicked(session?.id || '')); setTargetNoteId(''); setSelectedFiles([]); setExcludedFiles([]); setMultipleNotes(false);
    setDrawer(false); setPicker(null); setError('');
  }, [session?.id, engine]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { savePicked(session?.id || '', picked); }, [picked]); // eslint-disable-line react-hooks/exhaustive-deps
  const presetKey = (preset || []).map(item => item.key).join(',');
  useEffect(() => {
    if (!preset?.length || session) return;
    setPicked(previous => [...previous, ...preset.filter(item => !previous.some(entry => entry.key === item.key))]);
    composer.current?.focus();
  }, [presetKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void agents.resources().then(setResources).catch(() => undefined); }, []);
  useEffect(() => {
    const reload = () => { setSelectedFiles([]); setExcludedFiles([]); setTargetNoteId(''); setPreview(null); void agents.resources().then(setResources).catch(() => undefined); };
    window.addEventListener('kavot:storage-updated', reload);
    return () => window.removeEventListener('kavot:storage-updated', reload);
  }, []);
  // The view changes as the user works: follow it.
  useEffect(() => {
    const timer = window.setInterval(() => setViewSignature(JSON.stringify(captureAgentContext(runtime))), 700);
    return () => window.clearInterval(timer);
  }, [runtime]);
  useEffect(() => {
    const apply = (text: string) => {
      setDraft(text); pickMode(/rédig|enrich|reformul|modifi|cré[ée]/i.test(text) ? 'propose' : 'answer');
      composer.current?.focus();
    };
    const suggest = (event: Event) => { if (!busy) apply((event as CustomEvent).detail.text); };
    // A suggestion that opened this view is waiting for it.
    const pending = busy ? null : takePendingSuggestion();
    if (pending) apply(pending);
    window.addEventListener('kavot:assistant-suggestion', suggest);
    return () => window.removeEventListener('kavot:assistant-suggestion', suggest);
  }, [busy]);

  const view = JSON.parse(viewSignature) as Record<string, any>;
  const extra = pickedContext(picked, state, resources);
  const scopeProject = Number(projectId || session?.project_id || extra.project_id || (useView ? view.project_id : 0)) || null;
  const folders = useProjectFolders(scopeProject);
  const attached = new Set([...(session?.code?.workspaces || []).filter(space => space.open !== false && space.worktree).map(space => `code:${space.folder_id}`),
    ...(session?.code?.resources || []).map(item => `resource:${item.folder_id}`)]);
  const projectOptions = scopeProject && folders ? folderOptions(scopeProject, folders.name, folders.folders).filter(item => !attached.has(`${item.kind}:${item.id}`)) : [];
  const options = useMemo(() => picker ? pickerOptions(state, resources, projectOptions) : [], [picker, resources, projectOptions.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // What the view suggests without adding it on its own: the code shown in the Atelier.
  const suggested = useView && view.code_folder_id ? projectOptions.filter(item => item.id === view.code_folder_id && !picked.some(entry => entry.key === item.key)) : [];

  function makeContext() {
    const scope: Record<string, any> = useView ? view : { view: 'chat', area: 'chat', view_label: 'Chat', filters: {}, open_documents: [] };
    const noteId = scope.note_id || extra.note_id;
    const general = ['chat', 'dashboard', 'projects'].includes(scope.area);
    const project = extra.project_id || projectId || session?.project_id;
    return { ...scope,
      ...(project ? { project_id: project, project_name: extra.project_name || scope.project_name } : {}),
      ...(extra.collection_id ? { collection_id: extra.collection_id, picked_collection: true } : {}),
      area: project && general ? 'project' : scope.area, note_id: noteId,
      view_label: extra.focus.length && general ? extra.focus.map(item => String(item.title)).join(', ') : scope.view_label,
      paper_ids: extra.paper_ids, focus: extra.focus,
      code_folder_ids: extra.code_folder_ids, resource_folder_ids: extra.resource_folder_ids,
      target_note_id: targetNoteId === '__new__' ? null : targetNoteId || (noteId ? String(noteId) : null),
      target_choice: !!targetNoteId && targetNoteId !== '__new__',
      note_intent: targetNoteId === '__new__' ? 'create' : null,
      allow_multiple_notes: multipleNotes || extra.resource_ids.filter(id => id.startsWith('note:')).length > 1,
      resource_ids: [...new Set([...selectedFiles, ...extra.resource_ids])], excluded_resource_ids: excludedFiles,
    };
  }
  const contextKey = JSON.stringify([useView ? viewSignature : '', picked.map(item => item.key), targetNoteId, selectedFiles, excludedFiles, multipleNotes, projectId, session?.project_id]);
  // The sources the next message will get, resolved by the server as the user types.
  useEffect(() => {
    if (!drawer) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api<{ resources: Resource[]; target: Resource | null; note_intent?: string }>('/external-agents/context', { method: 'POST', signal: controller.signal,
        body: JSON.stringify({ text: draft || 'Context', context: makeContext() }) })
        .then(result => { if (!controller.signal.aborted) { setPreview(Array.isArray(result.resources) ? result : null); setError(''); } })
        .catch(reason => { if (!controller.signal.aborted) setError(reason.message); });
    }, 400);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [drawer, contextKey]); // eslint-disable-line react-hooks/exhaustive-deps

  function pick(item: PickedItem) {
    // A conversation works on one project and one collection at a time.
    setPicked(previous => previous.some(entry => entry.key === item.key) ? previous
      : [...previous.filter(entry => !((item.kind === 'project' || item.kind === 'collection') && entry.kind === item.kind)), item]);
    setExcludedFiles(previous => previous.filter(id => id !== String(item.id) && id !== `${item.kind}:${item.id}`));
    if (item.kind === 'code' && mode === 'answer') pickMode('propose');
    if (picker === 'mention') {
      const caret = composer.current?.selectionStart ?? draft.length;
      const before = draft.slice(0, caret).replace(/(^|\s)@[^@]*$/, '$1');
      setDraft(before + draft.slice(caret)); setPicker(null);
      window.setTimeout(() => composer.current?.focus(), 0);
    }
  }

  function changeDraft(value: string) {
    const command = value.match(/^\/(plan|edit|auto)(?:\s|$)/i);
    if (command) { pickMode(COMMANDS[command[1].toLowerCase() as keyof typeof COMMANDS]); setDraft(value.slice(command[0].length)); }
    else setDraft(value);
    // "@" at the start of a word opens the picker on the words typed after it.
    const caret = composer.current?.selectionStart ?? value.length;
    const mention = value.slice(0, caret).match(/(?:^|\s)@([^\s@]{0,40}(?: [^\s@]{1,40}){0,2})$/);
    if (mention && !command) { setMentionQuery(mention[1]); setPicker(current => current === 'button' ? current : 'mention'); }
    else if (picker === 'mention') setPicker(null);
  }

  async function attach(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    for (const file of files) {
      try {
        const result = await agents.attach(file);
        setResources(previous => [...previous, result]);
        setSelectedFiles(previous => [...previous, result.id]);
      } catch (reason) { setError((reason as Error).message); }
    }
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || busy || running) return;
    setError('');
    const sent = await onSend({ text, context: makeContext(), model: sendModel, effort: sendEffort, mode, engine });
    if (!sent) return;
    setDraft(''); setDrawer(false); setPicker(null);
    // Code and folders are now part of the conversation: they are not given again with every message.
    setPicked(previous => previous.filter(item => item.kind !== 'code' && item.kind !== 'resource'));
  }

  const noteTitle = (id?: number | string | null) => id ? resources.find(item => item.id === `note:${id}`)?.title : undefined;
  const viewTitle = useView ? noteTitle(view.note_id) || (view.open_documents || []).find((item: any) => item.active)?.title : '';
  const viewLabel = [view.view_label, viewTitle].filter(Boolean).join(' · ');
  const creating = targetNoteId === '__new__' || preview?.note_intent === 'create';
  const sources = preview?.resources || [];
  const ideas = suggestions[useView ? view.area : 'dashboard'] || [];
  return <form className="atelier-composer agent-compose" onSubmit={event => void submit(event)} onKeyDown={event => {
    if (event.key === 'Escape') { setDrawer(false); setPicker(null); event.stopPropagation(); }
  }}>
    {drawer && <section className="assistant-context-drawer assistant-drawer" aria-label="Context for the next message">
      <header><strong>Sources of the next message</strong><button type="button" aria-label="Close the context" onClick={() => setDrawer(false)}><Icon name="close" size={14}/></button></header>
      {useView && view.selected_text && <blockquote>{view.selected_text}</blockquote>}
      {mode !== 'answer' && <label>Write in<select aria-label="Target note" value={targetNoteId} disabled={busy} onChange={event => setTargetNoteId(event.target.value)}>
        <option value="">{noteTitle(view.note_id) ? 'Open note: ' + noteTitle(view.note_id) : 'Note named in the message'}</option>
        <option value="__new__">＋ New note</option>
        {resources.filter(item => item.kind === 'note').map(item => <option key={item.id} value={item.note_id}>{item.title}</option>)}
      </select></label>}
      <div className="external-context-actions"><button type="button" disabled={busy} onClick={() => setShowFiles(value => !value)}>＋ Add files</button>
        <label className="external-upload">Attach a file<input aria-label="Attach a file" type="file" multiple accept=".md,.pdf,.txt,.canvas,.json,.csv" disabled={busy} onChange={event => void attach(event)}/></label></div>
      {showFiles ? <div className="external-file-picker"><input aria-label="Search for a file" value={fileSearch} onChange={event => setFileSearch(event.target.value)} placeholder="Search for a note or a file"/>
        <div className="agent-resource-list">{resources.filter(item => !fileSearch || (item.title + ' ' + item.path).toLowerCase().includes(fileSearch.toLowerCase())).map(item =>
          <label key={item.id}><input type="checkbox" checked={sources.some(source => source.id === item.id) || selectedFiles.includes(item.id)} disabled={busy}
            onChange={event => { setSelectedFiles(previous => event.target.checked ? [...previous, item.id] : previous.filter(id => id !== item.id)); setExcludedFiles(previous => event.target.checked ? previous.filter(id => id !== item.id) : [...previous, item.id]); }}/>
            <span>{item.title}<small>{item.path}</small></span></label>)}</div></div>
        : <ul className="assistant-source-list">{sources.map(item => <li key={item.id}><span title={item.path}>{item.title}</span>
            <button type="button" aria-label={'Remove ' + item.title} disabled={busy} onClick={() => { setSelectedFiles(previous => previous.filter(id => id !== item.id)); setExcludedFiles(previous => [...previous, item.id]); }}>×</button></li>)}
            {!sources.length && <li><span>No document: the agent explores the workspace through Kavot's tools.</span></li>}</ul>}
      {mode !== 'answer' && <label className="assistant-checkbox"><input type="checkbox" checked={multipleNotes} disabled={busy} onChange={event => setMultipleNotes(event.target.checked)}/> Allow several notes in this message</label>}
      <small>The context is frozen when sent. The agent reads everything else through Kavot's tools, within this scope.</small>
    </section>}
    {picker && <ContextPicker options={options} picked={picked} mention={picker === 'mention'} query={picker === 'mention' ? mentionQuery : ''}
      onPick={pick} onClose={() => { setPicker(null); composer.current?.focus(); }}/>}
    <div className="assistant-picked" aria-label="Context of the next message">
      {useView ? <span className="assistant-chip agent-view-chip" title="The context follows what you have open. Remove it to send only what you picked.">
          <Icon name="eye" size={12}/><span>{viewLabel || 'Current view'}</span>
          <button type="button" aria-label="Do not use the current view" disabled={busy} onClick={() => setUseView(false)}>×</button></span>
        : <button type="button" className="assistant-add-context" onClick={() => setUseView(true)} title="Give the agent what you have open"><Icon name="eye" size={12}/>Use the view</button>}
      {suggested.map(item => <button key={item.key} type="button" className="assistant-add-context agent-suggestion" onClick={() => pick(item)} title={item.subtitle}>
        <Icon name={KIND_ICONS[item.kind]} size={12}/>{item.title}</button>)}
      {picked.map(item => <span key={item.key} className={'assistant-chip ' + item.kind} title={[KIND_LABELS[item.kind], item.subtitle].filter(Boolean).join(' · ')}>
        <Icon name={KIND_ICONS[item.kind]} size={12}/><span>{item.title}</span>{item.count !== undefined && <small>{item.count}</small>}
        <button type="button" aria-label={'Remove ' + item.title} disabled={busy} onClick={() => setPicked(previous => previous.filter(entry => entry.key !== item.key))}>×</button>
      </span>)}
      <button type="button" className="assistant-add-context" disabled={busy} aria-expanded={picker === 'button'}
        title="Add a project, its code, a task, a note, an article, a folder or a collection · or type @ in the message"
        onClick={() => setPicker(current => current === 'button' ? null : 'button')}><Icon name="plus" size={12}/>{picked.length ? 'Add' : 'Add context'}<small>@</small></button>
    </div>
    <label className="assistant-sr-only" htmlFor={`agent-draft-${session?.id || 'new'}`}>Message to {chosen?.name || engine}</label>
    <textarea id={`agent-draft-${session?.id || 'new'}`} ref={composer} rows={2} value={draft} disabled={busy} autoFocus={autoFocus}
      onChange={event => changeDraft(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && picker !== 'mention') { event.preventDefault(); void submit(); } }}
      placeholder={mode === 'answer' ? 'Ask, explore, plan… Type @ to add a project, its code, a note or an article'
        : picked.some(item => item.kind === 'code') || session?.code?.worktree_exists ? 'Describe the change: “Add a CSV export to the reports page, with a test.”'
        : 'Describe the note or the change… Type @ to add context'}/>
    <div className="atelier-composer-bar">
      {/* Mode, agent and model, under the message: a new conversation chooses its agent, an existing one keeps it. */}
      <div className="assistant-mode-switch" role="group" aria-label="Mode">
        {MODES.map(([id, label, hint]) => <button key={id} type="button" aria-pressed={mode === id} disabled={busy} title={hint} onClick={() => pickMode(id)}>{label}</button>)}
      </div>
      {isNew && engines.length > 1
        ? <select className="atelier-chip agent-engine-chip agent-engine-select" aria-label="Agent" value={engine} disabled={busy} onChange={event => onEngineChange(event.target.value as ExternalEngine)}>
            {engines.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        : <span className="atelier-chip static agent-engine-chip" title={`Agent · ${chosen?.name || ENGINE_NAMES[engine]}${sendModel ? ` · ${sendModel}` : ''}`}>{chosen?.name || ENGINE_NAMES[engine]}</span>}
      {chosen && <ExternalModelPicker engine={engine} name={chosen.name} model={sendModel} effort={sendEffort} compact disabled={busy}
        onChange={(value, level) => { if (isNew) onDraftChange?.({ ...fresh, model: value, effort: level }); else { setModel(value); setEffort(level); } }}/>}
      <span className="atelier-head-spacer"/>
      <button type="button" className={`atelier-chip ${drawer ? 'active' : ''}`} aria-expanded={drawer} title="Sources, target note and files of the next message" onClick={() => setDrawer(value => !value)}>
        <Icon name={creating ? 'plus' : 'notes'} size={12}/><span className="agent-label">{creating ? 'New note' : 'Sources'}</span><Icon name="chevron" size={10}/></button>
      {!!ideas.length && <details className="assistant-ideas"><summary aria-label="Suggestions" title="Suggestions">✦</summary><div>{ideas.map(text =>
        <button type="button" key={text} disabled={busy} onClick={event => { setDraft(text); event.currentTarget.closest('details')?.removeAttribute('open'); composer.current?.focus(); }}>{text}</button>)}</div></details>}
      {running ? <button type="button" className="button atelier-send" onClick={onStop}>Stop</button>
        : <button className="button button-primary atelier-send" aria-label="Send" title="Send · Enter (Shift+Enter for a new line)" disabled={busy || !draft.trim() || !chosen}><Icon name="arrow" size={13}/><span className="agent-label">{busy ? '…' : 'Send'}</span></button>}
    </div>
    {(error || !chosen) && <p className="agent-error" role="alert">{error || 'Enable Codex, Claude Code or OpenCode in Settings → AI and agents.'}</p>}
  </form>;
}
