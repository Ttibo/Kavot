import { escapeHtml, noteAssetBase, state } from '../../app/state';
import { api } from '../../services/api';
import { navigate, toast } from '../../app/navigation';
import { findCollectionItem } from './catalog';
import { bindMarkdownBlockEditor, currentMarkdownBlockInput, markdownBlockEditorMarkup } from '../documents/markdown';
import { applyMarkdownToEditor, markdownFormattingToolbarMarkup, flushCurrentNoteAutosave, flushSecondaryNoteAutosave, flushWorkspaceMarkdownSaves, replaceActiveWorkspaceTab, workspaceResourceTab, workspaceNoteTab, rerenderNotesContext } from '../documents/workspace';
import { flushCanvasSaves } from '../documents/canvas';
import { loadReadingNote } from '../library/documents';
import { bindFieldLinks, bindListFields, customFieldControl, readFieldValue, type CustomField } from './customFields';
import { builtinFields } from './builtinSchemas';

type Draft = { key: string; reference: any; values: any; text: string; note: any; titleKey: string; textKey: string; timer?: ReturnType<typeof setTimeout>; request?: Promise<void>; dirty: boolean; version: number };
const drafts = new Map<string, Draft>();
export const hasCollectionDrafts = () => [...drafts.values()].some(draft => draft.dirty || draft.request);
const keyFor = (ref) => `${ref.databaseId}/${ref.type}/${ref.id}`;
/** An item being created: it has no id until its first save. */
export const isNewCollectionItem = (ref) => ref?.id === 'new';
/** Forgets the unsaved draft of an item being created, when its panel closes. */
export function discardNewCollectionDraft(ref) {
  const draft = drafts.get(keyFor(ref));
  if (draft && isNewCollectionItem(draft.reference)) { clearTimeout(draft.timer); drafts.delete(draft.key); }
}

/** Empty values of a new item: field defaults and the project in scope. */
function newItemValues(ref) {
  const values: Record<string, unknown> = {};
  // Same defaults as the server; a required choice starts on its first option.
  const serverDefaults = { conference: { status: 'watching' }, dataset: { access_status: 'available' } }[ref.type] || {};
  (schemaFor(ref) || []).forEach(f => {
    if (f.default != null) values[f.id] = structuredClone(f.default);
    else if (serverDefaults[f.id]) values[f.id] = serverDefaults[f.id];
    else if (f.required && f.type === 'select' && f.options?.length) values[f.id] = f.options[0];
  });
  values[ref.type === 'record' ? 'title' : 'name'] = '';
  values.project_ids = ref.projectIds || [];
  if (ref.type === 'conference') values.deadlines = [];
  return values;
}

/** Opens a collection item as a full-size tab: in the active tab of `pane`, or in a new tab of it. */
export async function openCollectionInNotes(reference, { newTab = false, pane = 'primary' }: { newTab?: boolean; pane?: string } = {}) {
  await flushCurrentNoteAutosave();
  await flushSecondaryNoteAutosave();
  await flushWorkspaceMarkdownSaves();
  await flushCanvasSaves();
  const item = findCollectionItem(reference);
  if (!item) return toast('Collection item not found', 'error');
  if (state.view !== 'notes') await navigate('notes');
  if (item.type === 'paper' || item.type === 'note') {
    const note = item.type === 'paper' ? await loadReadingNote(item.source) : item.source;
    state.notes = [...state.notes.filter(n => n.id !== note.id), note];
    replaceActiveWorkspaceTab(pane, workspaceNoteTab(note), newTab);
    return rerenderNotesContext();
  }
  replaceActiveWorkspaceTab(pane, workspaceResourceTab({ type: 'collection-record', path: `collection/${keyFor(reference)}`, title: item.title, content: reference }), newTab);
  rerenderNotesContext();
}

function draftFor(reference): Draft {
  const key = keyFor(reference);
  const existing = drafts.get(key);
  if (existing?.dirty || existing?.request) return existing;
  if (isNewCollectionItem(reference)) {
    const values = newItemValues(reference);
    const draft = { key, reference, values, note: null, titleKey: reference.type === 'record' ? 'title' : 'name', textKey: reference.type === 'record' ? 'content' : 'notes', text: '', dirty: false, version: 0 };
    drafts.set(key, draft);
    return draft;
  }
  const item = findCollectionItem(reference);
  if (!item) return null;
  const values = structuredClone(item.source.values || item.source);
  const note = !values.note_trashed && state.notes.find(n => n.id === Number(values.note_id));
  const titleKey = ['conference', 'dataset'].includes(item.type) ? 'name' : values.title !== undefined ? 'title' : values.name !== undefined ? 'name' : 'title';
  const textKey = ['conference', 'dataset'].includes(item.type) ? 'notes' : item.type === 'task' ? 'description' : ['content', 'description', 'body'].find(k => k in values) || 'content';
  const draft = { key, reference, values, note, titleKey, textKey, text: note?.content || values[textKey] || '', dirty: false, version: 0 };
  drafts.set(key, draft);
  return draft;
}

const labels = { title: 'Title', name: 'Name', description: 'Description', location: 'Location', url: 'Link', version: 'Version', start_date: 'Start', due_date: 'Due', labels: 'Tags', group: 'Group', position: 'Position', kind: 'Type' };
/** One row of the properties table at the top of the page. */
function row(label: string, control: string, id = '', attributes = '') {
  const head = id ? `<label for="${id}">${label}</label>` : label;
  return `<tr ${attributes}><th scope="row">${head}</th><td>${control}</td></tr>`;
}
function field(pane, key, value, type = 'text') {
  const id = `record-${pane}-${key}`;
  return row(escapeHtml(labels[key] || key), `<input id="${id}" data-record-field="${escapeHtml(key)}" type="${type}" value="${escapeHtml(Array.isArray(value) ? value.join(', ') : String(value ?? ''))}">`, id);
}
function select(pane, key, label, value, options) {
  const id = `record-${pane}-${key}`;
  return row(label, `<select id="${id}" data-record-field="${key}">${options.map(([option, title]) => `<option value="${escapeHtml(String(option))}" ${String(value ?? '') === String(option) ? 'selected' : ''}>${escapeHtml(title)}</option>`).join('')}</select>`, id);
}
function relations(key, label, selected, items) {
  return row(label, `<div class="record-relations" role="group" aria-label="${label}">${items.map(item => `<label class="record-relation"><input type="checkbox" data-record-relation="${key}" value="${item.id}" ${(selected || []).includes(item.id) ? 'checked' : ''}>${escapeHtml(item.name || item.title)}</label>`).join('') || '<small>No items.</small>'}</div>`);
}
/** Field definitions of an item: those of its custom collection, or of Conferences / Datasets. */
function schemaFor(ref): CustomField[] | null {
  if (ref.type === 'conference' || ref.type === 'dataset') return builtinFields(`${ref.type}s`);
  if (ref.type !== 'record') return null;
  const database = state.databases.find(item => item.id === ref.databaseId && item.storage?.driver === 'json-files');
  return database?.fields || null;
}
const isEmpty = (value: unknown) => value == null || value === '' || (Array.isArray(value) && !value.length) || (typeof value === 'string' && !value.trim());
/** Names of the required fields of an item that are still empty. */
function missingRequired(draft: Draft) {
  return (schemaFor(draft.reference) || []).filter(f => f.required && f.type !== 'boolean' && isEmpty(draft.values[f.id])).map(f => f.name);
}
function schemaRow(pane, f: CustomField, value) {
  const id = `record-${pane}-field-${f.id}`;
  const control = customFieldControl(f, value, `id="${id}" data-custom-field="${escapeHtml(f.id)}"`);
  const label = `${escapeHtml(f.name)}${f.required ? ' <span class="record-required" aria-hidden="true">*</span>' : ''}`;
  const missing = f.required && f.type !== 'boolean' && isEmpty(value);
  return row(label, control, f.type === 'list' ? '' : id, `data-field-row="${escapeHtml(f.id)}" class="${f.type === 'list' ? 'is-list' : ''} ${missing ? 'missing' : ''}"`);
}
function collectionName(ref) {
  const id = ref.databaseId || { conference: 'conferences', dataset: 'datasets', task: 'tasks' }[ref.type];
  return state.databases.find(item => item.id === id)?.name || ({ conferences: 'Conferences', datasets: 'Datasets', tasks: 'Tasks' })[id] || 'Collection';
}
export function collectionRecordMarkup(resource, pane) {
  const ref = resource.content;
  const draft = draftFor(ref);
  if (!draft) return '<section class="note-pane">Item unavailable.</section>';
  const v = draft.values;
  const schema = schemaFor(ref);
  let params = '';
  if (ref.type === 'task') {
    params = select(pane, 'project_id', 'Project', v.project_id, [['', 'No project'], ...state.projects.map(p => [p.id, p.name])])
      + select(pane, 'column_id', 'Status', v.column_id, state.taskColumns.map(c => [c.id, c.name]))
      + select(pane, 'priority', 'Priority', v.priority, [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']])
      + field(pane, 'start_date', v.start_date, 'date') + field(pane, 'due_date', v.due_date, 'date') + field(pane, 'labels', v.labels);
    params += row('Checklist', `<div class="record-relations" role="group" aria-label="Checklist">${(v.checklist || []).map((item, index) => `<label class="record-relation"><input type="checkbox" data-record-check="${index}" ${item.done ? 'checked' : ''}>${escapeHtml(item.text)}</label>`).join('') || '<small>No items.</small>'}</div>`);
  } else if (schema) {
    params = schema.map(f => schemaRow(pane, f, v[f.id])).join('') + relations('project_ids', 'Projects', v.project_ids, state.projects);
    if (ref.type === 'conference') params += relations('dataset_ids', 'Datasets', v.dataset_ids, state.datasets);
    if (ref.type === 'dataset') params += relations('conference_ids', 'Conferences', v.conference_ids, state.conferences);
  } else {
    const hidden = new Set([draft.titleKey, draft.textKey, 'note_id', 'note_path', 'note_trashed', 'project_ids', 'linked_note_ids']);
    params = Object.entries(v).filter(([k, value]) => !hidden.has(k) && (value == null || typeof value !== 'object')).map(([k, value]) => {
      const id = `record-${pane}-${escapeHtml(k)}`;
      return typeof value === 'boolean' ? row(escapeHtml(labels[k] || k), `<input type="checkbox" id="${id}" data-record-field="${escapeHtml(k)}" ${value ? 'checked' : ''}>`, id) : field(pane, k, value, typeof value === 'number' ? 'number' : 'text');
    }).join('') + relations('project_ids', 'Projects', v.project_ids, state.projects);
  }
  const id = `record-${pane}`;
  const missing = missingRequired(draft);
  const status = isNewCollectionItem(ref) ? 'New item · add a title to create it' : missing.length ? `Required: ${missing.join(', ')}` : draft.dirty ? 'Unsaved changes' : 'Saved';
  // Laid out like an HTML page: collection, title and properties table, then the text of the note.
  const header = `<div class="rich-page-eyebrow"><span>${escapeHtml(collectionName(ref))}</span><span data-record-status role="status">${escapeHtml(status)}</span></div><input class="rich-page-title" data-record-title aria-label="Title" required maxlength="240" placeholder="Untitled" value="${escapeHtml(v[draft.titleKey] || resource.title || '')}"><table class="rich-page-properties collection-record-fields" aria-label="Item fields"><tbody>${params}</tbody></table>`;
  return `<section class="note-pane collection-record-editor" data-collection-editor="${escapeHtml(keyFor(ref))}"><div class="collection-record-writing">${markdownFormattingToolbarMarkup("data-record-md")}<div class="markdown-block-shell">${markdownBlockEditorMarkup(draft.text, { sourceId: `${id}-source`, editorId: `${id}-editor`, ariaLabel: 'Notes for this item', assetBase: draft.note ? noteAssetBase(draft.note) : '', pageHeader: header })}</div></div></section>`;
}

async function saveDraft(key: string) {
  const draft = drafts.get(key);
  if (!draft) return;
  clearTimeout(draft.timer);
  if (draft.request) { await draft.request; return saveDraft(key); }
  if (!draft.dirty) return;
  // A new item is created only once it has a title.
  if (isNewCollectionItem(draft.reference) && !String(draft.values[draft.titleKey] || '').trim()) return;
  const missing = missingRequired(draft);
  if (missing.length) throw new Error(`Fill in the required fields to save: ${missing.join(', ')}.`);
  const version = draft.version;
  const values = structuredClone(draft.values);
  const text = draft.text;
  const ref = draft.reference;
  // Deadlines need a label and a date: rows still being typed are kept in the page, not sent.
  if (ref.type === 'conference') values.deadlines = (values.deadlines || []).filter(item => item.label && item.due_at).map(item => ({ kind: 'submission', timezone: 'Europe/Paris', notes: '', ...item }));
  draft.request = (async () => {
    if (!String(values[draft.titleKey] || '').trim()) throw new Error('A title is required.');
    if (isNewCollectionItem(ref)) return createItem(draft, values, text);
    if (draft.note) {
      const note = await api(`/notes/${draft.note.id}`, { method: 'PATCH', body: JSON.stringify({ content: text }) });
      Object.assign(draft.note, note);
      const currentNote = state.notes.find(item => item.id === note.id);
      if (currentNote) Object.assign(currentNote, note);
    }
    values[draft.textKey] = text;
    const generic = ref.type === 'record';
    const endpoint = generic ? `/databases/${ref.databaseId}/records/${ref.id}` : `/${ref.databaseId}/${ref.id}`;
    const saved = await api(endpoint, { method: 'PATCH', body: JSON.stringify(generic ? { values } : values) });
    const item = findCollectionItem(ref);
    if (item) Object.assign(item.source, saved);
    if (saved.note && draft.note) {
      Object.assign(draft.note, saved.note);
      const currentNote = state.notes.find(item => item.id === saved.note.id);
      if (currentNote) Object.assign(currentNote, saved.note);
    }
    if (version === draft.version) draft.dirty = false;
    for (const pane of ['primary', 'secondary']) for (const tab of state.workspaceTabs[pane]) {
      if (tab.resource?.path === `collection/${key}`) tab.resource.title = values[draft.titleKey];
    }
  })();
  try { await draft.request; } finally { draft.request = undefined; }
}
/** First save of a new item: creates it, then the draft continues as an ordinary item. */
async function createItem(draft: Draft, values: any, text: string) {
  const ref = draft.reference;
  const version = draft.version;
  values[draft.textKey] = text;
  let saved;
  if (ref.type === 'record') {
    saved = await api<any>(`/databases/${ref.databaseId}/records`, { method: 'POST', body: JSON.stringify({ values }) });
    state.databaseRecords[ref.databaseId] = [saved, ...(state.databaseRecords[ref.databaseId] || [])];
  } else {
    saved = await api<any>(`/${ref.databaseId}`, { method: 'POST', body: JSON.stringify(values) });
    const list = ref.type === 'conference' ? 'conferences' : 'datasets';
    state[list] = [saved, ...state[list]];
  }
  drafts.delete(draft.key);
  ref.id = saved.id;
  draft.key = keyFor(ref);
  drafts.set(draft.key, draft);
  const item = findCollectionItem(ref);
  if (item) draft.values = structuredClone({ ...(item.source.values || item.source), ...draft.values, id: saved.id });
  draft.note = !draft.values.note_trashed && state.notes.find(n => n.id === Number(draft.values.note_id)) || null;
  if (state.collectionPanel?.session && state.collectionPanel.session === ref.session) state.collectionPanel = { ...state.collectionPanel, id: saved.id };
  if (version === draft.version) draft.dirty = false;
  toast('Item created');
}
export async function flushCollectionSaves() {
  await Promise.all([...drafts.keys()].map(saveDraft));
}
/** Binds the item editors under `root`; `onSaved` runs after each successful save. */
export function bindCollectionEditors(root: Element, { onSaved }: { onSaved?: () => void } = {}) {
  root?.querySelectorAll<HTMLElement>('[data-collection-editor]').forEach(host => {
    const key = host.dataset.collectionEditor;
    const draft = drafts.get(key);
    const source = host.querySelector<HTMLTextAreaElement>('textarea[id$="-source"]');
    const schema = schemaFor(draft.reference) || [];
    bindMarkdownBlockEditor(host.querySelector('[id$="-editor"]'), source);
    bindFieldLinks(host);
    const status = host.querySelector('[data-record-status]');
    const save = async () => {
      if (isNewCollectionItem(draft.reference) && !String(draft.values[draft.titleKey] || '').trim()) { status.textContent = 'New item · add a title to create it'; return; }
      status.textContent = 'Saving…';
      try { await saveDraft(draft.key); host.dataset.collectionEditor = draft.key; status.textContent = draft.dirty ? 'Unsaved changes' : 'Saved'; onSaved?.(); }
      catch (error) { status.textContent = error.message; if (!missingRequired(draft).length) toast(error.message, 'error'); }
    };
    const capture = () => {
      draft.values[draft.titleKey] = host.querySelector<HTMLInputElement>('[data-record-title]').value;
      draft.text = source.value;
      host.querySelectorAll<HTMLInputElement>('[data-record-field]').forEach(input => {
        const k = input.dataset.recordField;
        draft.values[k] = input.type === 'checkbox' ? input.checked : ['project_id', 'column_id'].includes(k) ? Number(input.value) || null : input.type === 'number' ? Number(input.value) : k === 'labels' ? input.value.split(',').map(s => s.trim()).filter(Boolean) : input.type === 'date' ? input.value || null : input.value;
      });
      host.querySelectorAll<HTMLElement>('[data-custom-field]').forEach(control => {
        const definition = schema.find(f => f.id === control.dataset.customField);
        if (definition) draft.values[definition.id] = readFieldValue(definition, control);
      });
      const missing = new Set(missingRequired(draft));
      host.querySelectorAll<HTMLElement>('[data-field-row]').forEach(tr => {
        const definition = schema.find(f => f.id === tr.dataset.fieldRow);
        tr.classList.toggle('missing', Boolean(definition && missing.has(definition.name)));
      });
      const relationKeys = new Set([...host.querySelectorAll<HTMLInputElement>('[data-record-relation]')].map(input => input.dataset.recordRelation));
      relationKeys.forEach(k => { draft.values[k] = [...host.querySelectorAll<HTMLInputElement>(`[data-record-relation="${k}"]:checked`)].map(input => Number(input.value)); });
      host.querySelectorAll<HTMLInputElement>('[data-record-check]').forEach(input => { draft.values.checklist[Number(input.dataset.recordCheck)].done = input.checked; });
      draft.dirty = true; draft.version++;
      status.textContent = missing.size ? `Required: ${[...missing].join(', ')}` : 'Unsaved changes';
      clearTimeout(draft.timer); draft.timer = setTimeout(save, 650);
    };
    host.addEventListener('input', capture);
    host.addEventListener('change', capture);
    bindListFields(host, schema, capture);
    host.querySelectorAll<HTMLElement>('[data-record-md]').forEach(button => button.addEventListener('click', () => applyMarkdownToEditor(currentMarkdownBlockInput(host.querySelector('[id$="-editor"]'), true), button.dataset.recordMd)));
  });
}
