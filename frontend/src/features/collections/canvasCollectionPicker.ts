import { collectionIconMarkup } from './icons';
import { escapeHtml, modal, truncate } from '../../app/state';
import { openModal, closeModal } from '../../components/dialogs/controller';
import { editorSession } from '../../app/editorSession';
import { canvasCollections, canvasCollectionItems } from './canvasCollections';

type Representation = 'record' | 'note' | 'pdf' | 'file';
type Options = {
  projectId: number | null;
  hasCollection: (databaseId:string, scope:string) => boolean;
  hasItem: (item:any, representation:Representation) => boolean;
  addCollection: (databaseId:string, scope:string) => Promise<void>;
  addItem: (item:any, representation:Representation) => Promise<void>;
  createItem: (databaseId:string) => Promise<void>;
};

export function openCanvasCollectionPicker(options: Options) {
  const databases = canvasCollections();
  let databaseId = databases[0]?.id || 'articles';
  let mode = 'collection';
  let busy = false;
  openModal(`<header class="modal-header"><span class="template-studio-eyebrow">Add to canvas</span><h2>Collection</h2><p>Add a live collection, or choose one item to work with.</p></header><div class="collection-picker-layout"><nav class="collection-picker-catalog" aria-label="Choose a collection">${databases.map(database => `<button type="button" data-pick-database="${escapeHtml(database.id)}">${collectionIconMarkup(database)}<span>${escapeHtml(database.name)}</span><small>${canvasCollectionItems(database.id).length}</small></button>`).join('')}</nav><section class="collection-picker-detail"><div class="collection-picker-modes" role="tablist" aria-label="What to add"><button type="button" role="tab" data-collection-mode="collection">Entire collection</button><button type="button" role="tab" data-collection-mode="item">One item</button></div><div class="collection-picker-controls"><label class="collection-project-filter"><input type="checkbox" data-collection-project-only ${options.projectId ? '' : 'disabled'}>This project only</label><button class="button button-small" type="button" data-collection-create hidden></button></div><label class="form-field collection-item-search" hidden>Find an item<input type="search" data-collection-search placeholder="Search titles, authors and content…" aria-label="Search collection items"></label><div class="collection-picker-results" data-collection-results></div></section></div><footer class="collection-picker-footer"><p data-collection-error role="alert"></p><button class="button" data-close-modal>Cancel</button><button class="button button-primary" data-add-collection>Add collection</button></footer>`, true);
  modal.classList.add('modal-collection-picker');
  editorSession.modalCleanup = () => modal.classList.remove('modal-collection-picker');
  const results = modal.querySelector<HTMLElement>('[data-collection-results]')!;
  const search = modal.querySelector<HTMLInputElement>('[data-collection-search]')!;
  const projectOnly = modal.querySelector<HTMLInputElement>('[data-collection-project-only]')!;
  const add = modal.querySelector<HTMLButtonElement>('[data-add-collection]')!;
  const create = modal.querySelector<HTMLButtonElement>('[data-collection-create]')!;
  const error = modal.querySelector<HTMLElement>('[data-collection-error]')!;
  let visibleItems: any[] = [];
  const scope = () => projectOnly.checked ? 'project' : 'all';
  const action = (item:any,index:number,representation:Representation,label:string) => `<button class="button button-small" type="button" data-pick-item="${index}" data-representation="${representation}" ${options.hasItem(item,representation) ? 'disabled' : ''}>${options.hasItem(item,representation) ? `${label} · On canvas` : label}</button>`;
  function render() {
    const database = databases.find(item => item.id === databaseId)!;
    // Custom databases have no shared project membership field.
    const supportsProject = ['articles','notes','tasks','conferences','datasets'].includes(databaseId);
    projectOnly.disabled = !options.projectId || !supportsProject;
    if (projectOnly.disabled) projectOnly.checked = false;
    modal.querySelectorAll<HTMLElement>('[data-pick-database]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.pickDatabase === databaseId)));
    modal.querySelectorAll<HTMLElement>('[data-collection-mode]').forEach(button => button.setAttribute('aria-selected',String(button.dataset.collectionMode === mode)));
    const items = canvasCollectionItems(databaseId, projectOnly.checked ? options.projectId : null);
    visibleItems = items.filter(item => `${item.title} ${item.detail} ${item.meta}`.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()));
    modal.querySelector<HTMLElement>('.collection-item-search')!.hidden = mode !== 'item';
    create.hidden = mode !== 'item' || !['datasets','conferences'].includes(databaseId);
    create.textContent = databaseId === 'datasets' ? '＋ Create dataset' : '＋ Create conference';
    add.hidden = mode !== 'collection';
    add.disabled = options.hasCollection(databaseId,scope());
    add.textContent = add.disabled ? 'Already on canvas' : 'Add collection';
    results.innerHTML = mode === 'collection'
      ? `<div class="collection-picker-summary">${collectionIconMarkup(database)}<h3>${escapeHtml(database.name)}</h3><p>${items.length} item${items.length === 1 ? '' : 's'} · ${projectOnly.checked ? 'This project' : 'Workspace'}</p><small>A live table on your canvas. New items and changes appear automatically.</small><div>${items.slice(0,5).map(item => `<span>${escapeHtml(item.title)}</span>`).join('') || '<span>This collection is empty. You can still add it.</span>'}${items.length > 5 ? `<small>+ ${items.length - 5} more</small>` : ''}</div></div>`
      : visibleItems.map((item,index) => `<article class="collection-picker-item"><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(truncate(item.detail || '', 130))}</p><small>${escapeHtml(item.meta || '')}</small></div><div>${item.type === 'paper' ? action(item,index,'note','Article note') : action(item,index,'record','Add card')}</div></article>`).join('') || '<div class="collection-picker-empty"><strong>No matching items</strong><p>Try another search or collection.</p></div>';
  }
  async function run(work:()=>Promise<void>) {
    if (busy) return; busy = true; error.textContent = '';
    modal.querySelectorAll<HTMLButtonElement>('button').forEach(button => { if (!button.disabled) { button.dataset.pendingAction = 'true'; button.disabled = true; } });
    try { await work(); await closeModal(); }
    catch (reason) { error.textContent = reason.message; }
    finally { busy = false; modal.querySelectorAll<HTMLButtonElement>('[data-pending-action]').forEach(button => { button.disabled = false; delete button.dataset.pendingAction; }); if (results.isConnected) render(); }
  }
  modal.querySelectorAll<HTMLElement>('[data-pick-database]').forEach(button => button.addEventListener('click', () => { databaseId = button.dataset.pickDatabase!; search.value = ''; render(); }));
  modal.querySelectorAll<HTMLElement>('[data-collection-mode]').forEach(button => button.addEventListener('click', () => { mode = button.dataset.collectionMode!; render(); if (mode === 'item') search.focus(); }));
  search.addEventListener('input', render); projectOnly.addEventListener('change', render);
  add.addEventListener('click', () => void run(() => options.addCollection(databaseId,scope())));
  results.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-pick-item]');
    if (button && !button.disabled) void run(() => options.addItem(visibleItems[Number(button.dataset.pickItem)],button.dataset.representation as Representation));
  });
  create.addEventListener('click', async () => { await closeModal(); await options.createItem(databaseId); });
  render();
}
