import { escapeHtml, noteAssetBase, renderMarkdown, state } from '../../app/state';
import { currentMarkdownBlockInput } from './markdown';
import { noteContextLabel } from './workspace';

export function noteReferencePickerMarkup() {
  return `<div class="note-link-picker editor-reference-picker hidden" data-reference-picker role="dialog" aria-label="Reference a note"><div class="note-link-picker-head"><span>Notes, hypotheses and results</span><button type="button" data-reference-close aria-label="Close references">×</button></div><input data-reference-search type="search" placeholder="Search notes, hypotheses, results…" aria-label="Search references"><div class="note-link-results" data-reference-results></div></div>`;
}

/** Uses the same Markdown links and absolute document offsets as the note editor. */
export function bindNoteReferences(root: HTMLElement, editor: HTMLElement, excludeNoteId?: number) {
  const picker = root.querySelector<HTMLElement>('[data-reference-picker]');
  const search = root.querySelector<HTMLInputElement>('[data-reference-search]');
  const results = root.querySelector<HTMLElement>('[data-reference-results]');
  let range: { start: number; end: number } | null = null;
  const close = () => { picker.classList.add('hidden'); range = null; currentMarkdownBlockInput(editor, true); };
  const render = () => {
    const query = search.value.trim().toLocaleLowerCase();
    const notes = state.notes.filter(note => note.id !== excludeNoteId &&
      `${note.title} ${note.template_name || ''} ${noteContextLabel(note)}`.toLocaleLowerCase().includes(query))
      .sort((a, b) => a.title.localeCompare(b.title)).slice(0, 30);
    results.innerHTML = notes.length ? notes.map(note => `<button type="button" class="note-link-result" data-reference-note="${note.id}"><span>⌁</span><div><strong>${escapeHtml(note.title)}</strong><small>${escapeHtml(note.template_name || noteContextLabel(note))}</small></div></button>`).join('') : '<div class="note-link-empty">No notes found.</div>';
  };
  const open = (start?: number, end?: number, query = '') => {
    const input = currentMarkdownBlockInput(editor, true);
    if (!input) return;
    range = { start: start ?? input.selectionStart, end: end ?? input.selectionEnd };
    picker.classList.remove('hidden'); search.value = query; render(); search.focus();
  };
  root.querySelector('[data-reference-open]')?.addEventListener('click', () => open());
  root.querySelector('[data-reference-close]')?.addEventListener('click', close);
  search.addEventListener('input', render);
  picker.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'Enter' && event.target === search) { event.preventDefault(); results.querySelector<HTMLButtonElement>('button')?.click(); }
  });
  results.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-reference-note]');
    const note = state.notes.find(item => item.id === Number(button?.dataset.referenceNote));
    const input = currentMarkdownBlockInput(editor);
    if (!note || !range || !input) return;
    const label = note.title.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]').replaceAll('\n', ' ');
    const selection = range;
    close();
    input.setRangeText(`[${label}](#note-${note.id})`, selection.start, selection.end);
    input.focus();
  });
  editor.addEventListener('input', () => {
    const input = currentMarkdownBlockInput(editor);
    if (!input || !picker.classList.contains('hidden')) return;
    const match = input.value.slice(0, input.selectionStart).match(/\[\[([^\]\n]*)$/);
    if (match) open(input.selectionStart - match[0].length, input.selectionStart, match[1]);
  });
}

/** Preview references without discarding the task's unsaved form. */
export function bindTaskReferencePreview(root: HTMLElement) {
  root.addEventListener('click', event => {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#note-"]');
    if (!link) return;
    event.preventDefault(); event.stopPropagation();
    const note = state.notes.find(item => item.id === Number(link.getAttribute('href').slice(6)));
    const preview = root.querySelector<HTMLElement>('[data-task-reference-preview]');
    preview.hidden = false;
    preview.innerHTML = `<button type="button" class="button button-small" data-preview-close>Close preview</button><h3>${escapeHtml(note?.title || 'Note unavailable')}</h3><div class="markdown-preview">${note ? renderMarkdown(note.content, noteAssetBase(note)) : 'This note no longer exists.'}</div>`;
    preview.querySelector('[data-preview-close]').addEventListener('click', () => { preview.hidden = true; });
    preview.scrollIntoView({ block: 'nearest' });
  });
}
