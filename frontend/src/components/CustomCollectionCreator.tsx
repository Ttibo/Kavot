import { CollectionIconPicker, CollectionIconSetting } from './CollectionIconPicker';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { cssVars } from './common';
import { navigate } from '../app/navigation';
import { useRuntime } from '../app/runtime';
import { api } from '../services/api';
import { publish } from '../app/viewBridge';
import { renderMarkdown } from '../app/state';
import { FIELD_KINDS, LIST_COLUMN_KINDS, fieldKindLabel, type CustomField, type ListColumn } from '../features/collections/customFields';
import { builtinFields } from '../features/collections/builtinSchemas';
import './custom-collection.css';

type DraftField = CustomField & { required: boolean; options: string[]; columns: ListColumn[]; locked?: boolean };

const TEMPLATE_PRESETS: [string, string][] = [
  ['Empty', ''],
  ['Meeting', '## Participants\n\n- \n\n## Agenda\n\n1. \n\n## Decisions\n\n## Next steps\n\n- [ ] '],
  ['Reading notes', '## Summary\n\n## Key ideas\n\n- \n\n## Quotes\n\n> \n\n## My questions\n\n- '],
  ['Experiment', '## Goal\n\n## Protocol\n\n1. \n\n## Observations\n\n## Results\n\n## Next steps\n\n- [ ] '],
];
const SNIPPETS: [string, string, string][] = [
  ['Heading', 'H₂', '\n## Section\n'],
  ['Bullet list', '•', '\n- '],
  ['Checklist', '☑', '\n- [ ] '],
  ['Quote', '❝', '\n> '],
  ['Link', '↗', '[text](https://)'],
  ['Divider', '—', '\n---\n'],
];

/** Default-value input matching the field type; an empty value means "no default". */
function DefaultValue({ field, onChange }: { field: DraftField; onChange: (value: unknown) => void }) {
  const label = `Default value of ${field.name || 'the field'}`;
  const value = field.default;
  if (field.type === 'list') return null;
  if (field.type === 'boolean') return <label className="custom-field-inline"><input type="checkbox" checked={value === true} onChange={event => onChange(event.target.checked || null)}/>Checked by default</label>;
  if (field.type === 'select') return <label>Default choice<select aria-label={label} value={String(value ?? '')} onChange={event => onChange(event.target.value || null)}><option value="">None</option>{field.options.filter(Boolean).map(option => <option key={option}>{option}</option>)}</select></label>;
  if (field.type === 'markdown') return <label>Default value<textarea aria-label={label} rows={2} value={String(value ?? '')} onChange={event => onChange(event.target.value || null)}/></label>;
  const type = ({ number: 'number', date: 'date', url: 'url', email: 'email' } as Record<string, string>)[field.type] || 'text';
  const shown = Array.isArray(value) ? value.join(', ') : String(value ?? '');
  return <label>Default value<input aria-label={label} type={type} step="any" placeholder={field.type === 'url' ? 'https://…' : field.type === 'tags' ? 'tag1, tag2' : 'None'} value={shown} onChange={event => {
    const raw = event.target.value;
    onChange(raw === '' ? null : field.type === 'number' ? Number(raw) : field.type === 'tags' ? raw.split(',').map(tag => tag.trim()).filter(Boolean) : raw);
  }}/></label>;
}

/** Editable list of choices, shared by choice fields and choice columns of lists. */
function ChoicesEditor({ legend, options, onChange }: { legend: string; options: string[]; onChange: (options: string[], changed?: string) => void }) {
  return <fieldset className="custom-field-options"><legend>{legend}</legend>
    {options.map((option, i) => <span key={i} className="custom-field-option">
      <input aria-label={`Choice ${i + 1}`} required maxLength={80} value={option} onChange={event => onChange(options.map((item, j) => j === i ? event.target.value : item), option)}/>
      <button type="button" className="button button-small" aria-label={`Remove choice ${i + 1}`} disabled={options.length === 1} onClick={() => onChange(options.filter((_, j) => j !== i), option)}>×</button>
    </span>)}
    <button type="button" className="button button-small" onClick={() => onChange([...options, ''])}>＋ Choice</button>
  </fieldset>;
}

/** Columns of a list field: each row of the list has one value per column. */
function ColumnsEditor({ field, onChange }: { field: DraftField; onChange: (columns: ListColumn[]) => void }) {
  const columns = field.columns;
  const nextId = () => { let index = columns.length + 1; while (columns.some(column => column.id === `col_${index}`)) index++; return `col_${index}`; };
  const update = (index: number, patch: Partial<ListColumn>) => onChange(columns.map((column, i) => i === index ? { ...column, ...patch } : column));
  return <fieldset className="custom-list-columns"><legend>Columns of {field.name || 'the list'}</legend>
    {columns.map((column, index) => <div key={column.id} className="custom-list-column">
      <div className="custom-list-column-main">
        <label>Column {index + 1}<input required maxLength={120} value={column.name} placeholder="e.g. Deadline" onChange={event => update(index, { name: event.target.value })}/></label>
        <label>Column type {index + 1}<select value={column.type} onChange={event => update(index, { type: event.target.value, options: event.target.value === 'select' ? column.options?.length ? column.options : [''] : [] })}>{LIST_COLUMN_KINDS.map(kind => <option key={kind.value} value={kind.value}>{kind.label}</option>)}</select></label>
        <button type="button" className="button button-small" aria-label={`Remove column ${index + 1}`} disabled={columns.length === 1} onClick={() => onChange(columns.filter((_, i) => i !== index))}>×</button>
      </div>
      {column.type === 'select' && <ChoicesEditor legend={`Choices of ${column.name || `column ${index + 1}`}`} options={column.options?.length ? column.options : ['']} onChange={options => update(index, { options })}/>}
    </div>)}
    <button type="button" className="button button-small" onClick={() => onChange([...columns, { id: nextId(), name: '', type: 'text', options: [] }])}>＋ Column</button>
  </fieldset>;
}

function FieldRow({ field, index, count, onChange, onRemove, onMove }: { field: DraftField; index: number; count: number; onChange: (patch: Partial<DraftField>) => void; onRemove: () => void; onMove: (offset: number) => void }) {
  const kind = FIELD_KINDS.find(item => item.value === field.type);
  return <div className="custom-field-row">
    <div className="custom-field-main">
      <span className="custom-field-order">
        <button type="button" className="icon-button" aria-label={`Move field ${index + 1} up`} disabled={index === 0} onClick={() => onMove(-1)}>↑</button>
        <button type="button" className="icon-button" aria-label={`Move field ${index + 1} down`} disabled={index === count - 1} onClick={() => onMove(1)}>↓</button>
      </span>
      <label>Field name {index + 1}<input required maxLength={120} value={field.name} onChange={event => onChange({ name: event.target.value })}/></label>
      <label>Field type {index + 1}<select value={field.type} disabled={field.locked} title={field.locked ? 'The type of an existing field cannot change.' : undefined} onChange={event => {
        const type = event.target.value;
        onChange({ type, default: null, options: type === 'select' ? field.options.length ? field.options : [''] : [], columns: type === 'list' ? field.columns.length ? field.columns : [{ id: 'col_1', name: '', type: 'text', options: [] }] : [] });
      }}>
        {FIELD_KINDS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
        {!kind && <option value={field.type}>{field.type}</option>}
      </select></label>
      <label className="custom-field-inline"><input type="checkbox" checked={field.required} onChange={event => onChange({ required: event.target.checked })}/>Required</label>
      <button type="button" className="button" aria-label={`Remove field ${index + 1}`} onClick={onRemove}>Remove</button>
    </div>
    {kind && <small>{kind.hint}{field.type === 'select' ? ' The value must be one of the choices below.' : ''}</small>}
    {field.type === 'select' && <ChoicesEditor legend={`Choices of ${field.name || `field ${index + 1}`}`} options={field.options} onChange={(options, changed) => onChange({ options, default: changed !== undefined && field.default === changed ? null : field.default })}/>}
    {field.type === 'list' && <ColumnsEditor field={field} onChange={columns => onChange({ columns })}/>}
    <DefaultValue field={field} onChange={value => onChange({ default: value })}/>
  </div>;
}

/** How an item of the collection looks: title, properties table, then the note. */
function ItemPagePreview({ fields, template }: { fields: DraftField[]; template: string }) {
  return <section className="custom-item-preview" aria-label="Item page preview">
    <h4>Item page preview</h4>
    <div className="custom-item-preview-page">
      <strong className="custom-item-preview-title">Untitled</strong>
      <table className="rich-page-properties"><tbody>
        {fields.filter(field => field.name.trim()).map(field => <tr key={field.id}><th scope="row">{field.name}{field.required && <span className="record-required"> *</span>}</th><td>{field.type === 'list' ? `List: ${field.columns.map(column => column.name || '…').join(' · ')}` : field.default != null && field.default !== '' ? String(field.default) : <em>{fieldKindLabel(field.type)}</em>}</td></tr>)}
        <tr><th scope="row">Projects</th><td><em>Linked projects</em></td></tr>
      </tbody></table>
      <div className="markdown-preview" dangerouslySetInnerHTML={{ __html: template.trim() ? renderMarkdown(template) : '<p><em>The note starts empty.</em></p>' }}/>
    </div>
  </section>;
}

function TemplateEditor({ value, onChange, fields }: { value: string; onChange: (value: string) => void; fields: DraftField[] }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState(false);
  const insert = (text: string) => {
    const input = area.current;
    const start = input?.selectionStart ?? value.length, end = input?.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + text + value.slice(end));
    requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(start + text.length, start + text.length); });
  };
  return <div className="custom-template-editor">
    <div className="custom-template-head">
      <strong id="custom-template-label">Default note template</strong>
      <label className="custom-field-inline">Start from<select aria-label="Template preset" value="" onChange={event => { const preset = TEMPLATE_PRESETS.find(([name]) => name === event.target.value); if (preset && (!value.trim() || confirm('Replace the current template?'))) onChange(preset[1]); }}><option value="">Choose…</option>{TEMPLATE_PRESETS.map(([name]) => <option key={name}>{name}</option>)}</select></label>
    </div>
    <div className="markdown-toolbar" role="toolbar" aria-label="Template formatting">
      {SNIPPETS.map(([label, icon, text]) => <button key={label} type="button" aria-label={label} title={label} disabled={preview} onClick={() => insert(text)}>{icon}</button>)}
      {fields.some(field => field.name.trim()) && <select aria-label="Insert a section for a field" value="" disabled={preview} onChange={event => { if (event.target.value) insert(`\n## ${event.target.value}\n\n`); }}><option value="">＋ Section for a field…</option>{fields.filter(field => field.name.trim()).map(field => <option key={field.id}>{field.name.trim()}</option>)}</select>}
      <button type="button" className="custom-template-toggle" aria-pressed={preview} onClick={() => setPreview(!preview)}>{preview ? 'Edit' : 'Preview'}</button>
    </div>
    {preview
      ? <div className="custom-template-preview markdown-preview" aria-label="Template preview" dangerouslySetInnerHTML={{ __html: value.trim() ? renderMarkdown(value) : '<p><em>Every new item starts empty.</em></p>' }}/>
      : <textarea ref={area} aria-labelledby="custom-template-label" rows={10} maxLength={100_000} value={value} onChange={event => onChange(event.target.value)} placeholder={'## Context\n\n## Observations\n\n- [ ] To check'}/>}
    <small>Each new item in the collection starts with a copy of this note. Markdown is supported. Changing it later does not modify existing items.</small>
  </div>;
}

/** Form for the fields and default note of a custom collection, used to create one or to edit it. */
function CollectionSchemaForm({ database, onDone }: { database?: any; onDone: () => void }) {
  const runtime = useRuntime();
  const [name, setName] = useState(database?.name || '');
  const [icon, setIcon] = useState('database');
  const [fields, setFields] = useState<DraftField[]>(() => (database?.fields || []).map((field: CustomField) => ({ required: false, options: [], columns: [], default: null, ...field, locked: true })));
  const [template, setTemplate] = useState<string>(database?.content_template || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const nextId = () => {
    const used = new Set(fields.map(field => field.id));
    let index = fields.length + 1;
    while (used.has(`field_${index}`)) index++;
    return `field_${index}`;
  };
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    const payloadFields = fields.map(({ locked, ...field }) => ({ ...field, name: field.name.trim(), options: field.type === 'select' ? field.options.map(option => option.trim()) : [], default: field.type === 'list' ? null : field.default ?? null,
      columns: field.type === 'list' ? field.columns.map(column => ({ ...column, name: column.name.trim(), options: column.type === 'select' ? (column.options || []).map(option => option.trim()) : [] })) : [] }));
    try {
      if (database) {
        const saved = await api<any>(`/databases/${database.id}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim(), fields: payloadFields, content_template: template }) });
        Object.assign(runtime.state.databases.find((item: any) => item.id === database.id) || {}, saved);
        runtime.toast('Collection updated');
      } else {
        const created = await api<any>('/databases', { method: 'POST', body: JSON.stringify({
          id: `custom-${crypto.randomUUID()}`, name: name.trim(), record_kind: 'record', fields: payloadFields, content_template: template, icon,
        }) });
        runtime.state.databases.push(created);
        runtime.state.databaseRecords[created.id] = [];
        runtime.toast('Collection created');
      }
      publish();
      onDone();
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  return <form className="settings-card custom-collection-creator" onSubmit={submit}>
    <h3>{database ? `Edit ${database.name}` : 'New custom collection'}</h3>
    <p>Each item opens as a page: its title, a table with the fields below, then its note. Define the fields and the note every new item starts with.</p>
    <fieldset disabled={busy}>
      <label>Collection name<input required maxLength={120} value={name} onChange={event => setName(event.target.value)}/></label>
      {!database && <CollectionIconPicker value={icon} onChange={setIcon}/>}
      <section className="custom-collection-section" aria-label="Fields">
        <h4>Fields</h4>
        {!fields.length && <small>No field yet: items only have a title and a note.</small>}
        {fields.map((field, index) => <FieldRow key={field.id} field={field} index={index} count={fields.length}
          onChange={patch => setFields(fields.map((item, i) => i === index ? { ...item, ...patch } : item))}
          onMove={offset => { const next = [...fields]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; setFields(next); }}
          onRemove={() => { if (!field.locked || confirm(`Remove ${field.name}? Its values stay in existing items but are no longer shown.`)) setFields(fields.filter((_, i) => i !== index)); }}/>)}
        <button type="button" className="button" onClick={() => setFields([...fields, { id: nextId(), name: '', type: 'text', required: false, options: [], columns: [], default: null }])}>＋ Add a field</button>
      </section>
      <TemplateEditor value={template} onChange={setTemplate} fields={fields}/>
      <ItemPagePreview fields={fields} template={template}/>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    <div className="form-actions"><button type="button" className="button" disabled={busy} onClick={onDone}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : database ? 'Save changes' : 'Create collection'}</button></div>
  </form>;
}

function CustomCollectionCreator() {
  const [open, setOpen] = useState(false);
  if (!open) return <button className="button button-primary" onClick={() => setOpen(true)}>＋ New collection</button>;
  return <CollectionSchemaForm onDone={() => setOpen(false)}/>;
}

/** "Edit fields & template" button for a custom collection, opening the same form in place. */
function CustomCollectionEditor({ database }: { database: any }) {
  const [open, setOpen] = useState(false);
  if (database.storage?.driver !== 'json-files') return null;
  if (!open) return <button className="button button-small" onClick={() => setOpen(true)}>Fields & template</button>;
  return <CollectionSchemaForm database={database} onDone={() => setOpen(false)}/>;
}

/** Collections that always exist and are not managed from the settings. */
const FIXED_COLLECTIONS = new Set(['articles', 'notes', 'tasks']);

type CollectionsScope = {
  /** Only these collections, without the creator (a plugin's page). */
  include?: string[];
  /** Collections managed elsewhere (by their plugin's page). */
  exclude?: string[];
};

/**
 * Removable collections with their folders, icon and fields. Without `include`, this is
 * Settings → Collections: the creator and the user's own collections.
 */
export function CollectionsSettings({ include, exclude = [] }: CollectionsScope) {
  const runtime = useRuntime(); const { state } = runtime;
  const [removed, setRemoved] = useState<any[]>([]);
  const loadRemoved = () => api<any[]>('/databases/removed').then(setRemoved).catch(() => setRemoved([]));
  useEffect(() => { void loadRemoved(); }, []);
  const inScope = (id: string) => include ? include.includes(id) : !exclude.includes(id);
  const managed = state.databases.filter((database: any) => !FIXED_COLLECTIONS.has(database.id) && inScope(database.id));
  const removedHere = removed.filter(database => inScope(database.id));
  async function addFolder(databaseId: string) {
    const name = window.prompt('Folder name')?.trim(); if (!name) return;
    try { await api(`/databases/${databaseId}/folders`, { method: 'POST', body: JSON.stringify({ name }) }); await runtime.refreshData(); }
    catch (reason) { runtime.toast((reason as Error).message, 'error'); }
  }
  async function remove(database: any) {
    const custom = database.storage?.driver === 'json-files';
    const message = custom
      ? `Delete the ${database.name} collection and its items? They are moved to the collection trash in the storage folder.`
      : `Remove the ${database.name} collection? Its items are kept and you can restore it here.`;
    if (!confirm(message)) return;
    try {
      await api(`/databases/${database.id}`, { method: 'DELETE' });
      state.databases = state.databases.filter((item: any) => item.id !== database.id);
      delete state.databaseRecords[database.id];
      if (state.collectionId === database.id || state.view === database.id) { state.collectionId = 'articles'; void navigate('dashboard'); }
      publish(); void loadRemoved();
      runtime.toast(custom ? 'Collection deleted' : 'Collection removed');
    } catch (reason) { runtime.toast((reason as Error).message, 'error'); }
  }
  async function restore(database: any) {
    try {
      await api(`/databases/${database.id}/restore`, { method: 'POST' });
      await runtime.refreshData(); void loadRemoved();
      runtime.toast(`${database.name} restored`);
    } catch (reason) { runtime.toast((reason as Error).message, 'error'); }
  }
  return <>
    {!include && <><header><h3>My collections</h3><p>Create your own collections with their fields and the note each item starts with. Collections that come with a plugin are managed on that plugin's page.</p></header>
    <CustomCollectionCreator/></>}
    {managed.map((database: any) => <article key={database.id} className="settings-card database-definition-card">
      <div className="database-definition-head"><div><span>{database.storage?.driver === 'json-files' ? 'Custom collection' : 'Built-in collection'}</span><h3>{database.name}</h3><CollectionIconSetting database={database}/><p>{(database.fields || []).length ? `${database.fields.length} field${database.fields.length > 1 ? 's' : ''} · ` : ''}{(database.views || []).join(' · ')}</p></div>
        <div className="form-actions"><button className="button button-small" onClick={() => void addFolder(database.id)}>＋ Folder</button><button className="button button-small button-danger" aria-label={`Delete ${database.name}`} onClick={() => void remove(database)}>Delete</button></div></div>
      <div className="database-folder-list">{database.organization?.folders?.length ? database.organization.folders.map((folder: any) => <span key={folder.id} style={cssVars({ '--folder-color': folder.color || '#087e86' })}>{folder.name}</span>) : <small>No organization folders yet.</small>}</div>
      <BuiltinFieldsSummary databaseId={database.id}/>
      <CustomCollectionEditor database={database}/>
    </article>)}
    {!managed.length && !include && <p className="settings-hint">No collection yet. Create one to organize your own items.</p>}
    {removedHere.length > 0 && <article className="settings-card"><h3>Removed collections</h3><p>Their items were kept.</p><div className="form-actions">{removedHere.map(database => <button key={database.id} className="button button-small" onClick={() => void restore(database)}>Restore {database.name}</button>)}</div></article>}
  </>;
}

/** Read-only list of the fields of Conferences or Datasets, shown like the fields of custom collections. */
function BuiltinFieldsSummary({ databaseId }: { databaseId: string }) {
  const fields = builtinFields(databaseId);
  if (!fields) return null;
  return <details className="builtin-fields-summary"><summary>Fields ({fields.length})</summary>
    <table className="rich-page-properties"><tbody>{fields.map(field => <tr key={field.id}><th scope="row">{field.name}{field.required && <span className="record-required"> *</span>}</th><td>{fieldKindLabel(field.type)}{field.type === 'select' ? ` · ${(field.options || []).map(option => field.optionLabels?.[option] || option).join(', ')}` : ''}{field.type === 'list' ? ` · ${(field.columns || []).map(column => column.name).join(', ')}` : ''}</td></tr>)}</tbody></table>
    <small>Items open beside the list with these fields at the top of their note.</small>
  </details>;
}
