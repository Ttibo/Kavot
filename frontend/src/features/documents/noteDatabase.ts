type NoteColumn = { name: string; type: 'text' | 'number' | 'date' | 'checkbox' };
type NoteDatabase = { title: string; columns: NoteColumn[]; rows: string[][] };
const html = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function parseNoteDatabase(text: string): NoteDatabase | null {
  try {
    const value = JSON.parse(text);
    if (typeof value.title !== 'string' || !Array.isArray(value.columns) || !value.columns.length || value.columns.length > 50 || !Array.isArray(value.rows) || value.rows.length > 5000) return null;
    if (!value.columns.every(c => c && typeof c.name === 'string' && ['text', 'number', 'date', 'checkbox'].includes(c.type))) return null;
    if (!value.rows.every(r => Array.isArray(r) && r.length === value.columns.length && r.every(v => typeof v === 'string'))) return null;
    return value;
  } catch { return null; }
}
export function noteDatabaseMarkup(text: string): string | null {
  const db = parseNoteDatabase(text);
  if (!db) return null;
  return `<section class="note-database"><header><strong>${html(db.title)}</strong><small>${db.rows.length} rows · Database</small></header><div class="markdown-table-wrap"><table><thead><tr>${db.columns.map(c => `<th>${html(c.name)} <small>${html(c.type)}</small></th>`).join('')}</tr></thead><tbody>${db.rows.map(row => `<tr>${row.map((v, i) => `<td>${db.columns[i].type === 'checkbox' ? (v === 'true' ? '☑' : '☐') : html(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>`;
}

