/** Field types of custom collections: how each one is edited, read back and displayed. */
import { escapeHtml } from '../../app/state';

/** `optionLabels` shows a readable label for stored choice values (built-in collections only). */
export type ListColumn = { id: string; name: string; type: string; options?: string[]; optionLabels?: Record<string, string>; default?: string };
export type CustomField = { id: string; name: string; type: string; required?: boolean; options?: string[]; optionLabels?: Record<string, string>; default?: unknown; columns?: ListColumn[] };
const choices = (item: { options?: string[]; optionLabels?: Record<string, string> }, value: unknown) =>
  (item.options || []).map(option => `<option value="${escapeHtml(option)}" ${option === value ? 'selected' : ''}>${escapeHtml(item.optionLabels?.[option] || option)}</option>`).join('');

export const FIELD_KINDS: { value: string; label: string; hint: string }[] = [
  { value: 'text', label: 'Text', hint: 'A short line of text.' },
  { value: 'markdown', label: 'Long text', hint: 'Several lines of text.' },
  { value: 'url', label: 'Web link', hint: 'Shown as a clickable link that opens the page.' },
  { value: 'email', label: 'Email', hint: 'Shown as a link that writes an email.' },
  { value: 'select', label: 'Choice', hint: 'One value from a list. Can group items in the kanban.' },
  { value: 'number', label: 'Number', hint: 'Can be sorted and filtered by value.' },
  { value: 'boolean', label: 'Checkbox', hint: 'Yes or no.' },
  { value: 'date', label: 'Date', hint: 'Picked from a calendar.' },
  { value: 'tags', label: 'Tags', hint: 'Several labels, separated by commas.' },
  { value: 'list', label: 'List', hint: 'Rows with the columns you define, like the deadlines of a conference.' },
];

/** Types a column of a list field can have. */
export const LIST_COLUMN_KINDS = FIELD_KINDS.filter(kind => ['text', 'number', 'boolean', 'date', 'url', 'email', 'select'].includes(kind.value));
/** Labels of field types, built-in ones included, for read-only summaries. */
export const fieldKindLabel = (type: string) => FIELD_KINDS.find(kind => kind.value === type)?.label || ({ datetime: 'Date and time' } as Record<string, string>)[type] || type;

function listCell(column: ListColumn, value: unknown, label: string) {
  const attributes = `data-list-column="${escapeHtml(column.id)}" aria-label="${escapeHtml(label)}"`;
  if (column.type === 'boolean') return `<input type="checkbox" ${attributes} ${value ? 'checked' : ''}>`;
  if (column.type === 'select') return `<select ${attributes}><option value="">—</option>${choices(column, value)}</select>`;
  const type = ({ number: 'number', date: 'date', datetime: 'datetime-local', url: 'url', email: 'email' })[column.type] || 'text';
  const text = String(value ?? '');
  return `<input type="${type}" ${type === 'number' ? 'step="any"' : ''} value="${escapeHtml(column.type === 'datetime' ? text.slice(0, 16) : text)}" ${attributes}>`;
}
function listRow(field: CustomField, row: Record<string, unknown>, index: number) {
  const ids = new Set((field.columns || []).map(column => column.id));
  const extra = Object.fromEntries(Object.entries(row).filter(([key]) => !ids.has(key)));
  return `<tr data-list-row ${Object.keys(extra).length ? `data-list-extra="${escapeHtml(JSON.stringify(extra))}"` : ''}>${(field.columns || []).map(column => `<td>${listCell(column, column.id in row ? row[column.id] : column.default, `${column.name} ${index + 1}`)}</td>`).join('')}<td class="custom-list-remove"><button type="button" class="icon-button" data-list-remove aria-label="Remove row ${index + 1} of ${escapeHtml(field.name)}">×</button></td></tr>`;
}
/** Editable table for a list field: one row per entry, one column per column of the field. */
function listFieldMarkup(field: CustomField, value: unknown, attributes = '') {
  const rows = Array.isArray(value) ? value : [];
  return `<div class="custom-list-field" data-list-field="${escapeHtml(field.id)}" ${attributes}><table><thead><tr>${(field.columns || []).map(column => `<th scope="col">${escapeHtml(column.name)}</th>`).join('')}<th><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows.map((row, index) => listRow(field, row || {}, index)).join('')}</tbody></table><button type="button" class="button button-small" data-list-add>＋ Add a row</button></div>`;
}
/** Rows of a list field, skipping rows where every cell is empty. */
function readListField(field: CustomField, container: Element) {
  return [...container.querySelectorAll<HTMLElement>('[data-list-row]')].map(tr => {
    const row: Record<string, unknown> = {};
    let filled = false;
    (field.columns || []).forEach(column => {
      const control = tr.querySelector<HTMLInputElement>(`[data-list-column="${CSS.escape(column.id)}"]`);
      if (!control) return;
      const raw = control.type === 'checkbox' ? control.checked : control.value.trim();
      if (raw === '' || raw === false) return;
      row[column.id] = column.type === 'number' ? Number(raw) : raw;
      filled = true;
    });
    return filled ? { ...JSON.parse(tr.dataset.listExtra || '{}'), ...row } : null;
  }).filter(Boolean);
}
/** Add / remove buttons of list fields; `changed` runs after the rows change. */
export function bindListFields(root: Element, fields: CustomField[], changed: () => void = () => {}) {
  root.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    const container = target.closest<HTMLElement>('[data-list-field]');
    const field = container && fields.find(item => item.id === container.dataset.listField);
    if (!field) return;
    if (target.closest('[data-list-add]')) {
      const body = container.querySelector('tbody');
      body.insertAdjacentHTML('beforeend', listRow(field, {}, body.children.length));
      body.lastElementChild?.querySelector<HTMLElement>('input, select')?.focus();
      changed();
    } else if (target.closest('[data-list-remove]')) {
      target.closest('tr')?.remove();
      changed();
    }
  });
}

/** The address a link field points to, or '' when the value cannot be opened safely. */
export function fieldHref(type: string, value: unknown) {
  const text = String(value ?? '').trim();
  if (type === 'url') return /^https?:\/\/[^\s/]+/i.test(text) ? text : '';
  if (type === 'email') return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text) ? `mailto:${text}` : '';
  return '';
}

/** Input markup for one field; `attributes` carries the name or data attribute the caller reads back. */
export function customFieldControl(field: CustomField, value: unknown, attributes: string) {
  if (field.type === 'list') return listFieldMarkup(field, value, attributes);
  const required = field.required && field.type !== 'boolean' ? 'required' : '';
  const text = value == null ? '' : Array.isArray(value) ? value.join(', ') : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (field.type === 'boolean') return `<input type="checkbox" ${attributes} ${value ? 'checked' : ''}>`;
  if (field.type === 'select') return `<select ${attributes} ${required}><option value="">—</option>${choices(field, value)}</select>`;
  if (['markdown', 'json', 'relation'].includes(field.type)) return `<textarea ${attributes} ${required}>${escapeHtml(text)}</textarea>`;
  const type = ({ number: 'number', date: 'date', datetime: 'datetime-local', url: 'url', email: 'email' })[field.type] || 'text';
  const placeholder = ({ url: 'https://…', email: 'name@example.org' })[field.type];
  const input = `<input type="${type}" value="${escapeHtml(text)}" ${attributes} ${field.type === 'number' ? 'step="any"' : ''} ${placeholder ? `placeholder="${placeholder}"` : ''} ${required}>`;
  if (field.type !== 'url' && field.type !== 'email') return input;
  const href = fieldHref(field.type, value);
  return `<span class="custom-link-input">${input}<a class="button button-small" data-field-link="${field.type}" href="${escapeHtml(href || '#')}" target="_blank" rel="noopener noreferrer" ${href ? '' : 'hidden'} aria-label="${field.type === 'url' ? 'Open the link' : 'Write an email'}">${field.type === 'url' ? 'Open ↗' : 'Email ✉'}</a></span>`;
}

/** Keeps the Open / Email button of link inputs in step with what the user types. */
export function bindFieldLinks(root: Element) {
  root.addEventListener('input', event => {
    const input = event.target as HTMLInputElement;
    const link = input.closest('.custom-link-input')?.querySelector<HTMLAnchorElement>('[data-field-link]');
    if (!link) return;
    const href = fieldHref(link.dataset.fieldLink, input.value);
    link.hidden = !href;
    link.href = href || '#';
  });
}

/** Converts what a form control holds back into the value stored for the field. */
export function readFieldValue(field: CustomField, control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLElement) {
  if (field.type === 'list') return readListField(field, control);
  if (field.type === 'boolean') return (control as HTMLInputElement).checked;
  const raw = (control as HTMLInputElement).value.trim();
  if (field.type === 'number') return raw === '' ? null : Number(raw);
  if (field.type === 'tags') return raw.split(',').map(tag => tag.trim()).filter(Boolean);
  if (['json', 'relation'].includes(field.type)) return raw ? JSON.parse(raw) : null;
  return field.type === 'date' || field.type === 'select' ? raw || null : raw;
}
