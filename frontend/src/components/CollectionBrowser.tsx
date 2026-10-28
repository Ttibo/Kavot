import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { fieldHref } from '../features/collections/customFields';
import { FitList, Pagination, useFitPagination } from './ViewLayout';
import '../styles/components/collection-browser.css';

export type PropertyType = 'text' | 'url' | 'email' | 'number' | 'date' | 'boolean' | 'tags' | 'select';
export type BrowserProperty<T> = {
  id: string; label: string; type: PropertyType;
  value: (item: T) => unknown;
  options?: { value: string; label: string }[];
  /** The kanban can write this property when a card changes column. */
  editable?: boolean;
};
type ViewKind = 'gallery' | 'list' | 'kanban' | 'table';
type Operator = 'contains' | 'not_contains' | 'is' | 'is_not' | 'empty' | 'not_empty' | 'gt' | 'lt' | 'checked' | 'unchecked';
type Rule = { property: string; operator: Operator; value: string };
type Config = { view: ViewKind; filters: Rule[]; sort: string; desc: boolean; groupBy: string; visible: Record<ViewKind, string[]> };

const VIEWS: [ViewKind, string, ReactNode][] = [
  ['gallery', 'Gallery', <svg key="g" viewBox="0 0 24 24"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/></svg>],
  ['list', 'List', <svg key="l" viewBox="0 0 24 24"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>],
  ['kanban', 'Kanban', <svg key="k" viewBox="0 0 24 24"><path d="M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z"/></svg>],
  ['table', 'Table', <svg key="t" viewBox="0 0 24 24"><path d="M3 5h18v14H3zM3 10h18M3 15h18M9 5v14"/></svg>],
];
const OPERATORS: Record<PropertyType, [Operator, string][]> = {
  text: [['contains', 'contient'], ['not_contains', 'does not contain'], ['is', 'est'], ['is_not', 'is not'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
  number: [['is', '='], ['gt', '>'], ['lt', '<'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
  date: [['is', 'le'], ['gt', 'after'], ['lt', 'before'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
  boolean: [['checked', 'checked'], ['unchecked', 'unchecked']],
  url: [['contains', 'contient'], ['not_contains', 'does not contain'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
  email: [['contains', 'contient'], ['not_contains', 'does not contain'], ['is', 'est'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
  tags: [['contains', 'contient'], ['not_contains', 'does not contain'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
  select: [['is', 'est'], ['is_not', 'is not'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
};
const needsValue = (operator: Operator) => !['empty', 'not_empty', 'checked', 'unchecked'].includes(operator);
const normalize = (value: unknown) => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase();
const isEmpty = (value: unknown) => value == null || value === '' || (Array.isArray(value) && !value.length);
const asList = (value: unknown) => Array.isArray(value) ? value.map(String) : isEmpty(value) ? [] : [String(value)];
const dateTime = (value: unknown) => { const time = Date.parse(String(value ?? '')); return Number.isFinite(time) ? time : NaN; };

function matches<T>(item: T, rule: Rule, property?: BrowserProperty<T>) {
  if (!property) return true;
  const value = property.value(item);
  const wanted = normalize(rule.value);
  switch (rule.operator) {
    case 'empty': return isEmpty(value);
    case 'not_empty': return !isEmpty(value);
    case 'checked': return value === true;
    case 'unchecked': return value !== true;
    case 'contains': return asList(value).some(entry => normalize(entry).includes(wanted)) || (['text', 'url', 'email'].includes(property.type) && normalize(value).includes(wanted));
    case 'not_contains': return !asList(value).some(entry => normalize(entry).includes(wanted));
    case 'is': return property.type === 'number' ? Number(value) === Number(rule.value) : property.type === 'date' ? String(value ?? '').slice(0, 10) === rule.value : normalize(value) === wanted;
    case 'is_not': return normalize(value) !== wanted;
    case 'gt': return property.type === 'date' ? dateTime(value) > dateTime(rule.value) : Number(value) > Number(rule.value);
    case 'lt': return property.type === 'date' ? dateTime(value) < dateTime(rule.value) : Number(value) < Number(rule.value);
  }
}

function compare(a: unknown, b: unknown, type: PropertyType) {
  if (isEmpty(a) !== isEmpty(b)) return isEmpty(a) ? 1 : -1;
  if (type === 'number') return Number(a) - Number(b);
  if (type === 'date') return (dateTime(a) || 0) - (dateTime(b) || 0);
  if (type === 'boolean') return Number(b === true) - Number(a === true);
  return asList(a).join(', ').localeCompare(asList(b).join(', '), undefined, { numeric: true, sensitivity: 'base' });
}

function PropertyValue<T>({ property, item }: { property: BrowserProperty<T>; item: T }) {
  const value = property.value(item);
  if (isEmpty(value) || value === false && property.type !== 'boolean') return <span className="cb-empty-value">—</span>;
  if (property.type === 'boolean') return <span className={`cb-check ${value ? 'is-on' : ''}`} aria-label={value ? 'Yes' : 'No'}>{value ? '✓' : ''}</span>;
  if (property.type === 'date') { const time = dateTime(value); return <span>{Number.isFinite(time) ? new Date(time).toLocaleDateString() : String(value)}</span>; }
  if (property.type === 'tags') return <span className="cb-tags">{asList(value).map(tag => <span key={tag} className="cb-tag">{tag}</span>)}</span>;
  if (property.type === 'select') return <span className={`cb-tag cb-select cb-select-${normalize(value).replace(/[^a-z0-9]+/g, '-')}`}>{property.options?.find(option => option.value === value)?.label || String(value)}</span>;
  if (property.type === 'url' || property.type === 'email') {
    const href = fieldHref(property.type, value);
    if (href) return <a className="cb-link" href={href} target="_blank" rel="noopener noreferrer" draggable={false} title={String(value)} onClick={event => event.stopPropagation()}>{property.type === 'url' ? linkLabel(String(value)) : String(value)}{property.type === 'url' && <span aria-hidden="true"> ↗</span>}</a>;
  }
  return <span>{String(value)}</span>;
}

/** A short, readable form of a web address: host and path without the protocol. */
function linkLabel(value: string) {
  try { const url = new URL(value); return (url.host.replace(/^www\./, '') + url.pathname.replace(/\/$/, '')).slice(0, 60); }
  catch { return value; }
}

/** A small menu built on <details>, closed by an outside click or Escape. */
function Menu({ label, icon, active, children }: { label: string; icon: string; active?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) ref.current.open = false; };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, []);
  // Closed menus render nothing, so their controls never shadow labels elsewhere on the page.
  return <details ref={ref} className={`cb-menu${active ? ' is-active' : ''}`} onToggle={event => setOpen((event.currentTarget as HTMLDetailsElement).open)} onKeyDown={event => { if (event.key === 'Escape' && ref.current) { ref.current.open = false; ref.current.querySelector('summary')?.focus(); } }}>
    <summary title={label}><Icon name={icon} size={14}/><span>{label}</span></summary>{open && <div className="cb-menu-panel">{children}</div>}
  </details>;
}

export function CollectionBrowser<T extends { id: string | number }>({ storageKey, name, items, properties, defaults, renderCard, titleProps, actions, dragPayload, onMove, toolbarExtra, empty, noun = 'items' }: {
  storageKey: string; name: string; items: T[];
  /** The first property is the item title. */
  properties: BrowserProperty<T>[];
  defaults?: Partial<Config>;
  renderCard?: (item: T) => ReactNode;
  titleProps?: (item: T) => Record<string, unknown>;
  actions?: (item: T) => ReactNode;
  dragPayload?: (item: T) => string;
  onMove?: (item: T, property: string, value: unknown) => Promise<void>;
  toolbarExtra?: ReactNode;
  empty?: ReactNode;
  noun?: string;
}) {
  const [title] = properties;
  const groupable = properties.filter(property => ['select', 'boolean', 'tags', 'text'].includes(property.type) && property !== title);
  const initial = (): Config => {
    const base: Config = { view: 'gallery', filters: [], sort: '', desc: false, groupBy: groupable.find(p => p.type === 'select')?.id || groupable[0]?.id || '', visible: { gallery: properties.slice(1, 4).map(p => p.id), list: properties.slice(1, 4).map(p => p.id), kanban: properties.slice(1, 3).map(p => p.id), table: properties.slice(1).map(p => p.id) }, ...defaults } as Config;
    try {
      const saved = JSON.parse(localStorage.getItem(`kavot.collection-view.${storageKey}`) || 'null');
      if (saved && typeof saved === 'object') return { ...base, ...saved, visible: { ...base.visible, ...(saved.visible || {}) } };
    } catch { /* storage may be unavailable */ }
    return base;
  };
  const [config, setConfig] = useState<Config>(initial);
  const [query, setQuery] = useState('');
  const [dragging, setDragging] = useState<string | number | null>(null);
  const update = (patch: Partial<Config>) => setConfig(current => {
    const next = { ...current, ...patch };
    try { localStorage.setItem(`kavot.collection-view.${storageKey}`, JSON.stringify(next)); } catch { /* per-viewer preference only */ }
    return next;
  });
  const byId = useMemo(() => new Map(properties.map(property => [property.id, property])), [properties]);
  const visible = (config.visible[config.view] || []).map(id => byId.get(id)).filter(Boolean) as BrowserProperty<T>[];
  const textProperties = properties.filter(property => ['text', 'url', 'email', 'tags', 'select'].includes(property.type));
  const shown = items.filter(item => (!query || textProperties.some(property => asList(property.value(item)).some(value => normalize(value).includes(normalize(query)))))
    && config.filters.every(rule => !needsValue(rule.operator) || rule.value !== '' ? matches(item, rule, byId.get(rule.property)) : true));
  const sortProperty = byId.get(config.sort);
  if (sortProperty) shown.sort((a, b) => compare(sortProperty.value(a), sortProperty.value(b), sortProperty.type) * (config.desc ? -1 : 1));
  const filtered = Boolean(query || config.filters.length);
  const pageKey = JSON.stringify([query, config.filters, config.sort, config.desc, config.view]);
  const fit = useFitPagination(shown, { resetKey: pageKey });
  const setRule = (index: number, patch: Partial<Rule>) => update({ filters: config.filters.map((rule, i) => i === index ? { ...rule, ...patch } : rule) });
  const toggleVisible = (id: string) => {
    const current = config.visible[config.view] || [];
    update({ visible: { ...config.visible, [config.view]: current.includes(id) ? current.filter(entry => entry !== id) : properties.filter(p => p.id === id || current.includes(p.id)).map(p => p.id) } });
  };

  const titleCell = (item: T) => <button type="button" className="cb-title" {...(titleProps?.(item) || {})}>{String(title.value(item) || 'Untitled')}</button>;
  const itemProps = (item: T) => ({
    draggable: Boolean(dragPayload || onMove),
    'data-collection-drag': dragPayload?.(item),
    onDragStart: () => setDragging(item.id),
    onDragEnd: () => setDragging(null),
  });

  const group = byId.get(config.groupBy);
  const columns = (() => {
    if (config.view !== 'kanban' || !group) return [];
    const keys: { key: string; label: string; value: unknown }[] = [];
    const add = (value: unknown, label = String(value)) => { if (!keys.some(entry => entry.key === String(value))) keys.push({ key: String(value), label, value }); };
    if (group.type === 'boolean') { add(true, 'Yes'); add(false, 'No'); }
    group.options?.forEach(option => add(option.value, option.label));
    shown.forEach(item => asList(group.value(item)).forEach(value => add(value)));
    return [...keys.map(entry => ({ ...entry, items: shown.filter(item => group.type === 'boolean' ? (group.value(item) === true) === entry.value : asList(group.value(item)).includes(entry.key)) })),
      ...(group.type === 'boolean' ? [] : [{ key: '__empty', label: `No ${group.label.toLocaleLowerCase()}`, value: group.type === 'tags' ? [] : '', items: shown.filter(item => isEmpty(group.value(item))) }])];
  })();
  const canMove = Boolean(onMove && group?.editable && group.type !== 'tags');
  const drop = async (value: unknown) => {
    const item = items.find(entry => entry.id === dragging);
    setDragging(null);
    if (!item || !group || !onMove || !canMove || String(group.value(item) ?? '') === String(value ?? '')) return;
    await onMove(item, group.id, value);
  };

  return <section className="collection-browser" aria-label={name} data-view={config.view}>
    <div className="cb-toolbar">
      <div className="cb-views" role="group" aria-label="Vue">{VIEWS.map(([id, label, icon]) => <button key={id} type="button" aria-pressed={config.view === id} aria-label={`Vue ${label.toLocaleLowerCase()}`} title={label} onClick={() => update({ view: id })}>{icon}<span>{label}</span></button>)}</div>
      <label className="cb-search"><Icon name="search" size={13}/><input type="search" aria-label={`Search in ${name}`} placeholder="Search…" value={query} onChange={event => setQuery(event.target.value)}/></label>
      <Menu label={config.filters.length ? `Filters · ${config.filters.length}` : 'Filters'} icon="menu" active={config.filters.length > 0}>
        {config.filters.map((rule, index) => {
          const property = byId.get(rule.property) || properties[0];
          return <div key={index} className="cb-rule">
            <select aria-label="Filtered property" value={rule.property} onChange={event => { const next = byId.get(event.target.value)!; setRule(index, { property: next.id, operator: OPERATORS[next.type][0][0], value: '' }); }}>{properties.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
            <select aria-label="Condition" value={rule.operator} onChange={event => setRule(index, { operator: event.target.value as Operator })}>{OPERATORS[property.type].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            {needsValue(rule.operator) && (property.options
              ? <select aria-label="Valeur" value={rule.value} onChange={event => setRule(index, { value: event.target.value })}><option value="">—</option>{property.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
              : <input aria-label="Valeur" type={property.type === 'number' ? 'number' : property.type === 'date' ? 'date' : 'text'} value={rule.value} onChange={event => setRule(index, { value: event.target.value })}/>)}
            <button type="button" className="cb-icon-button" aria-label="Retirer ce filtre" onClick={() => update({ filters: config.filters.filter((_, i) => i !== index) })}>×</button>
          </div>;
        })}
        <div className="cb-menu-actions"><button type="button" onClick={() => { const first = properties[1] || properties[0]; update({ filters: [...config.filters, { property: first.id, operator: OPERATORS[first.type][0][0], value: '' }] }); }}>＋ Add a filter</button>{config.filters.length > 0 && <button type="button" onClick={() => update({ filters: [] })}>Clear all</button>}</div>
      </Menu>
      <Menu label={sortProperty ? `Sort · ${sortProperty.label}` : 'Sort'} icon="arrow" active={Boolean(sortProperty)}>
        <label>Sort by<select aria-label="Sort by" value={config.sort} onChange={event => update({ sort: event.target.value })}><option value="">Default order</option>{properties.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
        <label className="cb-inline"><input type="checkbox" checked={config.desc} onChange={event => update({ desc: event.target.checked })}/> Descending order</label>
      </Menu>
      {config.view === 'kanban' && <Menu label={group ? `Grouped · ${group.label}` : 'Grouper'} icon="tasks">
        <label>Columns by<select aria-label="Group by" value={config.groupBy} onChange={event => update({ groupBy: event.target.value })}>{groupable.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
        {!canMove && <p className="cb-hint">Dragging between columns is only available for an editable property.</p>}
      </Menu>}
      <Menu label="Properties" icon="settings">
        <p className="cb-hint">Shown in the {VIEWS.find(([id]) => id === config.view)?.[1].toLocaleLowerCase()}</p>
        {properties.slice(1).map(p => <label key={p.id} className="cb-inline"><input type="checkbox" checked={(config.visible[config.view] || []).includes(p.id)} onChange={() => toggleVisible(p.id)}/> {p.label}</label>)}
      </Menu>
      {toolbarExtra}
      <span className="cb-count" role="status">{shown.length} / {items.length} {noun}</span>
      {filtered && <button type="button" className="cb-reset" onClick={() => { setQuery(''); update({ filters: [] }); }}>Reset</button>}
    </div>

    {!shown.length ? <div className="cb-empty">{filtered ? <p>No results. Change or reset the filters.</p> : empty}</div>
    : config.view === 'kanban' ? null
    : <div className="fit-list"><div className="fit-body" ref={fit.ref}>{config.view === 'table' ? <div className="cb-table-scroll"><table className="cb-table"><thead><tr>{[title, ...visible].map(p => <th key={p.id} scope="col" aria-sort={config.sort === p.id ? config.desc ? 'descending' : 'ascending' : 'none'}><button type="button" onClick={() => update({ sort: p.id, desc: config.sort === p.id && !config.desc })}>{p.label}{config.sort === p.id && <span>{config.desc ? ' ↓' : ' ↑'}</span>}</button></th>)}{actions && <th aria-label="Actions"/>}</tr></thead>
        <tbody data-fit-list>{fit.pageItems.map(item => <tr key={item.id} {...itemProps(item)}><td>{titleCell(item)}</td>{visible.map(p => <td key={p.id}><PropertyValue property={p} item={item}/></td>)}{actions && <td className="cb-actions">{actions(item)}</td>}</tr>)}</tbody></table></div>
    : config.view === 'list' ? <div className="cb-list" data-fit-list>{fit.pageItems.map(item => <div key={item.id} className="cb-row" {...itemProps(item)}>{titleCell(item)}<span className="cb-row-props">{visible.map(p => <span key={p.id} title={p.label}><PropertyValue property={p} item={item}/></span>)}</span>{actions && <span className="cb-actions">{actions(item)}</span>}</div>)}</div>
    : <div className="cb-gallery" data-fit-list>{fit.pageItems.map(item => <article key={item.id} className="cb-card" {...itemProps(item)}>{renderCard ? renderCard(item) : titleCell(item)}{visible.map(p => <div key={p.id} className="cb-prop"><small>{p.label}</small><PropertyValue property={p} item={item}/></div>)}{actions && <div className="cb-actions">{actions(item)}</div>}</article>)}</div>}</div>
      <Pagination label={`${name} pages`} page={fit.page} pages={fit.pages} total={fit.total} from={fit.from} to={fit.to} onPage={fit.setPage}/></div>}
    {shown.length > 0 && config.view === 'kanban' && <div className="cb-board">{columns.map(column => <section key={column.key} className={`cb-column${dragging != null && canMove ? ' is-drop-target' : ''}`} aria-label={column.label} onDragOver={event => { if (canMove) event.preventDefault(); }} onDrop={event => { event.preventDefault(); void drop(column.value); }}>
        <header><strong>{column.label}</strong><span>{column.items.length}</span></header>
        <FitList compact label={`${column.label} pages`} listClassName="cb-column-items" resetKey={pageKey} items={column.items} render={item => <article key={item.id} className="cb-card cb-card-compact" {...itemProps(item)}>{titleCell(item)}{visible.filter(p => p.id !== group?.id).map(p => <div key={p.id} className="cb-prop"><small>{p.label}</small><PropertyValue property={p} item={item}/></div>)}{actions && <div className="cb-actions">{actions(item)}</div>}</article>}/>
      </section>)}</div>}
  </section>;
}
