/** The page of a task, in a tab of the editor or in the side panel: its fields, then its notes.
 * An article or a note opens as its note instead. */
import { escapeHtml, noteAssetBase, state } from '../../app/state';
import { api } from '../../services/api';
import { navigate, toast } from '../../app/navigation';
import { findCollectionItem } from './catalog';
import { bindMarkdownBlockEditor, currentMarkdownBlockInput, markdownBlockEditorMarkup } from '../documents/markdown';
import { applyMarkdownToEditor, markdownFormattingToolbarMarkup, flushCurrentNoteAutosave, flushSecondaryNoteAutosave, flushWorkspaceMarkdownSaves, replaceActiveWorkspaceTab, workspaceResourceTab, workspaceNoteTab, rerenderNotesContext } from '../documents/workspace';
import { flushCanvasSaves } from '../documents/canvas';
import { loadReadingNote } from '../library/documents';

type Draft = { key: string; reference: any; values: any; text: string; note: any; timer?: ReturnType<typeof setTimeout>; request?: Promise<void>; dirty: boolean; version: number };
const drafts = new Map<string, Draft>();
export const hasCollectionDrafts = () => [...drafts.values()].some(draft => draft.dirty || draft.request);
const keyFor = (ref) => `${ref.databaseId}/${ref.type}/${ref.id}`;

/** Opens an item as a full-size tab: in the active tab of `pane`, or in a new tab of it. */
export async function openCollectionInNotes(reference, { newTab = false, pane = 'primary' }: { newTab?: boolean; pane?: string } = {}) {
  await flushCurrentNoteAutosave();
  await flushSecondaryNoteAutosave();
  await flushWorkspaceMarkdownSaves();
  await flushCanvasSaves();
  const item = findCollectionItem(reference);
  if (!item) return toast('Item not found', 'error');
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

function draftFor(reference): Draft | null {
  const key = keyFor(reference);
  const existing = drafts.get(key);
  if (existing?.dirty || existing?.request) return existing;
  const item = findCollectionItem(reference);
  if (!item || item.type !== 'task') return null;
  const values = structuredClone(item.source);
  const draft = { key, reference, values, note: null, text: values.description || '', dirty: false, version: 0 };
  drafts.set(key, draft);
  return draft;
}

/** One row of the properties table at the top of the page. */
function row(label: string, control: string, id = '') {
  const head = id ? `<label for="${id}">${label}</label>` : label;
  return `<tr><th scope="row">${head}</th><td>${control}</td></tr>`;
}
function field(pane, key, label, value, type = 'text') {
  const id = `record-${pane}-${key}`;
  return row(label, `<input id="${id}" data-record-field="${escapeHtml(key)}" type="${type}" value="${escapeHtml(Array.isArray(value) ? value.join(', ') : String(value ?? ''))}">`, id);
}
function select(pane, key, label, value, options) {
  const id = `record-${pane}-${key}`;
  return row(label, `<select id="${id}" data-record-field="${key}">${options.map(([option, title]) => `<option value="${escapeHtml(String(option))}" ${String(value ?? '') === String(option) ? 'selected' : ''}>${escapeHtml(title)}</option>`).join('')}</select>`, id);
}

export function collectionRecordMarkup(resource, pane) {
  const ref = resource.content;
  const draft = draftFor(ref);
  if (!draft) return '<section class="note-pane">Item unavailable.</section>';
  const v = draft.values;
  const params = select(pane, 'project_id', 'Project', v.project_id, [['', 'No project'], ...state.projects.map(p => [p.id, p.name])])
    + select(pane, 'column_id', 'Status', v.column_id, state.taskColumns.map(c => [c.id, c.name]))
    + select(pane, 'priority', 'Priority', v.priority, [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']])
    + field(pane, 'start_date', 'Start', v.start_date, 'date') + field(pane, 'due_date', 'Due', v.due_date, 'date') + field(pane, 'labels', 'Tags', v.labels)
    + row('Checklist', `<div class="record-relations" role="group" aria-label="Checklist">${(v.checklist || []).map((item, index) => `<label class="record-relation"><input type="checkbox" data-record-check="${index}" ${item.done ? 'checked' : ''}>${escapeHtml(item.text)}</label>`).join('') || '<small>No items.</small>'}</div>`);
  const id = `record-${pane}`;
  const status = draft.dirty ? 'Unsaved changes' : 'Saved';
  // Laid out like a note: the kind, the title and the properties table, then the text.
  const header = `<div class="rich-page-eyebrow"><span>Task</span><span data-record-status role="status">${escapeHtml(status)}</span></div><input class="rich-page-title" data-record-title aria-label="Title" required maxlength="240" placeholder="Untitled" value="${escapeHtml(v.title || resource.title || '')}"><table class="rich-page-properties collection-record-fields" aria-label="Task fields"><tbody>${params}</tbody></table>`;
  return `<section class="note-pane collection-record-editor" data-collection-editor="${escapeHtml(keyFor(ref))}"><div class="collection-record-writing">${markdownFormattingToolbarMarkup("data-record-md")}<div class="markdown-block-shell">${markdownBlockEditorMarkup(draft.text, { sourceId: `${id}-source`, editorId: `${id}-editor`, ariaLabel: 'Notes for this task', assetBase: draft.note ? noteAssetBase(draft.note) : '', pageHeader: header })}</div></div></section>`;
}

async function saveDraft(key: string) {
  const draft = drafts.get(key);
  if (!draft) return;
  clearTimeout(draft.timer);
  if (draft.request) { await draft.request; return saveDraft(key); }
  if (!draft.dirty) return;
  const version = draft.version;
  const values = structuredClone(draft.values);
  const ref = draft.reference;
  draft.request = (async () => {
    if (!String(values.title || '').trim()) throw new Error('A title is required.');
    values.description = draft.text;
    const saved = await api(`/tasks/${ref.id}`, { method: 'PATCH', body: JSON.stringify(values) });
    const item = findCollectionItem(ref);
    if (item) Object.assign(item.source, saved);
    if (version === draft.version) draft.dirty = false;
    for (const pane of ['primary', 'secondary']) for (const tab of state.workspaceTabs[pane]) {
      if (tab.resource?.path === `collection/${key}`) tab.resource.title = values.title;
    }
  })();
  try { await draft.request; } finally { draft.request = undefined; }
}

export async function flushCollectionSaves() {
  await Promise.all([...drafts.keys()].map(saveDraft));
}

/** Binds the task pages under `root`; `onSaved` runs after each successful save. */
export function bindCollectionEditors(root: Element, { onSaved }: { onSaved?: () => void } = {}) {
  root?.querySelectorAll<HTMLElement>('[data-collection-editor]').forEach(host => {
    const draft = drafts.get(host.dataset.collectionEditor);
    if (!draft) return;
    const source = host.querySelector<HTMLTextAreaElement>('textarea[id$="-source"]');
    bindMarkdownBlockEditor(host.querySelector('[id$="-editor"]'), source);
    const status = host.querySelector('[data-record-status]');
    const save = async () => {
      status.textContent = 'Saving…';
      try { await saveDraft(draft.key); status.textContent = draft.dirty ? 'Unsaved changes' : 'Saved'; onSaved?.(); }
      catch (error) { status.textContent = error.message; toast(error.message, 'error'); }
    };
    const capture = () => {
      draft.values.title = host.querySelector<HTMLInputElement>('[data-record-title]').value;
      draft.text = source.value;
      host.querySelectorAll<HTMLInputElement>('[data-record-field]').forEach(input => {
        const k = input.dataset.recordField;
        draft.values[k] = ['project_id', 'column_id'].includes(k) ? Number(input.value) || null
          : k === 'labels' ? input.value.split(',').map(s => s.trim()).filter(Boolean)
          : input.type === 'date' ? input.value || null : input.value;
      });
      host.querySelectorAll<HTMLInputElement>('[data-record-check]').forEach(input => { draft.values.checklist[Number(input.dataset.recordCheck)].done = input.checked; });
      draft.dirty = true; draft.version++;
      status.textContent = 'Unsaved changes';
      clearTimeout(draft.timer); draft.timer = setTimeout(save, 650);
    };
    host.addEventListener('input', capture);
    host.addEventListener('change', capture);
    host.querySelectorAll<HTMLElement>('[data-record-md]').forEach(button => button.addEventListener('click', () => applyMarkdownToEditor(currentMarkdownBlockInput(host.querySelector('[id$="-editor"]'), true), button.dataset.recordMd)));
  });
}
