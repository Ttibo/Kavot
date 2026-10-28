import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from './Icon';
import '../styles/components/context-picker.css';
import { countByKind, filterOptions, KIND_ICONS, KIND_LABELS, type PickedItem, type PickedKind } from '../features/externalAgents/picker';

const KINDS: (PickedKind | 'all')[] = ['all', 'project', 'note', 'paper', 'paper_folder', 'note_folder', 'collection', 'file'];
const PLURALS: Record<PickedKind | 'all', string> = {
  all: 'All', project: 'Projects', note: 'Notes', paper: 'Articles', paper_folder: 'Article folders',
  note_folder: 'Note folders', collection: 'Collections', file: 'Files',
};

/** Search and pick what the agent should work on; the keyboard alone is enough (↑ ↓ Enter, Tab for the type). */
export function ContextPicker({ options, picked, query: initialQuery = '', mention = false, onPick, onQueryChange, onClose }: {
  options: PickedItem[]; picked: PickedItem[]; query?: string;
  /** Opened by typing @ in the message: the query lives in the message. */
  mention?: boolean;
  onPick: (item: PickedItem) => void; onQueryChange?: (query: string) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [kind, setKind] = useState<PickedKind | 'all'>('all');
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const shownQuery = mention ? initialQuery : query;
  const chosen = useMemo(() => new Set(picked.map(item => item.key)), [picked]);
  const counts = useMemo(() => countByKind(options, shownQuery), [options, shownQuery]);
  const results = useMemo(() => filterOptions(options, shownQuery, kind), [options, shownQuery, kind]);

  useEffect(() => { if (!mention) input.current?.focus(); }, [mention]);
  useEffect(() => { setCursor(0); }, [shownQuery, kind]);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)?.scrollIntoView({ block: 'nearest' }); }, [cursor]);
  useEffect(() => {
    if (!mention) return;
    // In mention mode the message keeps the focus: listen to its keys from here.
    const keys = (event: globalThis.KeyboardEvent) => navigate(event);
    window.addEventListener('keydown', keys, true);
    return () => window.removeEventListener('keydown', keys, true);
  });

  function navigate(event: KeyboardEvent | globalThis.KeyboardEvent) {
    if (event.key === 'ArrowDown') { event.preventDefault(); setCursor(value => Math.min(value + 1, results.length - 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setCursor(value => Math.max(value - 1, 0)); }
    else if (event.key === 'Enter' || (mention && event.key === 'Tab' && results.length)) {
      if (!results[cursor]) return;
      event.preventDefault(); event.stopPropagation(); onPick(results[cursor]);
    } else if (event.key === 'Tab' && !mention) {
      event.preventDefault();
      const shown = KINDS.filter(value => value === 'all' || counts[value]);
      setKind(shown[(shown.indexOf(kind) + (event.shiftKey ? shown.length - 1 : 1)) % shown.length]);
    } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
  }

  let previousKind: PickedKind | null = null;
  return <div className={'context-picker' + (mention ? ' mention' : '')} role="dialog" aria-label="Add context">
    {!mention && <div className="context-picker-search"><Icon name="search" size={14}/>
      <input ref={input} value={query} placeholder="Search a project, note, article, folder, collection…" aria-label="Search context"
        onChange={event => { setQuery(event.target.value); onQueryChange?.(event.target.value); }} onKeyDown={navigate}/>
      <button type="button" aria-label="Close" onClick={onClose}><Icon name="close" size={13}/></button></div>}
    <div className="context-picker-kinds" role="tablist" aria-label="Type">
      {KINDS.filter(value => value === 'all' || counts[value]).map(value => <button key={value} type="button" role="tab" aria-selected={kind === value}
        onMouseDown={event => event.preventDefault()} onClick={() => setKind(value)}>{PLURALS[value]}<small>{counts[value] || 0}</small></button>)}
    </div>
    <div ref={list} className="context-picker-results" role="listbox" aria-label="Results">
      {results.map((option, index) => {
        const heading = kind === 'all' && option.kind !== previousKind && !shownQuery ? PLURALS[option.kind] : null;
        previousKind = option.kind;
        return <div key={option.key} role="presentation">
          {heading && <h4>{heading}</h4>}
          <button type="button" role="option" data-index={index} aria-selected={index === cursor} className={chosen.has(option.key) ? 'chosen' : ''}
            onMouseDown={event => event.preventDefault()} onMouseEnter={() => setCursor(index)} onClick={() => onPick(option)}>
            <Icon name={KIND_ICONS[option.kind]} size={15}/>
            <span><strong>{option.title}</strong>{option.subtitle && <small>{option.subtitle}</small>}</span>
            <em>{chosen.has(option.key) ? '✓' : KIND_LABELS[option.kind]}</em>
          </button>
        </div>;
      })}
      {!results.length && <p className="context-picker-empty">Nothing matches “{shownQuery}”.</p>}
    </div>
    <footer>↑↓ to move · Enter to add{mention ? '' : ' · Tab to change type'} · Esc to close</footer>
  </div>;
}
