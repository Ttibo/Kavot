import { useEffect, useState, type FormEvent } from 'react';
import { useRuntime } from '../../app/runtime';
import { refreshState, toast } from '../../app/navigation';
import { publish } from '../../app/viewBridge';
import { Icon } from '../../components/Icon';
import { api } from '../../services/api';
import { ReportList, SuggestionTable, type Suggestion } from './Suggestions';
import { draftOf, newSuggestions, type ArticleWatch, type ArticleWatchesState, type WatchDraft, type WatchesIntent } from './useArticleWatches';

type Tab = 'new' | 'handled' | 'reports';
type DecideResult = ArticleWatch & { import_result?: { pdf?: { imported?: boolean; error?: string | null } } };

const when = (value?: string | null) => value
  ? new Date(value).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never';
const blank = (): WatchDraft => ({ name: '', description: '', topics: [], keywords: [], folder_ids: [], semantic_enabled: true, enabled: true, max_suggestions: 10 });
const empty = (icon: string, title: string, text: string) => <div className="watch-empty"><Icon name={icon} size={26}/><h3>{title}</h3><p>{text}</p></div>;

/** Library folders in tree order, indented, for the example-articles choice. */
function folderTree(folders: PaperFolder[], parentId: number | null = null, depth = 0, seen = new Set<number>()): { folder: PaperFolder; depth: number }[] {
  return folders.filter(folder => folder.parent_id === parentId && !seen.has(folder.id))
    .flatMap(folder => [{ folder, depth }, ...folderTree(folders, folder.id, depth + 1, new Set([...seen, folder.id]))]);
}

/** Article watches, inside the Library: the watches on the left, the selected one's suggestions and reports on the right. */
export function ArticleWatches({ data, intent, onGraph }: { data: ArticleWatchesState; intent: (WatchesIntent & { at: number }) | null; onGraph: (item: Suggestion) => void }) {
  const { state } = useRuntime();
  const { watches, error, setError, load, replace } = data;
  const [selected, setSelected] = useState<number | null>(intent?.watchId ?? null);
  const [editing, setEditing] = useState<number | 'new' | null>(intent?.create ? 'new' : null);
  const [draft, setDraft] = useState<WatchDraft>(blank);
  const [keywordsText, setKeywordsText] = useState('');
  const [tab, setTab] = useState<Tab>('new');
  const [reportFilter, setReportFilter] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<number | null>(null);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!intent) return;
    if (intent.create) begin();
    else if (intent.watchId != null) { setEditing(null); setSelected(intent.watchId); setTab('new'); }
  }, [intent?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!watches || editing !== null) return;
    if (selected == null || !watches.some(watch => watch.id === selected)) setSelected(watches[0]?.id ?? null);
  }, [watches, selected, editing]);

  const current = watches?.find(watch => watch.id === selected) || null;
  const set = <K extends keyof WatchDraft>(key: K, value: WatchDraft[K]) => setDraft(previous => ({ ...previous, [key]: value }));
  const keywords = () => [...new Set(keywordsText.split(/\n|,/).map(item => item.trim()).filter(Boolean))];

  function begin(watch?: ArticleWatch) {
    setError('');
    const base = watch ? draftOf(watch) : blank();
    // Topics and keywords drive the same searches: one list in the form.
    setDraft({ ...base, topics: [] });
    setKeywordsText([...base.topics, ...base.keywords].join('\n'));
    setEditing(watch ? watch.id : 'new');
  }

  async function act(work: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await work(); } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  async function runWatch(watch: ArticleWatch) {
    setRunning(watch.id); setError('');
    try {
      const result = await api<ArticleWatch>(`/article-watches/${watch.id}/run`, { method: 'POST' });
      replace(result); setReportFilter(null); setTab('new');
      const found = result.reports?.[0]?.new_count ?? 0;
      toast(found ? `${found} new ${found === 1 ? 'article' : 'articles'} suggested` : 'No new articles this time');
    } catch (reason) {
      setError((reason as Error).message);
      await load();
    } finally { setRunning(null); }
  }

  async function save(event: FormEvent, runAfter = false) {
    event.preventDefault();
    const list = keywords();
    // Short entries are keywords; longer ones (up to 200 characters) are kept as topics.
    const body = { ...draft, keywords: list.filter(item => item.length <= 100), topics: list.filter(item => item.length > 100) };
    if (body.keywords.length > 20 || body.topics.length > 12) { setError('Use at most 20 keywords.'); return; }
    if (body.topics.some(item => item.length > 200)) { setError('Keep each keyword under 200 characters.'); return; }
    setBusy(true); setError('');
    try {
      const saved = await api<ArticleWatch>(editing === 'new' ? '/article-watches' : `/article-watches/${editing}`,
        { method: editing === 'new' ? 'POST' : 'PUT', body: JSON.stringify(body) });
      replace(saved); setEditing(null); setSelected(saved.id); setTab('new'); setReportFilter(null);
      toast('Watch saved');
      setBusy(false);
      if (runAfter) await runWatch(saved);
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  const toggle = (watch: ArticleWatch) => act(async () => {
    replace(await api<ArticleWatch>(`/article-watches/${watch.id}`, { method: 'PUT', body: JSON.stringify({ ...draftOf(watch), enabled: !watch.enabled }) }));
  });
  const remove = (watch: ArticleWatch) => act(async () => {
    if (!window.confirm(`Delete the watch “${watch.name}”? Articles already added to the library are kept.`)) return;
    await api(`/article-watches/${watch.id}`, { method: 'DELETE' });
    setSelected(null); await load();
  });
  const decide = (item: Suggestion, decision: 'saved' | 'dismissed') => act(async () => {
    if (!current) return;
    const { import_result: imported, ...result } = await api<DecideResult>(`/article-watches/${current.id}/suggestions/decide`,
      { method: 'POST', body: JSON.stringify({ suggestion_id: item.id, decision }) });
    replace(result);
    if (decision === 'saved') {
      await refreshState(['papers']); publish();
      toast(imported?.pdf?.imported ? 'Article and PDF added to the library' : imported?.pdf?.error ? 'Article added; PDF unavailable for now' : 'Article added to the library');
    }
  });

  const folders = folderTree(state.paperFolders as PaperFolder[]);
  const editor = <form className="aw-form" onSubmit={event => void save(event)}>
    <div className="view-panel-head"><h2>{editing === 'new' ? 'New watch' : `Edit · ${draft.name}`}</h2></div>
    <div className="aw-form-body">
      <label>Name<input required maxLength={100} value={draft.name} onChange={event => set('name', event.target.value)} placeholder="E.g. Language models in radiology"/></label>
      <label>Subject <small>The question, the population, what does or does not interest you</small>
        <textarea rows={3} maxLength={3000} value={draft.description} onChange={event => set('description', event.target.value)} placeholder="E.g. Clinical studies evaluating language models that interpret medical images; not purely technical benchmarks."/></label>
      <label>Keywords and search queries <small>One per line or separated by commas · in English works best</small>
        <textarea rows={3} value={keywordsText} onChange={event => setKeywordsText(event.target.value)} placeholder="large language models radiology, multimodal report generation"/></label>
      {folders.length > 0 && <fieldset className="aw-folders"><legend>Example articles <small>folders whose articles show what interests you (subfolders included)</small></legend>
        <div className="watch-folder-list">{folders.map(({ folder, depth }) => <label key={folder.id} style={depth ? { marginLeft: depth * 14 } : undefined}>
          <input type="checkbox" checked={draft.folder_ids.includes(folder.id)}
            onChange={event => set('folder_ids', event.target.checked ? [...draft.folder_ids, folder.id] : draft.folder_ids.filter(id => id !== folder.id))}/>
          <Icon name="folder" size={13}/>{folder.name}</label>)}</div></fieldset>}
      <div className="aw-form-row">
        <label className="aw-check"><input type="checkbox" checked={draft.semantic_enabled} onChange={event => set('semantic_enabled', event.target.checked)}/> Semantic search <small>uses the subject and the example articles</small></label>
        <label className="aw-check"><input type="checkbox" checked={draft.enabled} onChange={event => set('enabled', event.target.checked)}/> Search automatically every week</label>
        <label className="aw-number">Articles per run<input type="number" min={1} max={30} value={draft.max_suggestions} onChange={event => set('max_suggestions', Math.min(30, Math.max(1, Number(event.target.value) || 1)))}/></label>
      </div>
      <p className="aw-hint">Searches OpenAlex for recent articles. Suggestions wait here until you add them to the library or dismiss them.</p>
    </div>
    <footer className="aw-form-actions">
      <button type="button" className="button" onClick={() => { setEditing(null); setError(''); }}>Cancel</button>
      <button type="button" className="button" disabled={busy || running !== null} onClick={event => void save(event as unknown as FormEvent, true)}>Save and run</button>
      <button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
    </footer>
  </form>;

  const fresh = (current?.suggestions || []).filter(item => item.status === 'new' && (!reportFilter || item.report_id === reportFilter));
  const handled = (current?.suggestions || []).filter(item => item.status !== 'new');
  const isRunning = current != null && running === current.id;
  const tabs: [Tab, string, number][] = [['new', 'New', fresh.length], ['handled', 'Handled', handled.length], ['reports', 'Reports', current?.reports?.length || 0]];

  return <div className="article-watches">
    <aside className="view-panel aw-rail" aria-label="Watches">
      <div className="aw-list">
        {(watches || []).map(watch => { const count = newSuggestions(watch); return <div key={watch.id} className={`watch-agent-row${watch.id === selected && editing === null ? ' active' : ''}`}>
          <button type="button" className="discovery-exploration-open" title={watch.description || watch.name}
            onClick={() => { setSelected(watch.id); setEditing(null); setError(''); setReportFilter(null); setTab('new'); }}>
            <strong>{running === watch.id && <span className="aw-dot" aria-label="Searching"/>}{watch.name}</strong>
            <small>{watch.last_error ? 'Last run failed' : `Last run ${when(watch.last_run_at)}`}</small>
          </button>
          {count > 0 && <b className="watch-agent-badge" title={`${count} new ${count === 1 ? 'suggestion' : 'suggestions'}`}>{count}</b>}
          <label className="aw-switch" title={watch.enabled ? 'Weekly search on — click to pause' : 'Paused — click to search weekly'}>
            <input type="checkbox" checked={watch.enabled} disabled={busy} aria-label={`Weekly search for ${watch.name}`} onChange={() => void toggle(watch)}/><span/></label>
        </div>; })}
        {watches && !watches.length && <p className="aw-rail-empty">No watch yet.</p>}
        {!watches && !error && <p className="aw-rail-empty">Loading…</p>}
      </div>
      <button type="button" className="watch-rail-add" onClick={() => begin()}><Icon name="plus" size={14}/> New watch</button>
    </aside>
    <section className="view-panel aw-main" aria-label="Watch">
      {error && <p className="watch-alert" role="alert">{error}</p>}
      {editing !== null ? editor
      : current ? <>
        <div className="view-panel-head aw-head">
          <div className="aw-head-title"><h2 title={current.name}>{current.name}</h2>
            <small>{current.enabled ? 'Weekly' : 'Paused'} · last run {when(current.last_run_at)}{[...current.topics, ...current.keywords].length ? ` · ${[...current.topics, ...current.keywords].slice(0, 4).join(', ')}` : ''}</small></div>
          <span className="aw-head-actions">
            <button type="button" className="icon-button" aria-label="Edit the watch" title="Edit" onClick={() => begin(current)}><Icon name="settings" size={14}/></button>
            <button type="button" className="icon-button" aria-label="Delete the watch" title="Delete" disabled={busy} onClick={() => void remove(current)}><Icon name="trash" size={14}/></button>
            <button type="button" className="button button-primary" disabled={running !== null} onClick={() => void runWatch(current)}><Icon name="search" size={13}/>{isRunning ? 'Searching…' : 'Run now'}</button>
          </span>
        </div>
        {current.last_error && !error && <p className="watch-alert" role="status">{current.last_error}</p>}
        <nav className="watch-tabs" aria-label="Watch content">{tabs.map(([id, label, count]) =>
          <button key={id} className={tab === id ? 'active' : ''} aria-pressed={tab === id} onClick={() => { setTab(id); if (id !== 'new') setReportFilter(null); }}>{label} <span>{count}</span></button>)}</nav>
        <section className="watch-panel">
          {tab === 'new' ? <>
            {reportFilter && <div className="aw-filter"><span>Articles from one report</span><button type="button" className="text-link" onClick={() => setReportFilter(null)}>Show all</button></div>}
            {fresh.length ? <SuggestionTable items={fresh} handled={false} busy={busy} resetKey={`${current.id}|new|${reportFilter}`} onDecide={(item, decision) => void decide(item, decision)} onGraph={onGraph}/>
              : empty('search', isRunning ? 'Searching…' : 'No new articles', isRunning ? 'This can take a minute.' : reportFilter ? 'The articles of this report have already been handled.' : 'Run a search, or wait for the next weekly one.')}
          </>
          : tab === 'handled' ? (handled.length ? <SuggestionTable items={handled} handled busy={busy} resetKey={`${current.id}|handled`} onDecide={(item, decision) => void decide(item, decision)} onGraph={onGraph}/>
            : empty('check', 'Nothing handled yet', 'Articles you add or dismiss appear here.'))
          : <ReportList reports={current.reports || []} onShow={report => { setReportFilter(report.id); setTab('new'); }}/>}
        </section>
      </> : watches && <div className="watch-welcome"><span className="watch-welcome-icon"><Icon name="sparkle" size={26}/></span>
        <h2>Keep up with new articles</h2>
        <p>A watch searches the literature every week for your subject, keywords and example articles, and suggests what is new. You decide what goes into the library.</p>
        <button className="button button-primary" onClick={() => begin()}><Icon name="plus" size={14}/> New watch</button></div>}
    </section>
  </div>;
}
