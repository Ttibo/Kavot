import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useRuntime } from '../app/runtime';
import { refreshData, toast } from '../app/navigation';
import { publish } from '../app/viewBridge';
import { Icon } from '../components/Icon';
import { AgentMessageContent } from '../components/AgentMessageContent';
import { ViewHeader, ViewPage } from '../components/ViewLayout';
import { openCollectionItem } from '../features/collections/catalog';
import { takeWatcherIntent } from '../features/collections/CollectionWatchers';
import { CitationGraph } from '../features/library/CitationGraph';
import { graphSeed, ReportList, SuggestionTable, type Report, type Suggestion } from '../features/watchers/Suggestions';
import { api } from '../services/api';
import '../styles/features/collection-watchers.css';

type Engine = 'claude' | 'codex' | 'opencode';
type Source = { type: 'scholarly' | 'web_search' | 'url'; url?: string; label?: string };
type Target = { type: 'collection'; collection_id: string } | { type: 'note'; note_id: number | null; position: 'append' | 'prepend' };
type Change = {
  proposal_id: string; label: string; kind: string; target: string; diff: string; status: 'pending' | 'applied' | 'dismissed';
  result?: { id?: string | number; kind?: string }; before?: any;
  action?: { kind?: string; id?: string | number; database_id?: string; values?: Record<string, any> };
};
type Activity = { id: number; kind: string; label: string; detail?: string };
type RunEntry = {
  run_id: string; status: string; started_at?: string; finished_at?: string; mode?: string;
  applied: number; pending: number; summary: string; changes?: Change[]; events?: Activity[];
};
type Draft = {
  name: string; enabled: boolean; description: string; instructions: string; keywords: string[]; topics: string[];
  folder_ids: number[]; semantic_enabled: boolean; sources: Source[]; target: Target; apply_mode: 'review' | 'auto';
  allow_updates: boolean; max_items: number; interval_hours: number; engine: Engine; model: string; effort: string;
  preset: string; timeout_minutes: number;
};
type Watcher = Draft & {
  id: number; last_run_at: string | null; last_run_id: string | null; last_error: string | null; history: RunEntry[];
  suggestions: Suggestion[]; reports: Report[]; running: boolean; direct: boolean; next_run_at: string | null;
  pending_count: number; applied_count: number;
};
type Preset = { id: string; name: string; description: string; task: string; allow_updates?: boolean; max_items?: number };
type Tab = 'review' | 'results' | 'reports' | 'handled' | 'runs';
type AssistProposal = { name: string; task: string; sources: { url: string; label: string }[]; queries: string[]; allow_updates: boolean; max_items: number; interval_hours: number; explanation: string };
type AssistRun = { id: string; status: string; response?: string | null; error?: string | null; events?: Activity[] };
type Collection = { id: string; name: string; fields?: { id: string; name: string; type: string }[] };

const LIBRARY = 'articles';
const INTERVALS: [number, string][] = [[0, 'Manual only'], [6, 'Every 6 hours'], [12, 'Every 12 hours'], [24, 'Daily'], [72, 'Every 3 days'], [168, 'Weekly'], [720, 'Monthly']];
const DRAFT_KEYS: (keyof Draft)[] = ['name', 'enabled', 'description', 'instructions', 'keywords', 'topics', 'folder_ids', 'semantic_enabled', 'sources', 'target',
  'apply_mode', 'allow_updates', 'max_items', 'interval_hours', 'engine', 'model', 'effort', 'preset', 'timeout_minutes'];
const BUILTIN_TYPES: Record<string, string> = { task: 'task', conference: 'conference', dataset: 'dataset', paper: 'paper', note: 'note' };
const SOURCE_LABELS: Record<Source['type'], [string, string, string]> = {
  scholarly: ['Scientific literature', 'OpenAlex: articles, preprints and reviews', 'papers'],
  web_search: ['Web search', 'The agent searches the web', 'search'],
  url: ['Specific pages', 'Pages or search URLs to check', 'link'],
};

const when = (value?: string | null) => value
  ? new Date(value).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never';
const frequency = (hours: number) => INTERVALS.find(([value]) => value === hours)?.[1] || `Every ${hours} h`;
const isDirect = (draft: Pick<Draft, 'sources' | 'target'>) => draft.target.type === 'collection' && draft.target.collection_id === LIBRARY
  && draft.sources.length === 1 && draft.sources[0].type === 'scholarly';
const blank = (target: Target, engine: Engine): Draft => ({
  name: '', enabled: true, description: '', instructions: '', keywords: [], topics: [], folder_ids: [], semantic_enabled: true,
  sources: target.type === 'collection' && target.collection_id === LIBRARY ? [{ type: 'scholarly' }] : [{ type: 'web_search' }],
  target, apply_mode: 'review', allow_updates: false, max_items: 10, interval_hours: 168, engine, model: '', effort: '', preset: '', timeout_minutes: 20,
});

/** Read the assistant's JSON answer defensively: every field is checked and clamped before use. */
function parseProposal(response: string): AssistProposal {
  const block = response.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || response;
  const start = block.indexOf('{'); const end = block.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('The assistant did not return a usable configuration. Rephrase your request.');
  const value = JSON.parse(block.slice(start, end + 1));
  if (typeof value.task !== 'string' || !value.task.trim()) throw new Error('The proposed configuration has no task. Ask the assistant again.');
  const strings = (list: unknown) => Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string' && !!item.trim()).map(item => item.trim()) : [];
  const sources = (Array.isArray(value.sources) ? value.sources : [])
    .map((item: any) => typeof item === 'string' ? { label: '', url: item } : { label: String(item?.label || '').slice(0, 120), url: String(item?.url || '').trim() })
    .filter((item: { url: string }) => /^https?:\/\//i.test(item.url)).slice(0, 20);
  const interval = INTERVALS.map(([hours]) => hours).includes(Number(value.interval_hours)) ? Number(value.interval_hours) : 24;
  return { name: String(value.name || '').slice(0, 100), task: value.task.slice(0, 8000), sources, queries: strings(value.queries).slice(0, 20),
    allow_updates: value.allow_updates === true, max_items: Math.min(50, Math.max(1, Number(value.max_items) || 10)),
    interval_hours: interval, explanation: typeof value.explanation === 'string' ? value.explanation : '' };
}

/** Where an applied change lives, so it can be opened in Kavot. */
function changeTarget(change: Change) {
  const kind = change.action?.kind || change.kind;
  const id = change.result?.id ?? change.action?.id;
  if (id == null || kind.endsWith('_delete')) return null;
  if (kind.startsWith('record_')) return { type: 'record', id, databaseId: change.action?.database_id };
  const domain = kind.split('_')[0];
  return BUILTIN_TYPES[domain] ? { type: BUILTIN_TYPES[domain], id, databaseId: domain === 'paper' ? 'articles' : undefined } : null;
}

function itemTitle(change: Change, collectionId?: string) {
  const values = change.action?.values?.values || change.action?.values || {};
  return String(values.title || values.name || (change.target && change.target !== collectionId ? change.target : change.label));
}

const verb = (kind: string) => kind.endsWith('_create') || kind === 'paper_import' ? 'Created' : kind.endsWith('_delete') ? 'Deleted' : 'Updated';

function ChangeValues({ change, labels }: { change: Change; labels: Record<string, string> }) {
  const values = change.action?.values?.values || change.action?.values || {};
  const previous = change.before?.values || change.before || {};
  const updating = verb(change.kind) === 'Updated';
  const show = (value: unknown) => /^https?:\/\//.test(String(value)) ? <a href={String(value)} target="_blank" rel="noreferrer">{String(value)}</a> : String(value);
  const entries = Object.entries(values).filter(([key, value]) => key !== 'content' && value !== null && value !== '' && typeof value !== 'object'
    && (!updating || JSON.stringify(previous[key]) !== JSON.stringify(value)));
  const content = typeof values.content === 'string' && (!updating || values.content !== previous.content) ? values.content : '';
  return <>
    {entries.length > 0 && <dl className="wv-values">{entries.slice(0, 12).map(([key, value]) => <div key={key}><dt>{labels[key] || key}</dt><dd>{
      updating && previous[key] != null && previous[key] !== '' ? <><s className="wv-old">{String(previous[key])}</s> → {show(value)}</> : show(value)}</dd></div>)}</dl>}
    {content && <details className="wv-content"><summary>Content</summary><AgentMessageContent content={content}/></details>}
    <details className="wv-diff"><summary>Technical diff</summary><pre>{change.diff}</pre></details>
  </>;
}

export function WatchersView() {
  const runtime = useRuntime();
  const state = runtime.state;
  const collections: Collection[] = state.databases || [];
  const collectionName = useCallback((id?: string) => id === LIBRARY ? 'Library' : collections.find(item => item.id === id)?.name || id || '', [collections]);
  const targetName = useCallback((target: Target) => target.type === 'note'
    ? `Note · ${state.notes.find((note: Note) => note.id === target.note_id)?.title || 'deleted note'}` : collectionName(target.collection_id), [collectionName, state.notes]);
  const [intent] = useState(takeWatcherIntent);
  const [watchers, setWatchers] = useState<Watcher[]>([]);
  const [detail, setDetail] = useState<Watcher | null>(null);
  const [selected, setSelected] = useState<number | null>(intent?.watcherId ?? null);
  const [filter, setFilter] = useState(intent?.collectionId || '');
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [tab, setTab] = useState<Tab>('review');
  const [reportFilter, setReportFilter] = useState<string | null>(null);
  const [graph, setGraph] = useState<Suggestion | null>(null);
  const [draft, setDraft] = useState<Draft>(blank({ type: 'collection', collection_id: intent?.collectionId || LIBRARY }, 'claude'));
  const [keywordsText, setKeywordsText] = useState('');
  const [presets, setPresets] = useState<Preset[]>([]);
  const [engines, setEngines] = useState<{ id: Engine; name: string }[]>([]);
  const [live, setLive] = useState<Activity[]>([]);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [assistRequest, setAssistRequest] = useState('');
  const [assistSession, setAssistSession] = useState('');
  const [assistRun, setAssistRun] = useState<AssistRun | null>(null);
  const [assistError, setAssistError] = useState('');
  const [proposal, setProposal] = useState<AssistProposal | null>(null);
  const assistBusy = assistRun?.status === 'running';
  const refining = !!assistSession && assistRun?.status === 'completed';

  const load = useCallback(async () => setWatchers(await api<Watcher[]>('/watchers')), []);
  const loadDetail = useCallback(async (id: number) => setDetail(await api<Watcher>(`/watchers/${id}`)), []);

  useEffect(() => {
    void load().catch(reason => setError((reason as Error).message));
    void api<Preset[]>('/watchers/presets').then(setPresets).catch(() => setPresets([]));
    void api<{ engines: { id: Engine; name: string; enabled: boolean }[] }>('/external-agents/settings')
      .then(value => setEngines(value.engines.filter(engine => engine.enabled))).catch(() => setEngines([]));
  }, [load]);
  useEffect(() => { if (intent?.create && editing === null) begin(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const main = document.querySelector('#main-content');
    main?.classList.toggle('library-graph-mode', Boolean(graph));
    return () => main?.classList.remove('library-graph-mode');
  }, [graph]);

  const visible = useMemo(() => watchers.filter(watcher => !filter || (filter === 'notes-target' ? watcher.target.type === 'note'
    : watcher.target.type === 'collection' && watcher.target.collection_id === filter)), [watchers, filter]);
  useEffect(() => {
    if (editing !== null) return;
    if (selected == null || !watchers.some(watcher => watcher.id === selected)) setSelected(visible[0]?.id ?? null);
  }, [watchers, visible, selected, editing]);
  useEffect(() => { if (selected != null) void loadDetail(selected).catch(() => setDetail(null)); else setDetail(null); }, [selected, loadDetail]);

  const current = detail && detail.id === selected ? detail : null;
  const anyRunning = watchers.some(watcher => watcher.running);

  // While a watcher works: refresh the list, follow the live log and pick up its results at the end.
  useEffect(() => {
    if (!anyRunning) return;
    const timer = window.setInterval(async () => {
      try {
        const list = await api<Watcher[]>('/watchers');
        const finished = watchers.some(old => old.running && !list.find(item => item.id === old.id)?.running);
        setWatchers(list);
        const active = list.find(item => item.id === selected);
        if (active?.running && !active.direct && active.last_run_id) setLive((await api<{ events: Activity[] }>(`/external-agents/runs/${active.last_run_id}`)).events || []);
        if (finished) { if (selected != null) await loadDetail(selected); await refreshData(); publish(); }
      } catch { /* Next tick retries. */ }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [anyRunning, watchers, selected, loadDetail]);

  function begin(watcher?: Watcher) {
    setError('');
    const base = watcher ? Object.fromEntries(DRAFT_KEYS.map(key => [key, watcher[key]])) as Draft
      : blank({ type: 'collection', collection_id: filter && filter !== 'notes-target' ? filter : intent?.collectionId || LIBRARY }, engines[0]?.id || 'claude');
    // Topics and keywords drive the same searches: one list in the form.
    setDraft({ ...base, topics: [] }); setKeywordsText([...base.topics, ...base.keywords].join('\n'));
    setAssistRequest(''); setAssistSession(''); setAssistRun(null); setAssistError(''); setProposal(null);
    setEditing(watcher ? watcher.id : 'new');
  }

  useEffect(() => {
    if (!assistRun || assistRun.status !== 'running') return;
    const timer = window.setInterval(async () => {
      try {
        const next = await api<AssistRun>(`/external-agents/runs/${assistRun.id}`);
        setAssistRun(next);
        if (next.status === 'running') return;
        if (next.status !== 'completed' || !next.response) throw new Error(next.error || 'The assistant could not prepare the watcher.');
        setProposal(parseProposal(next.response));
      } catch (reason) { setAssistError((reason as Error).message); setAssistRun(previous => previous && { ...previous, status: 'failed' }); }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [assistRun?.id, assistRun?.status]);

  const keywords = () => keywordsText.split(/\n|,/).map(item => item.trim()).filter(Boolean);
  async function askAssistant() {
    const engine = draft.engine || engines[0]?.id;
    if (!engine || !assistRequest.trim()) return;
    setAssistError('');
    try {
      const collectionId = draft.target.type === 'collection' ? draft.target.collection_id : 'notes';
      const values = { name: draft.name, task: draft.instructions || draft.description, sources: draft.sources.filter(s => s.type === 'url'), queries: keywords(),
        allow_updates: draft.allow_updates, max_items: draft.max_items, interval_hours: draft.interval_hours };
      const started = await api<{ session_id: string; run: AssistRun }>('/watchers/assist', { method: 'POST',
        body: JSON.stringify({ engine, request: assistRequest.trim(), collection_id: collectionId, draft: values, session_id: assistSession || null }) });
      setAssistSession(started.session_id); setAssistRun(started.run); setAssistRequest('');
    } catch (reason) { setAssistError((reason as Error).message); }
  }
  async function stopAssistant() {
    if (!assistRun) return;
    try { setAssistRun(await api<AssistRun>(`/external-agents/runs/${assistRun.id}/cancel`, { method: 'POST' })); } catch { /* Already finished. */ }
  }
  function useProposal() {
    if (!proposal) return;
    setDraft(previous => ({ ...previous, name: proposal.name || previous.name, instructions: proposal.task, preset: '',
      sources: [...previous.sources.filter(s => s.type !== 'url'), ...proposal.sources.map(s => ({ type: 'url' as const, ...s }))],
      allow_updates: proposal.allow_updates, max_items: proposal.max_items, interval_hours: proposal.interval_hours }));
    setKeywordsText(proposal.queries.join('\n'));
    setProposal(null);
    toast('Settings filled in — review them before saving');
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(previous => ({ ...previous, [key]: value }));
  const hasSource = (type: Source['type']) => draft.sources.some(source => source.type === type);
  const toggleSource = (type: Source['type']) => set('sources', hasSource(type) ? draft.sources.filter(source => source.type !== type)
    : [...draft.sources, type === 'url' ? { type, url: '', label: '' } : { type }]);
  const urlSources = draft.sources.map((source, index) => ({ source, index })).filter(({ source }) => source.type === 'url');
  const setSource = (index: number, patch: Partial<Source>) => set('sources', draft.sources.map((source, i) => i === index ? { ...source, ...patch } : source));

  async function save(event: FormEvent, runAfter = false) {
    event.preventDefault(); setBusy(true); setError('');
    const body = { ...draft, keywords: keywords(), topics: [],
      sources: draft.sources.filter(source => source.type !== 'url' || source.url?.trim()) };
    try {
      const saved = await api<Watcher>(editing === 'new' ? '/watchers' : `/watchers/${editing}`, { method: editing === 'new' ? 'POST' : 'PUT', body: JSON.stringify(body) });
      setEditing(null); setSelected(saved.id);
      if (runAfter) await api(`/watchers/${saved.id}/run`, { method: 'POST' });
      await load(); await loadDetail(saved.id); setTab(runAfter ? 'runs' : 'review');
      toast(runAfter ? 'Watcher saved and started' : 'Watcher saved');
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  async function act(work: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await work(); } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  const runNow = (watcher: Watcher) => act(async () => {
    await api(`/watchers/${watcher.id}/run`, { method: 'POST' });
    setLive([]); setTab(watcher.direct ? 'review' : 'runs'); await load(); await loadDetail(watcher.id);
  });
  const stopRun = (watcher: Watcher) => act(async () => { await api(`/watchers/${watcher.id}/cancel`, { method: 'POST' }); await load(); });
  const toggle = (watcher: Watcher) => act(async () => {
    const body = { ...Object.fromEntries(DRAFT_KEYS.map(key => [key, watcher[key]])), enabled: !watcher.enabled };
    await api(`/watchers/${watcher.id}`, { method: 'PUT', body: JSON.stringify(body) });
    await load(); await loadDetail(watcher.id);
  });
  const remove = (watcher: Watcher) => act(async () => {
    if (!window.confirm(`Delete the watcher “${watcher.name}”? Items it already added are kept.`)) return;
    await api(`/watchers/${watcher.id}`, { method: 'DELETE' });
    setSelected(null); await load();
  });
  const decideChanges = (entry: RunEntry, changes: Change[], decision: 'apply' | 'dismiss') => act(async () => {
    if (!current) return;
    let latest = current;
    for (const change of changes) {
      latest = await api<Watcher>(`/watchers/${current.id}/changes/decide`, { method: 'POST',
        body: JSON.stringify({ run_id: entry.run_id, proposal_id: change.proposal_id, decision }) });
    }
    setDetail(latest); await load();
    if (decision === 'apply') { await refreshData(); publish(); toast(`${changes.length} change(s) applied`); }
  });
  const decideSuggestion = (item: Suggestion, decision: 'saved' | 'dismissed') => act(async () => {
    if (!current) return;
    const result = await api<Watcher & { import_result?: { pdf?: { imported: boolean; error?: string | null } } }>(`/watchers/${current.id}/suggestions/decide`,
      { method: 'POST', body: JSON.stringify({ suggestion_id: item.id, decision }) });
    setDetail(result); await load();
    if (decision === 'saved') {
      await refreshData();
      toast(result.import_result?.pdf?.imported ? 'Article and PDF available in the library' :
        result.import_result?.pdf?.error ? 'Article added; PDF unavailable for now' : 'Article added to the library');
    }
  });

  const pendingRuns = (current?.history || []).map(entry => ({ entry, changes: (entry.changes || []).filter(change => change.status === 'pending') })).filter(group => group.changes.length);
  const applied = (current?.history || []).flatMap(entry => (entry.changes || []).filter(change => change.status === 'applied').map(change => ({ entry, change })))
    .filter(({ change }) => !search || (change.label + ' ' + change.target).toLowerCase().includes(search.toLowerCase()));
  const newSuggestions = (current?.suggestions || []).filter(item => item.status === 'new' && (!reportFilter || item.report_id === reportFilter));
  const handled = (current?.suggestions || []).filter(item => item.status !== 'new');
  const totalPending = watchers.reduce((total, watcher) => total + watcher.pending_count, 0);
  const currentCollection = current?.target.type === 'collection' ? current.target.collection_id : undefined;
  const fieldLabels: Record<string, string> = { title: 'Title', content: 'Content',
    ...Object.fromEntries((collections.find(item => item.id === currentCollection)?.fields || []).map(field => [field.id, field.name || field.id])) };
  const draftDirect = isDirect(draft);
  const selectedCollection = draft.target.type === 'collection' ? collections.find(item => item.id === (draft.target as { collection_id: string }).collection_id) : undefined;

  const editor = <form className="wv-form" onSubmit={event => void save(event)}>
    <div className="view-panel-head watch-editor-head"><h2>{editing === 'new' ? 'New watcher' : `Settings · ${draft.name}`}</h2></div>
    <section className="wv-step"><header><span>1</span><div><strong>What to look for</strong><small>The subject, the search terms and, if useful, library folders whose articles show what interests you.</small></div></header>
      <label>Name<input required maxLength={100} value={draft.name} onChange={event => set('name', event.target.value)} placeholder="E.g. Language models in radiology"/></label>
      <label>Subject <small>The question, the population, what does or does not interest you</small><textarea rows={3} maxLength={3000} value={draft.description} onChange={event => set('description', event.target.value)} placeholder="E.g. Clinical studies evaluating language models that interpret medical images; not purely technical benchmarks."/></label>
      <label>Keywords and search queries <small>One per line or separated by commas · in English for scientific search</small><textarea rows={3} value={keywordsText} onChange={event => setKeywordsText(event.target.value)} placeholder="large language models radiology, multimodal report generation"/></label>
      {state.paperFolders.length > 0 && <fieldset className="wv-folders"><legend>Example articles <small>folders and their subfolders</small></legend>
        <div className="watch-folder-list">{state.paperFolders.map((folder: PaperFolder) => <label key={folder.id}><input type="checkbox" checked={draft.folder_ids.includes(folder.id)}
          onChange={event => set('folder_ids', event.target.checked ? [...draft.folder_ids, folder.id] : draft.folder_ids.filter(id => id !== folder.id))}/><Icon name="folder" size={14}/>{folder.name}</label>)}</div></fieldset>}
    </section>
    <section className="wv-step"><header><span>2</span><div><strong>Where to search</strong><small>Combine as many places as you need.</small></div></header>
      <div className="wv-source-kinds">{(Object.keys(SOURCE_LABELS) as Source['type'][]).map(type => <button type="button" key={type} aria-pressed={hasSource(type)} className={hasSource(type) ? 'active' : ''} onClick={() => toggleSource(type)}>
        <Icon name={SOURCE_LABELS[type][2]} size={15}/><span><strong>{SOURCE_LABELS[type][0]}</strong><small>{SOURCE_LABELS[type][1]}</small></span></button>)}</div>
      {hasSource('scholarly') && <label className="wv-check"><input type="checkbox" checked={draft.semantic_enabled} onChange={event => set('semantic_enabled', event.target.checked)}/> Semantic search (uses the subject and the example articles)</label>}
      {hasSource('url') && <div className="wv-sources">{urlSources.map(({ source, index }) => <div key={index} className="wv-source">
        <input aria-label="Source label" value={source.label || ''} maxLength={120} placeholder="Label" onChange={event => setSource(index, { label: event.target.value })}/>
        <input aria-label="Source URL" value={source.url || ''} type="url" placeholder="https://example.org/search?q={query}" onChange={event => setSource(index, { url: event.target.value })}/>
        <button type="button" className="icon-button" aria-label="Remove the page" onClick={() => set('sources', draft.sources.filter((_, i) => i !== index))}><Icon name="close" size={13}/></button>
      </div>)}
        <button type="button" className="button button-small" disabled={draft.sources.length >= 20} onClick={() => set('sources', [...draft.sources, { type: 'url', url: '', label: '' }])}><Icon name="plus" size={13}/> Add a page</button>
        <p className="wv-hint">Put {'{query}'} in a search URL to run it for every keyword.</p></div>}
    </section>
    <section className="wv-step"><header><span>3</span><div><strong>What to fill</strong><small>A collection (Library, tasks, conferences, your own collections…) or a note completed run after run.</small></div></header>
      <div className="wv-choice">
        <label className={draft.target.type === 'collection' ? 'active' : ''}><input type="radio" checked={draft.target.type === 'collection'} onChange={() => set('target', { type: 'collection', collection_id: LIBRARY })}/><strong>A collection</strong><small>One item per finding.</small></label>
        <label className={draft.target.type === 'note' ? 'active' : ''}><input type="radio" checked={draft.target.type === 'note'} onChange={() => set('target', { type: 'note', note_id: null, position: 'append' })}/><strong>A note</strong><small>A new dated section on each run.</small></label>
      </div>
      {draft.target.type === 'collection' ? <label>Collection<select value={draft.target.collection_id} onChange={event => set('target', { type: 'collection', collection_id: event.target.value })}>
        {collections.map(item => <option key={item.id} value={item.id}>{item.id === LIBRARY ? 'Library (articles)' : item.name}</option>)}</select></label>
        : <div className="wv-grid">
          <label>Note<select required value={draft.target.note_id ?? ''} onChange={event => set('target', { ...(draft.target as Target & { type: 'note' }), note_id: Number(event.target.value) || null })}>
            <option value="">Choose a note</option>{state.notes.filter((note: Note) => !note.trashed_at).sort((a: Note, b: Note) => a.title.localeCompare(b.title)).map((note: Note) => <option key={note.id} value={note.id}>{note.title}</option>)}</select></label>
          <label>Where<select value={draft.target.position} onChange={event => set('target', { ...(draft.target as Target & { type: 'note' }), position: event.target.value as 'append' | 'prepend' })}>
            <option value="append">At the end</option><option value="prepend">At the beginning</option></select></label>
        </div>}
      {!!selectedCollection?.fields?.length && selectedCollection.id !== LIBRARY && <p className="wv-fields">Fields the agent fills: {selectedCollection.fields.map(field => <span key={field.id}>{field.name || field.id}</span>)}</p>}
      {draftDirect ? <p className="wv-hint">Scientific literature → Library runs locally without an agent: articles are scored and wait in “Suggestions” until you add them.</p>
        : <>
          <div className="wv-presets">{presets.map(preset => <button type="button" key={preset.id} className={draft.preset === preset.id ? 'active' : ''}
            onClick={() => setDraft(previous => ({ ...previous, preset: preset.id, name: previous.name || preset.name, instructions: preset.task,
              allow_updates: preset.allow_updates ?? previous.allow_updates, max_items: preset.max_items ?? previous.max_items }))}>
            <strong>{preset.name}</strong><small>{preset.description}</small></button>)}</div>
          <label>Instructions for the agent <small>What to keep, what to ignore, how to fill each field or write the section</small><textarea rows={5} maxLength={8000} value={draft.instructions} onChange={event => set('instructions', event.target.value)}
            placeholder="E.g. Keep only open calls. Fill the deadline, amount and URL from the official page. Ignore calls closing within two weeks."/></label>
        </>}
    </section>
    <section className="wv-assistant" aria-label="Watcher assistant">
      <header><span className="wv-assistant-icon"><Icon name="sparkle" size={15}/></span>
        <div className="wv-assistant-copy"><strong>{refining ? 'Refine with the assistant' : 'Prepare this watcher with AI'}</strong>
          <p>Describe what you want to follow. The assistant reads the target, finds and checks sources, then suggests instructions, pages, queries and schedule. Nothing is saved until you choose.</p></div></header>
      <div className="wv-assistant-input">
        <textarea aria-label="What should this watcher follow?" rows={2} value={assistRequest} disabled={assistBusy || !engines.length} maxLength={4000} onChange={event => setAssistRequest(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void askAssistant(); } }}
          placeholder={engines.length ? (refining ? 'E.g. Only calls above €100k, and add the national agency portals.' : `E.g. What is new on my subject for ${targetName(draft.target)}.`) : 'Enable an agent in Settings → AI and agents to use the assistant.'}/>
        <div className="wv-assistant-actions">
          {assistBusy ? <button type="button" className="button" onClick={() => void stopAssistant()}>Stop</button>
            : <button type="button" className="button button-primary" disabled={!assistRequest.trim() || !engines.length} onClick={() => void askAssistant()}><Icon name="sparkle" size={13}/>{refining ? 'Refine' : 'Prepare'}</button>}
        </div>
      </div>
      {assistBusy && <p className="wv-assistant-status" role="status"><span className="wv-dot"/>{assistRun?.events?.filter(event => event.kind === 'tool').slice(-1)[0]?.label || 'Reading the target'}… this can take a few minutes.</p>}
      {assistError && <p className="watch-alert" role="alert">{assistError}</p>}
      {proposal && <div className="wv-proposal">
        <p className="wv-proposal-why">{proposal.explanation || 'Review these settings before using them.'}</p>
        <dl>
          {proposal.name && <div><dt>Name</dt><dd>{proposal.name}</dd></div>}
          <div><dt>Instructions</dt><dd className="wv-proposal-task">{proposal.task}</dd></div>
          <div><dt>Pages</dt><dd>{proposal.sources.length ? <ul>{proposal.sources.map(source => <li key={source.url}>{source.label && <strong>{source.label} · </strong>}<a href={source.url.replace('{query}', encodeURIComponent(proposal.queries[0] || ''))} target="_blank" rel="noreferrer">{source.url}</a></li>)}</ul> : 'Web search'}</dd></div>
          <div><dt>Queries</dt><dd className="wv-fields">{proposal.queries.length ? proposal.queries.map(query => <span key={query}>{query}</span>) : '—'}</dd></div>
          <div><dt>Schedule</dt><dd>{frequency(proposal.interval_hours)} · up to {proposal.max_items} items · {proposal.allow_updates ? 'may update existing items' : 'adds only'}</dd></div>
        </dl>
        <div className="wv-proposal-actions"><button type="button" className="button" onClick={() => setProposal(null)}>Ignore</button>
          <button type="button" className="button button-primary" onClick={useProposal}>Use these settings</button></div>
      </div>}
    </section>
    <section className="wv-step"><header><span>4</span><div><strong>How results are applied</strong></div></header>
      {!draftDirect && <div className="wv-choice">
        <label className={draft.apply_mode === 'review' ? 'active' : ''}><input type="radio" checked={draft.apply_mode === 'review'} onChange={() => set('apply_mode', 'review')}/><strong>Review first</strong><small>Findings wait in “To review”.</small></label>
        <label className={draft.apply_mode === 'auto' ? 'active' : ''}><input type="radio" checked={draft.apply_mode === 'auto'} onChange={() => set('apply_mode', 'auto')}/><strong>Apply directly</strong><small>Added as soon as they are found.</small></label>
      </div>}
      <div className="wv-grid">
        {!draftDirect && draft.target.type === 'collection' && <label className="wv-check"><input type="checkbox" checked={draft.allow_updates} onChange={event => set('allow_updates', event.target.checked)}/> Allow updating existing items</label>}
        <label>{draftDirect ? 'Articles suggested per run' : 'Max findings per run'}<input type="number" min={1} max={50} value={draft.max_items} onChange={event => set('max_items', Number(event.target.value))}/></label>
      </div>
    </section>
    <section className="wv-step"><header><span>5</span><div><strong>Schedule{draftDirect ? '' : ' and agent'}</strong></div></header>
      <div className="wv-grid wv-grid-4">
        <label>Frequency<select value={draft.interval_hours} onChange={event => set('interval_hours', Number(event.target.value))}>{INTERVALS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {!draftDirect && <>
          <label>Agent<select value={draft.engine} onChange={event => set('engine', event.target.value as Engine)}>{engines.length ? engines.map(engine => <option key={engine.id} value={engine.id}>{engine.name}</option>) : <option value={draft.engine}>No agent enabled</option>}</select></label>
          <label>Model<input value={draft.model} maxLength={200} onChange={event => set('model', event.target.value)} placeholder="Default (optional)"/></label>
          <label>Time limit (min)<input type="number" min={5} max={120} value={draft.timeout_minutes} onChange={event => set('timeout_minutes', Number(event.target.value))}/></label>
        </>}
      </div>
      <label className="wv-check"><input type="checkbox" checked={draft.enabled} onChange={event => set('enabled', event.target.checked)}/> Run automatically while Kavot is open</label>
    </section>
    <footer className="wv-form-actions">
      <button type="button" className="button" onClick={() => setEditing(null)}>Cancel</button>
      <button type="button" className="button" disabled={busy || (!draftDirect && !engines.length)} onClick={event => void save(event as unknown as FormEvent, true)}>Save and run now</button>
      <button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
    </footer>
  </form>;

  const empty = (icon: string, title: string, text: string) => <div className="watch-empty"><Icon name={icon} size={26}/><h3>{title}</h3><p>{text}</p></div>;
  const reviewTab = current?.direct
    ? <>{reportFilter && <div className="watch-subhead"><h3>Report articles</h3><button type="button" className="button button-small" style={{ marginLeft: 'auto' }} onClick={() => setReportFilter(null)}>All suggestions</button></div>}
      {newSuggestions.length ? <SuggestionTable items={newSuggestions} handled={false} busy={busy} resetKey={`${current.id}|new|${reportFilter}`} onDecide={(item, decision) => void decideSuggestion(item, decision)} onGraph={setGraph}/>
        : empty('search', 'No new articles', reportFilter ? 'The articles in this report have already been handled.' : 'Run a search or wait for the next scheduled one.')}</>
    : !pendingRuns.length ? empty('check', 'Nothing to review', current?.apply_mode === 'auto' ? 'This watcher applies its findings directly; see Results.' : 'Findings of the next runs will wait here for your approval.')
    : <div className="wv-scroll">{pendingRuns.map(({ entry, changes }) => <section key={entry.run_id} className="wv-group">
      <header><strong>Run of {when(entry.finished_at || entry.started_at)}</strong><span>{changes.length} change(s)</span>
        <button type="button" className="button button-small button-primary" disabled={busy || current?.running} onClick={() => void decideChanges(entry, changes, 'apply')}>Apply all</button>
        <button type="button" className="button button-small" disabled={busy || current?.running} onClick={() => void decideChanges(entry, changes, 'dismiss')}>Dismiss all</button></header>
      {changes.map(change => <article key={change.proposal_id} className="wv-change">
        <div className="wv-change-head"><span className={'wv-kind ' + verb(change.kind).toLowerCase()}>{verb(change.kind)}</span><strong>{change.label}</strong>{change.target !== currentCollection && <small>{change.target}</small>}
          <span className="wv-change-actions"><button type="button" className="button button-small button-primary" disabled={busy || current?.running} onClick={() => void decideChanges(entry, [change], 'apply')}>Apply</button>
            <button type="button" className="button button-small" disabled={busy || current?.running} onClick={() => void decideChanges(entry, [change], 'dismiss')}>Dismiss</button></span></div>
        <ChangeValues change={change} labels={fieldLabels}/>
      </article>)}
    </section>)}</div>;

  const resultsTab = <>
    <div className="wv-toolbar"><input type="search" aria-label="Filter results" placeholder="Filter results…" value={search} onChange={event => setSearch(event.target.value)}/><span>{applied.length} item(s)</span></div>
    {!applied.length ? empty('search', 'No results yet', 'Items the watcher adds or updates appear here once applied.')
      : <div className="wv-scroll"><table className="wv-table"><thead><tr><th>Item</th><th>Change</th><th>Run</th><th/></tr></thead><tbody>
        {applied.map(({ entry, change }) => { const target = changeTarget(change); return <tr key={change.proposal_id}>
          <td><strong>{itemTitle(change, currentCollection)}</strong><small>{change.label}</small></td>
          <td><span className={'wv-kind ' + verb(change.kind).toLowerCase()}>{verb(change.kind)}</span></td>
          <td>{when(entry.finished_at || entry.started_at)}</td>
          <td>{target && <button type="button" className="button button-small" onClick={() => openCollectionItem(target)}>Open</button>}</td>
        </tr>; })}</tbody></table></div>}
  </>;

  const runsTab = !current?.history.length ? empty('calendar', 'No run yet', 'Use “Run now” to try the watcher.')
    : <div className="wv-scroll">{current.history.map((entry, index) => {
      const running = entry.status === 'running' && index === 0 && current.running;
      const events = running ? live : entry.events || [];
      return <article key={entry.run_id} className={'wv-run ' + entry.status}>
        <header><span className={'wv-status ' + entry.status}>{running ? 'Running' : entry.status === 'completed' ? 'Completed' : entry.status === 'failed' ? 'Failed' : entry.status === 'running' ? 'Interrupted' : 'Stopped'}</span>
          <strong>{when(entry.started_at || entry.finished_at)}</strong>
          <small>{entry.mode === 'search' ? `scientific search · ${entry.pending} new article(s)` : `${entry.mode === 'auto' ? 'applies directly' : 'review first'} · ${entry.applied} applied${entry.pending ? ` · ${entry.pending} to review` : ''}`}</small>
          {entry.pending > 0 && <button type="button" className="text-link" onClick={() => setTab('review')}>Review →</button>}</header>
        {entry.summary && <div className="wv-report"><AgentMessageContent content={entry.summary}/></div>}
        {events.length > 0 && <details className="wv-log" open={running}><summary>Activity ({events.length})</summary>
          <ol>{events.slice(-60).map(event => <li key={event.id} className={event.kind}><strong>{event.label}</strong>{event.detail && <span>{event.detail.slice(0, 300)}</span>}</li>)}</ol></details>}
      </article>;
    })}</div>;

  if (graph) return <div className="library-graph-view"><CitationGraph key={graph.id} paper={graphSeed(graph)} onBack={() => setGraph(null)} backLabel="Back to the watcher"/></div>;

  const tabs: [Tab, string, number | undefined][] = current?.direct
    ? [['review', 'Suggestions', newSuggestions.length], ['reports', 'Reports', current.reports?.length || 0], ['handled', 'Handled', handled.length], ['runs', 'Runs', current.history.length]]
    : [['review', 'To review', current?.pending_count], ['results', 'Results', current?.applied_count], ['runs', 'Runs', current?.history.length]];
  const targets = [{ id: '', name: 'All targets' }, ...collections.map(item => ({ id: item.id, name: item.id === LIBRARY ? 'Library' : item.name })), { id: 'notes-target', name: 'Notes' }];

  return <ViewPage className="watch-view watchers-view" label="Watchers">
    <ViewHeader icon="sparkle" title="Watchers" count={watchers.length}
      subtitle={`${watchers.filter(item => item.enabled).length} active · ${totalPending} to review${anyRunning ? ' · running' : ''}`}>
      <button className="button button-primary" onClick={() => begin()}><Icon name="plus" size={14}/> New watcher</button>
    </ViewHeader>
    <div className="view-body">
      <aside className="view-panel watch-rail" aria-label="Watchers">
        <div className="view-panel-head"><select aria-label="Filter by target" className="wv-filter" value={filter} onChange={event => { setFilter(event.target.value); setSelected(null); }}>
          {targets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
        <div className="watch-agent-list">
          {visible.map(watcher => <div key={watcher.id} className={`watch-agent-row${watcher.id === selected && editing === null ? ' active' : ''}`}>
            <button type="button" className="discovery-exploration-open watch-agent-open" title={watcher.name} onClick={() => { setSelected(watcher.id); setEditing(null); setError(''); setReportFilter(null); setTab('review'); }}>
              <strong>{watcher.running && <span className="wv-dot" aria-label="Running"/>}{watcher.name}</strong>
              <small>{targetName(watcher.target)} · {watcher.enabled && watcher.interval_hours ? frequency(watcher.interval_hours) : watcher.enabled ? 'Manual' : 'Paused'}</small>
            </button>
            {watcher.pending_count > 0 && <b className="watch-agent-badge" title="To review">{watcher.pending_count}</b>}
          </div>)}
          {!visible.length && <p className="fit-empty">{filter ? 'No watcher for this target.' : 'No watcher yet.'}</p>}
        </div>
        <button type="button" className="watch-rail-add" onClick={() => begin()}><Icon name="plus" size={14}/> New watcher</button>
      </aside>
      <section className="view-panel watch-main" aria-label="Watcher">
        {error && <p className="watch-alert" role="alert">{error}</p>}
        {editing !== null ? <div className="watch-editor">{editor}</div>
        : current ? <>
          <div className="view-panel-head watch-detail-head">
            <h2 className="watch-detail-title" title={current.description || current.instructions}>{current.name}</h2>
            <span className="watch-detail-meta">{current.sources.map(source => SOURCE_LABELS[source.type][0]).filter((v, i, all) => all.indexOf(v) === i).join(' + ')} → {targetName(current.target)} · {current.enabled && current.interval_hours ? frequency(current.interval_hours) : current.enabled ? 'Manual' : 'Paused'} · last {when(current.last_run_at)}{current.next_run_at ? ` · next ${when(current.next_run_at)}` : ''}</span>
            <span className="watch-detail-actions">
              <button type="button" className="discovery-icon-button" aria-label="Watcher settings" title="Settings" onClick={() => begin(current)}><Icon name="settings" size={14}/></button>
              <button type="button" className="button button-small" disabled={busy} onClick={() => void toggle(current)}>{current.enabled ? 'Pause' : 'Resume'}</button>
              {current.running && !current.direct ? <button type="button" className="button button-small" disabled={busy} onClick={() => void stopRun(current)}>Stop</button>
                : <button type="button" className="button button-primary watch-run-button" disabled={busy || current.running || (!current.direct && !engines.length)} onClick={() => void runNow(current)}><Icon name="search" size={13}/>{current.running ? 'Searching…' : 'Run now'}</button>}
            </span>
          </div>
          {current.last_error && <p className="watch-alert" role="status">{current.last_error}</p>}
          {!current.direct && !engines.length && <p className="watch-alert" role="status">Enable Claude Code, Codex or OpenCode in Settings → AI and agents to run this watcher.</p>}
          <nav className="watch-tabs" aria-label="Watcher content">{tabs.map(([id, label, count]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label} <span>{count ?? 0}</span></button>)}</nav>
          <section className="watch-panel">{tab === 'review' ? reviewTab
            : tab === 'reports' ? <ReportList reports={current.reports || []} onShow={report => { setReportFilter(report.id); setTab('review'); }}/>
            : tab === 'handled' ? (handled.length ? <SuggestionTable items={handled} handled busy={busy} resetKey={`${current.id}|handled`} onDecide={(item, decision) => void decideSuggestion(item, decision)} onGraph={setGraph}/> : empty('check', 'No handled articles', 'Your decisions will appear here.'))
            : tab === 'results' ? resultsTab : runsTab}</section>
          <div className="watch-danger-zone"><button className="text-link" disabled={busy} onClick={() => void remove(current)}>Delete this watcher (added items are kept)</button></div>
        </> : <div className="watch-welcome"><span className="watch-welcome-icon"><Icon name="sparkle" size={28}/></span>
          <h2>Watchers keep your research up to date</h2>
          <p>Choose what to look for, where to search (scientific literature, the web, specific pages) and what to fill: the Library, any collection, or a note completed run after run.</p>
          <button className="button button-primary" onClick={() => begin()}><Icon name="plus" size={16}/> Create a watcher</button></div>}
      </section>
    </div>
  </ViewPage>;
}
