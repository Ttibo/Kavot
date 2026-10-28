import { useState, type ReactNode } from 'react';
import { Pagination, useFitPagination } from './ViewLayout';
import '../styles/features/workspace-table.css';

type Column<T> = { id: string; label: string; value: (row: T) => string | number; render?: (row: T) => ReactNode };
export function WorkspaceTable<T extends { id: string | number }>({ name, rows, columns, storageKey }: { name: string; rows: T[]; columns: Column<T>[]; storageKey: string }) {
  const [query, setQuery] = useState('');
  const [preferences, setPreferences] = useState<{ hidden: string[]; compact: boolean; sort: string; desc: boolean }>(() => {
    try { const p = JSON.parse(localStorage.getItem(`kavot.table.${storageKey}`) || '{}'); return { hidden: Array.isArray(p.hidden) ? p.hidden : [], compact: p.compact === true, sort: typeof p.sort === 'string' ? p.sort : '', desc: p.desc === true }; } catch { return { hidden: [], compact: false, sort: '', desc: false }; }
  });
  const update = (patch: Partial<typeof preferences>) => { const next = { ...preferences, ...patch }; setPreferences(next); try { localStorage.setItem(`kavot.table.${storageKey}`, JSON.stringify(next)); } catch {} };
  const shown = columns.filter((c, i) => i === 0 || !preferences.hidden.includes(c.id));
  const sort = columns.find(c => c.id === preferences.sort);
  const filtered = rows.filter(row => columns.some(c => String(c.value(row) ?? '').toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  if (sort) filtered.sort((a, b) => { const x = sort.value(a), y = sort.value(b); return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true })) * (preferences.desc ? -1 : 1); });
  const fit = useFitPagination(filtered, { resetKey: `${query}|${preferences.sort}|${preferences.desc}|${preferences.compact}` });
  return <section className={`workspace-data-table ${preferences.compact ? 'compact' : ''}`} aria-label={name}>
    <div className="workspace-table-tools"><span className="workspace-table-count">{filtered.length} / {rows.length}</span><input type="search" aria-label={`Search in ${name}`} placeholder="Search…" value={query} onChange={e => setQuery(e.target.value)}/><details><summary>Columns</summary><div>{columns.slice(1).map(c => <label key={c.id}><input type="checkbox" checked={!preferences.hidden.includes(c.id)} onChange={e => update({ hidden: e.target.checked ? preferences.hidden.filter(id => id !== c.id) : [...preferences.hidden, c.id] })}/>{c.label}</label>)}</div></details><button type="button" aria-pressed={preferences.compact} onClick={() => update({ compact: !preferences.compact })}>Compact</button></div>
    <div className="fit-list"><div className="fit-body" ref={fit.ref}><div className="workspace-table-scroll"><table><caption className="sr-only">{name}</caption><thead><tr>{shown.map(c => <th key={c.id} scope="col" aria-sort={preferences.sort === c.id ? preferences.desc ? 'descending' : 'ascending' : 'none'}><button onClick={() => update({ sort: c.id, desc: preferences.sort === c.id && !preferences.desc })}>{c.label}<span>{preferences.sort === c.id ? preferences.desc ? ' ↓' : ' ↑' : ' ↕'}</span></button></th>)}</tr></thead><tbody data-fit-list>{fit.pageItems.map(row => <tr key={row.id}>{shown.map(c => <td key={c.id}>{c.render ? c.render(row) : c.value(row)}</td>)}</tr>)}</tbody></table>{!filtered.length && <p className="workspace-table-empty">{query ? 'No results for this search.' : 'No items yet.'}</p>}</div></div>
      {filtered.length > 0 && <Pagination label={`${name} pages`} page={fit.page} pages={fit.pages} total={fit.total} from={fit.from} to={fit.to} onPage={fit.setPage}/>}</div>
  </section>;
}
