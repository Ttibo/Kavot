/** Picks one article or one task to place on a canvas as a card. */
import { escapeHtml, modal, truncate } from '../../../app/state';
import { openModal, closeModal } from '../../../components/dialogs/controller';
import { editorSession } from '../../../app/editorSession';
import { collectionItems } from '../../collections/catalog';

type Representation = 'record' | 'note' | 'pdf' | 'file';
type Options = {
  projectId: number | null;
  hasItem: (item: any, representation: Representation) => boolean;
  addItem: (item: any, representation: Representation) => Promise<void>;
};

const KINDS: [string, string][] = [['articles', 'Articles'], ['tasks', 'Tasks']];

/** Items of a kind, only those of a project when one is given. */
function items(kind: string, projectId: number | null) {
  const all = collectionItems(kind).filter(item => !item.source?.trashed_at && !item.source?.archived_at);
  if (!projectId) return all;
  const belongs = (source: any) => Number(source?.project_id) === projectId
    || source?.project_ids?.some((id: unknown) => Number(id) === projectId)
    || source?.projects?.some((project: any) => Number(project.id) === projectId);
  return all.filter(item => belongs(item.source));
}

export function openCanvasItemPicker(options: Options) {
  let kind = 'articles';
  let busy = false;
  openModal(`<header class="modal-header"><span class="template-studio-eyebrow">Add to canvas</span><h2>An article or a task</h2></header>
    <div class="canvas-item-picker">
      <div class="canvas-item-picker-controls">
        <div class="segmented" role="tablist" aria-label="Kind">${KINDS.map(([id, label]) => `<button type="button" role="tab" data-pick-kind="${id}">${label}</button>`).join('')}</div>
        <label class="collection-project-filter"><input type="checkbox" data-project-only ${options.projectId ? '' : 'disabled'}>This project only</label>
      </div>
      <input type="search" data-item-search placeholder="Search titles, authors and content…" aria-label="Search">
      <div class="collection-picker-results" data-item-results></div>
    </div>
    <footer class="collection-picker-footer"><p data-item-error role="alert"></p><button class="button" data-close-modal>Close</button></footer>`, true);
  modal.classList.add('modal-collection-picker', 'modal-item-picker');
  editorSession.modalCleanup = () => modal.classList.remove('modal-collection-picker', 'modal-item-picker');
  const results = modal.querySelector<HTMLElement>('[data-item-results]')!;
  const search = modal.querySelector<HTMLInputElement>('[data-item-search]')!;
  const projectOnly = modal.querySelector<HTMLInputElement>('[data-project-only]')!;
  const error = modal.querySelector<HTMLElement>('[data-item-error]')!;
  let visible: any[] = [];
  const action = (item: any, index: number, representation: Representation, label: string) =>
    `<button class="button button-small" type="button" data-pick-item="${index}" data-representation="${representation}" ${options.hasItem(item, representation) ? 'disabled' : ''}>${options.hasItem(item, representation) ? 'On canvas' : label}</button>`;
  function render() {
    modal.querySelectorAll<HTMLElement>('[data-pick-kind]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.pickKind === kind)));
    const query = search.value.trim().toLocaleLowerCase();
    visible = items(kind, projectOnly.checked ? options.projectId : null)
      .filter(item => `${item.title} ${item.detail} ${item.meta}`.toLocaleLowerCase().includes(query)).slice(0, 100);
    results.innerHTML = visible.length ? visible.map((item, index) => {
      const actions = item.type === 'paper' ? action(item, index, 'note', 'Article note') : action(item, index, 'record', 'Add card');
      return `<article class="collection-picker-item"><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(truncate(item.detail || '', 130))}</p><small>${escapeHtml(item.meta || '')}</small></div><div>${actions}</div></article>`;
    }).join('') : `<p class="collection-picker-empty">No ${kind === 'tasks' ? 'task' : 'article'} found.</p>`;
  }
  async function run(work: () => Promise<void>) {
    if (busy) return;
    busy = true; error.textContent = '';
    try { await work(); await closeModal(); }
    catch (reason) { error.textContent = (reason as Error).message; }
    finally { busy = false; if (results.isConnected) render(); }
  }
  modal.querySelectorAll<HTMLElement>('[data-pick-kind]').forEach(button => button.addEventListener('click', () => { kind = button.dataset.pickKind!; render(); search.focus(); }));
  search.addEventListener('input', render);
  projectOnly.addEventListener('change', render);
  results.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-pick-item]');
    if (button && !button.disabled) void run(() => options.addItem(visible[Number(button.dataset.pickItem)], button.dataset.representation as Representation));
  });
  render();
  search.focus();
}
