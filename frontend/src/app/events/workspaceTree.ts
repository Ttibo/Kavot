/** The vault tree of the sidebar: moving, importing, renaming and trashing its documents and folders. */
import { escapeHtml, state } from '../state';
import { refreshData, refreshState, toast } from '../navigation';
import { editorSession } from '../editorSession';
import { api } from '../../services/api';
import { closeModal, openModal } from '../../components/dialogs/controller';
import { flushCanvasSaves, removeNoteFromOpenCanvases } from '../../features/documents/canvas';
import { clearTreeSelection, selectedTreePaths } from '../../features/documents/treeSelection';
import { activeNoteLocationLabel, findWorkspaceNode, forgetWorkspaceItems, refreshWorkspaceTreeOnly, rerenderNotesContext, rerenderWorkspaceTree, renderNotes, updateWorkspaceResourcePath } from '../../features/documents/workspace';
import { flushNoteEditors, flushOpenEditors, highlighter, idOrNull, layoutProjectId, showError, type Route } from './shared';

/** Where a drop lands in the tree: the folder under the pointer, or the top level of the vault anywhere else in the panel. */
function workspaceDropTarget(element: Element | null): HTMLElement | null {
  return element?.closest<HTMLElement>('[data-workspace-drop]')
    || (element?.closest('.sidebar-panel') ? document.querySelector<HTMLElement>('#notes-tree .workspace-vault-root') : null);
}

function dropContext(target: HTMLElement) {
  if (!target?.matches?.('[data-workspace-drop]')) return null;
  return { projectId: idOrNull(target.dataset.dropProjectId), folderId: idOrNull(target.dataset.dropFolderId) };
}

const hasExternalFiles = (transfer: DataTransfer | null) => Boolean(transfer?.types && [...transfer.types].includes('Files'));

/** Marks the tree row a drop would land in. */
const dropHighlight = highlighter('workspace-drag-over');
export const resetDropHighlight = () => dropHighlight.reset();

/** The tree folder a pointer-driven drag would land in, highlighted; null outside the tree. */
export function treeDropTargetAt(element: Element | null) {
  const target = workspaceDropTarget(element);
  dropHighlight.set(target);
  return target;
}

/** Runs a change on a drop target, showing it busy meanwhile. */
async function onTarget(target: HTMLElement, run: () => Promise<void>) {
  target.setAttribute('aria-busy', 'true');
  try { await run(); }
  catch (error) { showError(error); }
  finally {
    target.removeAttribute('aria-busy');
    target.classList.remove('workspace-drag-over');
    dropHighlight.reset();
  }
}

async function uploadExternalFiles(files: File[], target: HTMLElement) {
  const context = dropContext(target);
  if (!context || !files.length) return;
  await onTarget(target, async () => {
    for (const file of files) {
      const form = new FormData();
      form.append('file', file, file.name);
      if (context.projectId) form.append('project_id', String(context.projectId));
      if (context.folderId) form.append('folder_id', String(context.folderId));
      await api('/workspace/file', { method: 'POST', body: form });
    }
    await refreshData();
    renderNotes();
    toast(`${files.length} file${files.length === 1 ? '' : 's'} imported`);
  });
}

type DropContext = NonNullable<ReturnType<typeof dropContext>>;

/** Moves a note (or the shortcut of an article note) to a project folder. */
function moveNote(noteId: number, context: DropContext) {
  const note = state.notes.find((entry) => entry.id === noteId);
  const body = JSON.stringify({ project_id: context.projectId, folder_id: context.folderId });
  if (!note?.paper_id) return api(`/notes/${noteId}`, { method: 'PATCH', body });
  if (!context.projectId) throw new Error('Article notes stay in the article folder');
  return api(`/note-placements/${noteId}`, { method: 'PUT', body });
}

async function moveFile(path: string, context: DropContext) {
  const moved = await api('/workspace/move', { method: 'POST', body: JSON.stringify({ path, project_id: context.projectId, folder_id: context.folderId }) });
  updateWorkspaceResourcePath(path, moved);
}

async function moveWorkspaceItem(path: string, target: HTMLElement) {
  const context = dropContext(target);
  const node = findWorkspaceNode(path);
  if (!context || !node) return;
  await onTarget(target, async () => {
    await flushOpenEditors();
    if (node.note_id) await api(`/notes/${node.note_id}`, { method: 'PATCH', body: JSON.stringify({ project_id: context.projectId, folder_id: context.folderId }) });
    else await moveFile(path, context);
    // Only the tree and note locations change: a full reload made every move slow.
    await refreshState(['notes', 'workspaceTree', 'projects']);
    renderNotes();
    toast('Document moved');
  });
}

/** Notes inside a folder and all its subfolders (they go to trash with it). */
function folderTreeNoteIds(folderId: number) {
  const descendants = new Set([folderId]);
  let changed = true;
  while (changed) {
    changed = false;
    state.noteFolders.forEach((item) => {
      if (descendants.has(item.parent_id) && !descendants.has(item.id)) {
        descendants.add(item.id);
        changed = true;
      }
    });
  }
  return state.notes.filter((note) => descendants.has(note.folder_id)).map((note) => note.id);
}

function treeSelectionItems() {
  return selectedTreePaths().flatMap((path) => {
    const node = findWorkspaceNode(path);
    if (!node) return [];
    const folderId = node.kind === 'directory' ? idOrNull(node.creation_context?.folder_id) : null;
    return [{ path, node, folderId, noteId: idOrNull(node.note_id) }];
  });
}

function batchToast(done: number, failed: number, verb: string) {
  const plural = (count: number) => `${count} item${count === 1 ? '' : 's'}`;
  if (failed) toast(`${plural(done)} ${verb}; ${plural(failed)} could not be ${verb}`, 'error');
  else toast(`${plural(done)} ${verb}`);
}

const TREE_SOURCES = ['notes', 'noteFolders', 'notePlacements', 'workspaceTree', 'projects'] as const;

export async function trashTreeSelection() {
  const items = treeSelectionItems();
  if (!items.length || !confirm(`Move ${items.length === 1 ? 'this item' : `these ${items.length} items`} to trash?`)) return;
  try { await flushOpenEditors(); }
  catch (error) { return showError(error); }
  let done = 0;
  for (const item of items) {
    try {
      let noteIds = item.noteId ? [item.noteId] : [];
      if (item.folderId) {
        noteIds = folderTreeNoteIds(item.folderId);
        await api(`/note-folders/${item.folderId}`, { method: 'DELETE' });
      } else {
        await api('/workspace/trash', { method: 'POST', body: JSON.stringify({ path: item.path }) });
      }
      noteIds.forEach(removeNoteFromOpenCanvases);
      forgetWorkspaceItems({ path: item.path, noteIds });
      done += 1;
    } catch {
      // Keep going: the summary reports the items that stayed in place.
    }
  }
  clearTreeSelection();
  state.expandedWorkspacePaths.add('trash');
  await refreshState([...TREE_SOURCES]);
  await rerenderNotesContext();
  batchToast(done, items.length - done, 'moved to trash');
}

async function moveTreeSelection(target: HTMLElement) {
  const context = dropContext(target);
  const items = treeSelectionItems();
  if (!context || !items.length) return;
  await onTarget(target, async () => {
    await flushOpenEditors();
    let done = 0;
    let skipped = 0;
    for (const item of items) {
      try {
        if (item.folderId) {
          // Dropping a folder on itself is a no-op; folders stay within their workspace or project.
          if (item.folderId === context.folderId) { skipped += 1; continue; }
          const folder = state.noteFolders.find((entry) => entry.id === item.folderId);
          if (!folder || (folder.project_id || null) !== context.projectId) throw new Error('Folders move within their workspace or project');
          await api(`/note-folders/${item.folderId}`, { method: 'PATCH', body: JSON.stringify({ parent_id: context.folderId }) });
        } else if (item.noteId) await moveNote(item.noteId, context);
        else await moveFile(item.path, context);
        done += 1;
      } catch {
        // Keep going: the summary reports the items that stayed in place.
      }
    }
    clearTreeSelection();
    await refreshState([...TREE_SOURCES]);
    await rerenderNotesContext();
    batchToast(done, items.length - done - skipped, 'moved');
  });
}

const TREE_DRAGS = ['workspace', 'note', 'folder'];

export function treeDragOver(event: DragEvent) {
  const target = workspaceDropTarget(event.target as Element);
  const internal = TREE_DRAGS.includes(editorSession.activeDragType);
  if (!target || !(internal || hasExternalFiles(event.dataTransfer))) return false;
  event.preventDefault();
  event.dataTransfer.dropEffect = internal ? 'move' : 'copy';
  dropHighlight.set(target);
  return true;
}

async function moveFolder(folder: HTMLElement, movedFolderId: number) {
  const movedFolder = state.noteFolders.find((item) => item.id === movedFolderId);
  const targetParentId = folder.dataset.folderDrop === 'root' ? null : Number(folder.dataset.folderDrop);
  const targetProjectId = idOrNull(folder.dataset.folderProject);
  if (!movedFolder || movedFolder.project_id !== targetProjectId) return toast('Move a folder within the same workspace or project', 'error');
  if (targetParentId === movedFolderId) return;
  try {
    await api(`/note-folders/${movedFolderId}`, { method: 'PATCH', body: JSON.stringify({ parent_id: targetParentId }) });
    state.noteScope = targetProjectId ? `project:${targetProjectId}` : 'general';
    state.noteFolderId = movedFolderId;
    await refreshState(['notes', 'noteFolders', 'workspaceTree']);
    await rerenderNotesContext(layoutProjectId(folder));
    toast('Folder and its entire tree moved');
  } catch (error) { showError(error); }
}

async function moveNoteToFolder(folder: HTMLElement, noteId: number) {
  const folderId = folder.dataset.folderDrop === 'root' ? null : Number(folder.dataset.folderDrop);
  const targetProjectId = idOrNull(folder.dataset.folderProject);
  const projectId = layoutProjectId(folder);
  const note = state.notes.find((item) => item.id === noteId);
  if (note?.paper_id && !targetProjectId)
    return toast('The original note stays in the article folder; only move its shortcut into a project', 'error');
  try {
    await moveNote(noteId, { projectId: targetProjectId, folderId });
    state.noteScope = targetProjectId ? `project:${targetProjectId}` : 'general';
    state.noteFolderId = folderId || 'all';
    state.currentNoteId = noteId;
    await refreshState(['notes', 'notePlacements', 'workspaceTree', 'projects']);
    await rerenderNotesContext(projectId);
    toast(note?.paper_id ? 'Shortcut moved; article note unchanged' : `Note moved to ${activeNoteLocationLabel(projectId)}`);
  } catch (error) { showError(error); }
}

export async function treeDrop(event: DragEvent, transfer: string) {
  const target = workspaceDropTarget(event.target as Element);
  if (target && hasExternalFiles(event.dataTransfer)) {
    event.preventDefault();
    await uploadExternalFiles([...event.dataTransfer.files], target);
    return true;
  }
  if (target && (transfer === 'selection:tree' || transfer.startsWith('workspace:'))) {
    event.preventDefault();
    editorSession.activeDragType = null;
    if (transfer === 'selection:tree') await moveTreeSelection(target);
    else await moveWorkspaceItem(transfer.slice(10), target);
    return true;
  }
  const folder = (event.target as Element).closest<HTMLElement>('[data-folder-drop]');
  if (!folder || !(transfer.startsWith('folder:') || transfer.startsWith('note:'))) return false;
  event.preventDefault();
  folder.classList.remove('drag-over');
  if (transfer.startsWith('folder:')) await moveFolder(folder, Number(transfer.slice(7)));
  else await moveNoteToFolder(folder, Number(transfer.slice(5)));
  return true;
}

function renameNoteModal(note) {
  openModal(`<header class="modal-header"><h2>Rename note</h2></header><form id="rename-note-form" class="modal-body form-grid"><label class="form-field full">Note title<input name="title" required maxlength="240" value="${escapeHtml(note.title)}"></label><div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button class="button button-primary">Rename</button></div></form>`);
  const form = document.querySelector<HTMLFormElement>('#rename-note-form');
  form.querySelector<HTMLInputElement>('input').select();
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = String(new FormData(form).get('title') || '').trim();
    if (!title) return;
    try {
      Object.assign(note, await api(`/notes/${note.id}`, { method: 'PATCH', body: JSON.stringify({ title }) }));
      await refreshState(['notes', 'workspaceTree']);
      const query = document.querySelector<HTMLInputElement>('#note-filter')?.value || '';
      closeModal();
      await rerenderNotesContext();
      const filter = document.querySelector<HTMLInputElement>('#note-filter');
      if (filter && query) { filter.value = query; filter.dispatchEvent(new Event('input', { bubbles: true })); }
      toast('Note renamed');
    } catch (error) { showError(error); }
  });
}

/** Clears the editors of the documents under a deleted trash entry. */
function forgetTrashEntry(id: string) {
  const marker = `trash/${id}/`;
  if (state.primaryResource?.path?.startsWith(marker)) state.primaryResource = null;
  if (state.secondaryResource?.path?.startsWith(marker)) state.secondaryResource = null;
}

export const treeClickRoutes: Route[] = [
  { selector: '[data-trash-tree-selection]', run: () => trashTreeSelection() },
  { selector: '[data-trash-workspace]', run: async (button) => {
    const path = button.dataset.trashWorkspace;
    const trashedNoteId = idOrNull(findWorkspaceNode(path)?.note_id);
    if (!confirm('Move this item to trash?')) return;
    try {
      await flushNoteEditors();
      await flushCanvasSaves();
      await api('/workspace/trash', { method: 'POST', body: JSON.stringify({ path }) });
      if (trashedNoteId) removeNoteFromOpenCanvases(trashedNoteId);
      forgetWorkspaceItems({ path, noteIds: trashedNoteId ? [trashedNoteId] : [] });
      state.expandedWorkspacePaths.add('trash');
      await refreshData();
      await rerenderNotesContext();
      toast('Item moved to trash');
    } catch (error) { showError(error); }
  } },
  { selector: '[data-restore-trash]', run: async (button) => {
    try {
      const restored = await api(`/workspace/trash/${button.dataset.restoreTrash}/restore`, { method: 'POST' });
      const parentPath = restored.path.split('/').slice(0, -1).join('/');
      state.expandedWorkspacePaths.add(restored.path.split('/')[0]);
      if (parentPath) state.expandedWorkspacePaths.add(parentPath);
      await refreshData();
      await rerenderNotesContext();
      toast('Item restored to its original location');
    } catch (error) { showError(error); }
  } },
  { selector: '[data-delete-trash]', run: async (button) => {
    if (!confirm('Permanently delete this item? This cannot be undone.')) return;
    try {
      await api(`/workspace/trash/${button.dataset.deleteTrash}`, { method: 'DELETE' });
      forgetTrashEntry(button.dataset.deleteTrash);
      await refreshData();
      await rerenderNotesContext();
      toast('Item permanently deleted');
    } catch (error) { showError(error); }
  } },
  { selector: '[data-workspace-toggle]', run: (toggle) => {
    const path = toggle.dataset.workspaceToggle;
    if (state.expandedWorkspacePaths.has(path)) state.expandedWorkspacePaths.delete(path);
    else state.expandedWorkspacePaths.add(path);
    return rerenderWorkspaceTree();
  } },
  { selector: '[data-inline-rename-folder]', run: (button) => {
    state.editingNoteFolderId = Number(button.dataset.inlineRenameFolder);
    rerenderWorkspaceTree();
  } },
  { selector: '[data-rename-note]', run: async (button) => {
    await flushNoteEditors();
    const note = state.notes.find((item) => item.id === Number(button.dataset.renameNote));
    if (note) renameNoteModal(note);
  } },
  { selector: '[data-inline-rename-workspace]', run: async (button) => {
    await flushNoteEditors();
    state.editingWorkspacePath = button.dataset.inlineRenameWorkspace;
    rerenderWorkspaceTree();
  } },
];

/** Deleting a note or a folder from its dialog or its context menu (after the routes that open documents). */
export const treeDeleteRoutes: Route[] = [
  { selector: '[data-delete-note]', run: async (button) => {
    if (!confirm('Move this note to trash?')) return;
    const deletedNoteId = Number(button.dataset.deleteNote);
    const projectId = idOrNull(button.dataset.workspaceProject) || layoutProjectId(button);
    try {
      await flushCanvasSaves();
      await api(`/notes/${deletedNoteId}`, { method: 'DELETE' });
      removeNoteFromOpenCanvases(deletedNoteId);
      forgetWorkspaceItems({ noteIds: [deletedNoteId] });
      closeModal();
      state.currentNoteId = null;
      state.expandedWorkspacePaths.add('trash');
      await refreshState(['notes', 'workspaceTree', 'projects', 'papers']);
      await rerenderNotesContext(projectId);
      toast('Note moved to trash');
    } catch (error) { showError(error); }
  } },
  { selector: '[data-delete-folder]', run: async (button) => {
    if (!confirm('Move this folder, its subfolders, and notes to trash?')) return;
    const folderId = Number(button.dataset.deleteFolder);
    const folder = state.noteFolders.find((item) => item.id === folderId);
    const removedNoteIds = folderTreeNoteIds(folderId);
    try {
      await flushCanvasSaves();
      await api(`/note-folders/${folderId}`, { method: 'DELETE' });
      removedNoteIds.forEach(removeNoteFromOpenCanvases);
      forgetWorkspaceItems({ noteIds: removedNoteIds });
      closeModal();
      state.noteFolderId = 'all';
      state.expandedWorkspacePaths.add('trash');
      await refreshState(['notes', 'noteFolders', 'workspaceTree', 'projects']);
      await rerenderNotesContext(folder?.project_id || null);
      toast('Folder moved to trash');
    } catch (error) { showError(error); }
  } },
];

export const treeChangeRoutes: Route<Event>[] = [
  { selector: '[data-workspace-folder-color]', run: async (input, event) => {
    event.stopPropagation();
    const folderId = Number(input.dataset.workspaceFolderColor);
    try {
      const updated = await api(`/note-folders/${folderId}`, { method: 'PATCH', body: JSON.stringify({ color: (input as HTMLInputElement).value }) });
      const cached = state.noteFolders.find((item) => item.id === folderId);
      if (cached) Object.assign(cached, updated);
      await refreshWorkspaceTreeOnly();
      toast('Folder color updated');
    } catch (error) { showError(error); }
  } },
];
