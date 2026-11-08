/** The Library: opening articles, their folders, and dragging articles or folders onto a folder or a project. */
import { escapeHtml, state, viewShown } from '../state';
import { navigate, refreshData, refreshState, render, toast } from '../navigation';
import { editorSession } from '../editorSession';
import { api } from '../../services/api';
import { closeModal } from '../../components/dialogs/controller';
import { activeNoteProjectId, renderNotes } from '../../features/documents/workspace';
import { openProjectArea } from '../../features/projects/navigation';
import { paperFolderDescendantIds, paperFolderIds, paperFolderLabel, renderPapers } from '../../features/library/filters';
import { openPaper, openPaperPdfExternally, paperPdfUploadModal } from '../../features/library/documents';
import { idOrNull, removeClasses, showError, type Route } from './shared';

const DROP_TARGETS = '[data-paper-folder-drop].drag-over, [data-paper-project-drop].drag-over';

/** A click right after a drag must not open the dragged article. */
let suppressPaperOpenUntil = 0;
const suppressPaperOpen = () => { suppressPaperOpenUntil = Date.now() + 500; };
const paperOpenSuppressed = () => Date.now() < suppressPaperOpenUntil;

function endPaperDrag() {
  document.body.classList.remove('paper-drag-active');
  removeClasses(DROP_TARGETS, 'drag-over');
}

function readInLibrary(paperId: number, projectContext?: number | null) {
  state.libraryReadingPaperId = paperId;
  if (projectContext !== undefined) state.paperProjectContext = projectContext;
  renderPapers();
}

let folderDropBusy = false;
async function completeLibraryFolderDrop(folderId: number, folder: HTMLElement | null, project: HTMLElement | null) {
  endPaperDrag();
  if (folderDropBusy || !state.paperFolders.some(item => item.id === folderId)) return;
  const descendants = paperFolderDescendantIds(folderId);
  const parentId = folder?.dataset.paperFolderDrop === 'root' ? null : Number(folder?.dataset.paperFolderDrop);
  if (!project && (!folder || descendants.has(parentId))) return toast('A folder cannot be moved into itself or its subfolders', 'error');
  folderDropBusy = true;
  const target = project || folder;
  target?.setAttribute('aria-busy', 'true');
  try {
    if (project) {
      const projectId = Number(project.dataset.paperProjectDrop);
      if (!state.projects.some(item => item.id === projectId)) return;
      const papers = state.papers.filter(paper => paperFolderIds(paper).some(id => descendants.has(id)));
      const pending = papers.filter(paper => !paper.projects.some(link => link.id === projectId));
      let added = 0;
      let failed = 0;
      for (const paper of pending) {
        try { await api(`/papers/${paper.id}/projects/${projectId}`, { method: 'POST' }); added++; }
        catch { failed++; }
      }
      await refreshData();
      renderPapers();
      toast(failed ? `${added} articles linked · ${failed} failed. Drop the folder again to retry.` : `${added} articles linked · ${papers.length - pending.length} already in project`, failed ? 'error' : undefined);
    } else {
      await api(`/paper-folders/${folderId}`, { method: 'PATCH', body: JSON.stringify({ parent_id: parentId }) });
      if (parentId !== null) state.expandedPaperFolders.add(parentId);
      await refreshData();
      renderPapers();
      toast('Folder moved');
    }
  } catch (error) { showError(error); }
  finally { folderDropBusy = false; target?.removeAttribute('aria-busy'); }
}

async function completePaperDrop(paperId: number, folder: HTMLElement | null, project: HTMLElement | null) {
  endPaperDrag();
  if (project) {
    const projectId = Number(project.dataset.paperProjectDrop);
    if (!paperId || !projectId) return toast('Unable to link this article', 'error');
    const alreadyLinked = state.papers.find((item) => item.id === paperId)?.projects.some((item) => item.id === projectId);
    project.setAttribute('aria-busy', 'true');
    try {
      if (!alreadyLinked) await api(`/papers/${paperId}/projects/${projectId}`, { method: 'POST' });
      await refreshData();
      renderPapers();
      toast(alreadyLinked ? 'Article already linked to this project'
        : `Article added to ${state.projects.find((item) => item.id === projectId)?.name || 'project'}`);
    } catch (error) {
      project.removeAttribute('aria-busy');
      showError(error);
    }
    return;
  }
  if (!folder) return;
  const folderId = folder.dataset.paperFolderDrop === 'root' ? null : Number(folder.dataset.paperFolderDrop);
  try {
    await api(`/papers/${paperId}`, { method: 'PATCH', body: JSON.stringify({ folder_id: folderId }) });
    await refreshState(['papers', 'workspaceTree']);
    renderPapers();
    toast(`Article moved to ${paperFolderLabel(folderId)}`);
  } catch (error) { showError(error); }
}

function paperDropTargets(target: Element | null) {
  return {
    folder: target?.closest<HTMLElement>('[data-paper-folder-drop]') || null,
    project: target?.closest<HTMLElement>('[data-paper-project-drop]') || null,
  };
}

function markPaperDropTargets(folder: Element | null, project: Element | null) {
  document.querySelectorAll('[data-paper-folder-drop]').forEach((item) => item.classList.toggle('drag-over', item === folder));
  document.querySelectorAll('[data-paper-project-drop]').forEach((item) => item.classList.toggle('drag-over', item === project));
}

// Dragging an article row with the pointer (its handle uses native drag and drop, see dragDrop.ts).
type PointerPaperDrag = { id: number; pointerId: number; startX: number; startY: number; dragging: boolean; row: HTMLElement; preview: HTMLElement | null };
let pointerPaperDrag: PointerPaperDrag | null = null;

function createPaperDragPreview(paperId: number) {
  const paper = state.papers.find((item) => item.id === paperId);
  if (!paper) return null;
  const preview = document.createElement('div');
  preview.className = 'paper-drag-preview';
  preview.innerHTML = `<span class="paper-drag-preview-icon">▤</span><div><strong>${escapeHtml(paper.title)}</strong><small>${escapeHtml((paper.authors || []).join(', ') || paper.publication || 'Article')}</small><em data-paper-drag-intent>Choose a folder or project</em></div>`;
  document.body.appendChild(preview);
  requestAnimationFrame(() => preview.classList.add('visible'));
  return preview;
}

function movePaperDragPreview(preview: HTMLElement | null, x: number, y: number, folder: Element | null, project: Element | null) {
  if (!preview) return;
  preview.style.transform = `translate3d(${Math.round(x + 18)}px, ${Math.round(y + 16)}px, 0)`;
  const target = project || folder;
  const label = target?.querySelector('strong')?.textContent?.trim();
  const intent = preview.querySelector('[data-paper-drag-intent]');
  if (intent) intent.textContent = project ? `Add to ${label || 'project'}` : folder ? `Move to ${label || 'folder'}` : 'Choose a folder or project';
  preview.classList.toggle('has-target', Boolean(target));
}

function clearPointerPaperDrag() {
  if (!pointerPaperDrag) return;
  pointerPaperDrag.row.classList.remove('dragging');
  pointerPaperDrag.preview?.remove();
  pointerPaperDrag = null;
  editorSession.activeDragType = null;
  editorSession.activeDragPayload = '';
  endPaperDrag();
}

export function initializePaperPointerDrag() {
  document.addEventListener('pointerdown', (event) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>('.paper-row[data-paper]');
    // The explicit handle uses native drag and drop so it also works with an open canvas.
    if (!row || event.button !== 0 || target.closest('[data-paper-drag], select, button, input, label, summary, details, a, [data-paper-control]')) return;
    pointerPaperDrag = { id: Number(row.dataset.paper), pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dragging: false, row, preview: null };
    row.setPointerCapture?.(event.pointerId);
  });
  document.addEventListener('pointermove', (event) => {
    const drag = pointerPaperDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.dragging && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
    if (!drag.dragging) {
      drag.dragging = true;
      editorSession.activeDragType = 'paper';
      editorSession.activeDragPayload = `paper:${drag.id}`;
      drag.row.classList.add('dragging');
      document.body.classList.add('paper-drag-active');
      drag.preview = createPaperDragPreview(drag.id);
    }
    const { folder, project } = paperDropTargets(document.elementFromPoint(event.clientX, event.clientY));
    movePaperDragPreview(drag.preview, event.clientX, event.clientY, folder, project);
    markPaperDropTargets(folder, project);
    event.preventDefault();
  });
  document.addEventListener('pointerup', async (event) => {
    const drag = pointerPaperDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { folder, project } = paperDropTargets(document.elementFromPoint(event.clientX, event.clientY));
    if (drag.dragging) suppressPaperOpen();
    clearPointerPaperDrag();
    if (!drag.dragging || (!folder && !project)) return;
    event.preventDefault();
    await completePaperDrop(drag.id, folder, project);
  });
  document.addEventListener('pointercancel', clearPointerPaperDrag);
}

/** Native drag and drop of articles (from their handle) and of Library folders. */
export function paperDragOver(event: DragEvent) {
  if (!['paper', 'paper-folder'].includes(editorSession.activeDragType)) return false;
  const { folder, project } = paperDropTargets(event.target as Element);
  if (!folder && !project) return true;
  event.preventDefault();
  event.dataTransfer.dropEffect = project ? 'copy' : 'move';
  markPaperDropTargets(folder, project);
  return true;
}

export async function paperDrop(event: DragEvent, transfer: string) {
  const { folder, project } = paperDropTargets(event.target as Element);
  if (transfer.startsWith('paper-folder:')) {
    event.preventDefault();
    editorSession.activeDragType = null;
    editorSession.activeDragPayload = '';
    await completeLibraryFolderDrop(Number(transfer.slice(13)), folder, project);
    return true;
  }
  if (transfer.startsWith('paper:')) {
    if (!folder && !project) return true;
    event.preventDefault();
    await completePaperDrop(Number(transfer.slice(6)), folder, project);
    return true;
  }
  return false;
}

export function paperDragEnded() {
  if (editorSession.activeDragType === 'paper') suppressPaperOpen();
}

export const libraryClickRoutes: Route[] = [
  { selector: 'a[href^="#pdf-external-"]', run: (link, event) => {
    event.preventDefault();
    const paperId = Number(link.getAttribute('href').slice('#pdf-external-'.length));
    if (Number.isInteger(paperId) && paperId > 0) return openPaperPdfExternally(paperId);
  } },
  { selector: 'a[href^="#paper-"]', run: (link, event) => {
    event.preventDefault();
    const paperId = Number(link.getAttribute('href').slice(7));
    if (paperId) return openPaper(paperId, activeNoteProjectId());
  } },
  { selector: '[data-library-paper-folder]', run: (folder) => {
    state.paperFolderFilter = folder.dataset.libraryPaperFolder;
    state.paperProjectFilter = 'all';
    state.paperPage = 1;
    return navigate('papers');
  } },
  { selector: '[data-toggle-paper-folder]', run: (toggle) => {
    const folderId = Number(toggle.dataset.togglePaperFolder);
    if (state.expandedPaperFolders.has(folderId)) state.expandedPaperFolders.delete(folderId);
    else state.expandedPaperFolders.add(folderId);
    return state.view === 'papers' ? renderPapers() : renderNotes();
  } },
  { selector: '.paper-tree-leaf[data-paper]', run: (leaf, event) => {
    if (paperOpenSuppressed()) { event.preventDefault(); event.stopPropagation(); return; }
    const paperId = Number(leaf.dataset.paper);
    if (leaf.closest('.library-workspace')) return readInLibrary(paperId);
    return openPaper(paperId);
  } },
  { selector: '[data-paper]', when: () => paperOpenSuppressed(), run: (_, event) => { event.preventDefault(); event.stopPropagation(); } },
  { selector: '[data-paper]',
    when: (_, event) => !(event.target as Element).closest('select, button, input, label, summary, details, [data-paper-control], [data-paper-drag]'),
    run: (paper) => {
      const paperId = Number(paper.dataset.paper);
      const projectContext = idOrNull(paper.dataset.projectContext);
      if (paper.closest('.library-workspace')) return readInLibrary(paperId, projectContext);
      return state.papers.find((item) => item.id === paperId)?.file_path ? openPaper(paperId, projectContext) : paperPdfUploadModal(paperId);
    } },
  { selector: '[data-delete-paper-folder]', run: async (button) => {
    if (!confirm('Delete this folder and its subfolders? Articles will be kept and moved to Unfiled.')) return;
    try {
      await api(`/paper-folders/${button.dataset.deletePaperFolder}`, { method: 'DELETE' });
      closeModal();
      state.paperFolderFilter = 'all';
      await refreshData();
      if (viewShown('papers')) renderPapers();
      else renderNotes();
      toast('Folder deleted; articles kept');
    } catch (error) { showError(error); }
  } },
  { selector: '[data-remove-paper-project]', run: async (button) => {
    const { removePaperProject: paperId, projectId } = button.dataset;
    if (!paperId || !projectId || !confirm('Remove this article from the project? The article will remain in your library.')) return;
    try {
      await api(`/papers/${paperId}/projects/${projectId}`, { method: 'DELETE' });
      closeModal();
      await refreshData();
      renderPapers();
      toast('Article removed from project');
    } catch (error) { showError(error); }
  } },
  { selector: '[data-delete-paper]', run: async (button) => {
    if (!confirm('Delete this article, its PDF, and its reading notes?')) return;
    clearTimeout(editorSession.readerAutosaveTimer);
    editorSession.pendingReaderSave = null;
    try {
      const returnProject = state.view === 'notes' ? state.paperProjectContext : null;
      await api(`/papers/${button.dataset.deletePaper}`, { method: 'DELETE' });
      closeModal();
      await refreshData();
      toast('Article deleted');
      if (returnProject) await openProjectArea(returnProject, 'papers');
      else await navigate('papers');
    } catch (error) { showError(error); }
  } },
];

export const libraryChangeRoutes: Route<Event>[] = [
  { selector: '[data-paper-status]', run: async (control, event) => {
    event.stopPropagation();
    try {
      await api(`/papers/${control.dataset.paperStatus}`, { method: 'PATCH', body: JSON.stringify({ status: (control as HTMLInputElement).value }) });
      await refreshState(['papers']);
      render();
      toast('Reading status updated');
    } catch (error) { showError(error); }
  } },
];
