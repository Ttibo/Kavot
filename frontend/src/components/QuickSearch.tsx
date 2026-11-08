import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useOptionalRuntime } from '../app/runtime';
import { Icon } from './Icon';
import '../styles/components/quick-search.css';

/** A file or a note of the workspace, as the search sees it. */
type Entry = {
  key: string; name: string; folder: string; path: string; kind: string; extension: string;
  noteId?: number; url?: string; text: string;
  /** The text, folded once for searching (not on every keystroke). */
  foldedText: string;
};
type Hit = { entry: Entry; score: number; nameMatches: number[]; line?: string };

const fold = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const plain = (html: string) => {
  const element = document.createElement('div');
  element.innerHTML = html || '';
  element.querySelectorAll('script, style').forEach(node => node.remove());
  return (element.innerText || element.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
};

/** Every note and file of the tree (the trash left out), with the folder that holds it. */
function collect(tree: any[], notes: any[]): Entry[] {
  const byId = new Map(notes.map(note => [Number(note.id), note]));
  const entries: Entry[] = [];
  const walk = (nodes: any[], folder: string[]) => {
    for (const node of nodes || []) {
      if (node.path === 'trash' || node.trashed) continue;
      const label = String(node.label || node.name || '');
      if (node.kind === 'directory') {
        // The roots of the vault ("notes", "General") are not folders the user made.
        const own = node.root || ['notes/general', 'notes/projects', 'notes/daily'].includes(node.path);
        walk(node.children, own ? folder : [...folder, label]);
        continue;
      }
      if (node.shortcut) continue;
      const note = node.note_id ? byId.get(Number(node.note_id)) : null;
      const name = note?.title || label;
      const file = String(node.name || node.path || '');
      const extension = note ? 'note' : (file.match(/\.([^./]+)$/)?.[1] || node.kind || '').toLowerCase();
      entries.push({
        key: node.note_id ? `note:${node.note_id}` : `file:${node.path}`, name, folder: folder.join(' / '), path: node.path,
        kind: note ? (note.drawing ? 'drawing' : 'note') : node.kind || 'file', extension,
        noteId: note ? Number(note.id) : undefined, url: node.url, text: '', foldedText: '',
      });
      if (note) { const entry = entries[entries.length - 1]; entry.text = plain(note.content); entry.foldedText = fold(entry.text); }
    }
  };
  walk(tree, []);
  return entries;
}

/** Fuzzy match like a file finder: the letters of the query in order, closer and at word starts score higher. */
function fuzzy(query: string, target: string): { score: number; matches: number[] } | null {
  const text = fold(target);
  const matches: number[] = [];
  let score = 0, from = 0, previous = -2;
  for (const char of query) {
    if (char === ' ') continue;
    const index = text.indexOf(char, from);
    if (index < 0) return null;
    const wordStart = index === 0 || /[\s/_.\-()]/.test(text[index - 1]);
    score += 1 + (index === previous + 1 ? 4 : 0) + (wordStart ? 3 : 0);
    matches.push(index);
    previous = index;
    from = index + 1;
  }
  return { score: score - target.length * 0.02, matches };
}

function search(entries: Entry[], raw: string): Hit[] {
  const query = fold(raw.trim());
  if (!query) return entries.slice(0, 60).map(entry => ({ entry, score: 0, nameMatches: [] }));
  const words = query.split(/\s+/).filter(Boolean);
  const hits: Hit[] = [];
  for (const entry of entries) {
    const name = fuzzy(query, entry.name);
    const full = name ? null : fuzzy(query, `${entry.folder} ${entry.name} ${entry.extension}`);
    let best: Hit | null = name ? { entry, score: name.score + 20, nameMatches: name.matches }
      : full ? { entry, score: full.score, nameMatches: [] } : null;
    // Inside the notes: every word present, scored below a match on the name.
    if (!best && entry.text) {
      const body = entry.foldedText;
      if (words.every(word => body.includes(word))) {
        const at = body.indexOf(words[0]);
        const start = entry.text.lastIndexOf('\n', at) + 1;
        const end = entry.text.indexOf('\n', at);
        best = { entry, score: 2, nameMatches: [], line: entry.text.slice(start, end < 0 ? undefined : end).trim().slice(0, 160) };
      }
    }
    if (best) hits.push(best);
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 80);
}

const ICONS: Record<string, string> = { note: 'notes', drawing: 'canvas', canvas: 'canvas', pdf: 'papers', image: 'eye' };

function highlight(text: string, matches: number[]): ReactNode {
  if (!matches.length) return text;
  const set = new Set(matches);
  return [...text].map((char, index) => set.has(index) ? <mark key={index}>{char}</mark> : char);
}

function markWords(text: string, query: string): ReactNode {
  const words = fold(query.trim()).split(/\s+/).filter(word => word.length > 1);
  if (!words.length) return text;
  const folded = fold(text);
  const parts: ReactNode[] = [];
  let index = 0;
  while (index < text.length) {
    const next = words.map(word => ({ word, at: folded.indexOf(word, index) })).filter(item => item.at >= 0).sort((a, b) => a.at - b.at)[0];
    if (!next) { parts.push(text.slice(index)); break; }
    parts.push(text.slice(index, next.at), <mark key={next.at}>{text.slice(next.at, next.at + next.word.length)}</mark>);
    index = next.at + next.word.length;
  }
  return parts;
}

const TEXT_FILES = /^(md|txt|csv|tsv|json|html|py|js|ts|tex|bib|yaml|yml)$/;

function Preview({ hit, query }: { hit: Hit | null; query: string }) {
  const [text, setText] = useState<string | null>(null);
  const entry = hit?.entry;
  useEffect(() => {
    setText(null);
    if (!entry || entry.noteId || !entry.url || !TEXT_FILES.test(entry.extension)) return;
    const controller = new AbortController();
    fetch(entry.url, { signal: controller.signal }).then(response => response.ok ? response.text() : '')
      .then(body => setText(body.slice(0, 6000))).catch(() => undefined);
    return () => controller.abort();
  }, [entry?.key]);
  if (!entry) return <div className="qs-preview qs-preview-empty">No result</div>;
  const body = entry.noteId ? entry.text : text;
  return <div className="qs-preview">
    <header><Icon name={ICONS[entry.kind] || 'notes'} size={14}/><strong>{entry.name}</strong><small>{entry.folder || 'Top level'}</small></header>
    {entry.kind === 'image' && entry.url ? <img src={entry.url} alt=""/>
      : body ? <pre>{markWords(body.slice(0, 6000), query)}</pre>
      : <p className="qs-preview-empty">{body === '' ? 'Empty note.' : `${entry.extension.toUpperCase() || 'File'} · Enter to open it.`}</p>}
  </div>;
}

/** The finder of notes and files: type a name, a folder, an extension or words of a note; ↑↓ to move, Enter to open. */
export function QuickSearch() {
  const runtime = useOptionalRuntime();
  const state = runtime?.state;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const show = () => { setOpen(true); setSelected(0); };
    const shortcut = (event: globalThis.KeyboardEvent) => {
      const key = event.key.toLowerCase();
      // Ctrl+F, Ctrl+P or Ctrl+Shift+F (Cmd on macOS).
      if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === 'f' || key === 'p' && !event.shiftKey)) { event.preventDefault(); show(); }
    };
    window.addEventListener('kavot:open-search', show);
    document.addEventListener('keydown', shortcut);
    return () => { window.removeEventListener('kavot:open-search', show); document.removeEventListener('keydown', shortcut); };
  }, []);
  useEffect(() => { if (open) setTimeout(() => input.current?.select()); }, [open]);

  const entries = useMemo(() => open ? collect(state?.workspaceTree || [], state?.notes || []) : [], [open, state?.workspaceTree, state?.notes]);
  const hits = useMemo(() => search(entries, query), [entries, query]);
  const current = hits[Math.min(selected, hits.length - 1)] || null;
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [selected, hits]);

  if (!open) return null;
  const close = () => setOpen(false);
  // Opening goes through the tree's own handlers, so a result opens exactly like a click in the tree.
  const choose = (hit: Hit | null, newTab = false) => {
    if (!hit) return;
    const trigger = document.createElement('button');
    if (hit.entry.noteId) trigger.dataset.note = String(hit.entry.noteId);
    else trigger.dataset.openWorkspaceResource = hit.entry.path;
    if (newTab) trigger.dataset.openInNewTab = 'true';
    trigger.hidden = true;
    document.body.append(trigger);
    trigger.click();
    trigger.remove();
    close();
  };
  const move = (step: number) => setSelected(index => Math.max(0, Math.min(hits.length - 1, Math.min(index, hits.length - 1) + step)));
  const onKey = (event: KeyboardEvent) => {
    const key = event.key;
    if (key === 'Escape') { event.preventDefault(); close(); }
    else if (key === 'ArrowDown' || (event.ctrlKey && (key === 'j' || key === 'n'))) { event.preventDefault(); move(1); }
    else if (key === 'ArrowUp' || (event.ctrlKey && (key === 'k' || key === 'p'))) { event.preventDefault(); move(-1); }
    else if (key === 'PageDown') { event.preventDefault(); move(10); }
    else if (key === 'PageUp') { event.preventDefault(); move(-10); }
    else if (key === 'Enter') { event.preventDefault(); choose(current, event.ctrlKey || event.metaKey); }
  };

  return <div className="qs-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section className="qs" role="dialog" aria-modal="true" aria-label="Find a note or a file" onKeyDown={onKey}>
      <div className="qs-results">
        <label className="qs-input"><Icon name="search" size={15}/>
          <input ref={input} value={query} placeholder="Find a note or a file: name, folder, extension, words…" aria-label="Search"
            aria-controls="qs-list" aria-activedescendant={current ? `qs-${current.entry.key}` : undefined}
            onChange={event => { setQuery(event.target.value); setSelected(0); }}/>
          <small>{hits.length}{hits.length === 80 ? '+' : ''} / {entries.length}</small>
        </label>
        <ul ref={list} id="qs-list" role="listbox" aria-label="Results">
          {hits.map((hit, index) => <li key={hit.entry.key} id={`qs-${hit.entry.key}`} role="option" aria-selected={hit === current}
            onMouseMove={() => setSelected(index)} onClick={event => choose(hit, event.ctrlKey || event.metaKey)}>
            <Icon name={ICONS[hit.entry.kind] || 'notes'} size={14}/>
            <span className="qs-name">{highlight(hit.entry.name, hit.nameMatches)}</span>
            {hit.line ? <span className="qs-line">{markWords(hit.line, query)}</span> : <span className="qs-folder">{hit.entry.folder}</span>}
            <span className="qs-ext">{hit.entry.extension}</span>
          </li>)}
          {!hits.length && <li className="qs-none" role="presentation">Nothing matches “{query}”.</li>}
        </ul>
        <footer><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Ctrl</kbd>+<kbd>Enter</kbd> new tab</span><span><kbd>Esc</kbd> close</span></footer>
      </div>
      <Preview hit={current} query={query}/>
    </section>
  </div>;
}
