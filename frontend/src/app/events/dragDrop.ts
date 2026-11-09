/** Drag and drop across the application: what a drag carries (dragstart), where it may land (dragover), and the
 * drop itself, delegated to the tree, the Library and the task board. Editors (canvas, rich text) handle their own drops. */
import { toast } from '../navigation';
import { editorSession } from '../editorSession';
import { collectionDragPayload } from '../../features/collections/catalog';
import { isTreeRowSelected } from '../../features/documents/treeSelection';
import { mergeWorkspacePanes } from '../../features/documents/workspace';
import { paperDragEnded, paperDragOver, paperDrop } from './library';
import { taskDragOver, taskDrop } from './tasks';
import { resetDropHighlight, treeDragOver, treeDrop, treeDropTargetAt } from './workspaceTree';
import { removeClasses } from './shared';

function carry(type: string, payload: string, transfer: DataTransfer, effect: DataTransfer['effectAllowed'], formats: Record<string, string> = {}) {
  editorSession.activeDragType = type;
  editorSession.activeDragPayload = payload;
  transfer.effectAllowed = effect;
  for (const [format, value] of Object.entries(formats)) transfer.setData(format, value);
}

function dragStart(event: DragEvent) {
  // A native drag took over: the browser cancels the pointer, and that cancel must not clear this drag.
  pointerWorkspaceDrag = null;
  const target = event.target as HTMLElement;
  const transfer = event.dataTransfer;
  // Dragging one row of a multi-selection carries the whole selection.
  if (isTreeRowSelected(target.closest?.('.workspace-file-row'))) {
    carry('workspace', 'selection:tree', transfer, 'move', { 'text/plain': 'selection:tree' });
    document.querySelectorAll('.workspace-file-row.multi-selected').forEach((row) => row.classList.add('dragging'));
    return;
  }
  const note = target.closest<HTMLElement>('[data-note-drag]');
  if (note) {
    const payload = `note:${note.dataset.noteDrag}`;
    note.classList.add('dragging');
    return carry('note', payload, transfer, note.hasAttribute('data-reference-drag') ? 'link' : 'all',
      { 'application/x-kavot-note': payload, 'text/plain': payload });
  }
  // Only canvases accept a project: they import its canvas.
  const project = target.closest<HTMLElement>('[data-project-drag]');
  if (project) {
    const payload = `project:${project.dataset.projectDrag}`;
    project.classList.add('dragging');
    return carry('project', payload, transfer, 'copy', { 'application/x-kavot-project': payload });
  }
  const item = target.closest<HTMLElement>('[data-workspace-drag]');
  if (item) {
    const payload = `workspace:${item.dataset.workspaceDrag}`;
    item.classList.add('dragging');
    return carry('workspace', payload, transfer, item.hasAttribute('data-reference-drag') ? 'link' : 'all',
      { 'application/x-kavot-workspace': payload, 'text/plain': payload });
  }
  const libraryFolder = target.closest<HTMLElement>('[data-paper-folder-drag]');
  if (libraryFolder) {
    const payload = `paper-folder:${libraryFolder.dataset.paperFolderDrag}`;
    document.body.classList.add('paper-drag-active');
    return carry('paper-folder', payload, transfer, 'all', { 'text/plain': payload });
  }
  const paper = target.closest<HTMLElement>('[data-paper-drag]');
  if (paper) {
    const paperId = Number(paper.dataset.paperDrag);
    const payload = `paper:${paperId}`;
    paper.closest('.paper-row')?.classList.add('dragging');
    document.body.classList.add('paper-drag-active');
    return carry('paper', payload, transfer, 'all', {
      'application/x-kavot-paper': payload,
      'application/x-kavot-collection': collectionDragPayload('paper', paperId, 'articles'),
      'text/plain': payload,
    });
  }
  const paneHandle = target.closest<HTMLElement>('[data-pane-drag]');
  if (paneHandle) {
    const payload = `pane:${paneHandle.dataset.paneDrag}`;
    paneHandle.closest('[data-workspace-pane]')?.classList.add('pane-dragging');
    return carry('pane', payload, transfer, 'move', { 'text/plain': payload });
  }
  const folder = target.closest<HTMLElement>('[data-folder-drag]');
  if (folder) {
    const payload = `folder:${folder.dataset.folderDrag}`;
    folder.classList.add('dragging');
    return carry('folder', payload, transfer, 'move', { 'text/plain': payload });
  }
  const columnHandle = target.closest<HTMLElement>('[data-column-drag]');
  if (columnHandle) {
    const payload = `column:${columnHandle.dataset.columnDrag}`;
    columnHandle.closest('.kanban-column')?.classList.add('column-dragging');
    return carry('column', payload, transfer, 'move', { 'text/plain': payload });
  }
  const card = target.closest<HTMLElement>('[data-task-id]');
  if (!card) return;
  card.classList.add('dragging');
  carry('task', card.dataset.taskId, transfer, 'all', {
    'application/x-kavot-collection': collectionDragPayload('task', Number(card.dataset.taskId), 'tasks'),
    'text/plain': card.dataset.taskId,
  });
}

function dragEnd(event: DragEvent) {
  paperDragEnded();
  editorSession.activeDragType = null;
  editorSession.activeDragPayload = '';
  document.body.classList.remove('paper-drag-active');
  const target = event.target as HTMLElement;
  target.closest('[data-workspace-pane]')?.classList.remove('pane-dragging');
  target.closest('.kanban-column')?.classList.remove('column-dragging');
  for (const selector of ['[data-task-id]', '[data-note-drag]', '[data-folder-drag]', '[data-workspace-drag]', '[data-project-drag]', '.paper-row'])
    target.closest(selector)?.classList.remove('dragging');
  removeClasses('.workspace-file-row.multi-selected.dragging', 'dragging');
  removeClasses('[data-pane-drop].pane-drop-target', 'pane-drop-target');
  removeClasses('.kanban-column.drag-over, [data-paper-folder-drop].drag-over, [data-paper-project-drop].drag-over', 'drag-over');
  removeClasses('.kanban-column.column-reorder-over, .kanban-column.column-reorder-after', 'column-reorder-over', 'column-reorder-after');
  removeClasses('[data-workspace-drop].workspace-drag-over', 'workspace-drag-over');
  resetDropHighlight();
}

const paneOf = (element: HTMLElement) => element.dataset.paneDrop || element.dataset.workspacePane;
const paneTarget = (event: DragEvent) => (event.target as Element).closest<HTMLElement>('[data-pane-drop], [data-workspace-pane]');

function paneDragOver(event: DragEvent) {
  if (editorSession.activeDragType !== 'pane') return false;
  const target = paneTarget(event);
  if (!target || paneOf(target) === editorSession.activeDragPayload.slice(5)) return true;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('[data-pane-drop]').forEach((item) => item.classList.toggle('pane-drop-target', item === target));
  return true;
}

/** Pane moves are handled before the editors' own drop handlers could insert the payload as text. */
async function paneDrop(event: DragEvent) {
  const transfer = event.dataTransfer?.getData('text/plain') || editorSession.activeDragPayload;
  if (!transfer.startsWith('pane:')) return;
  const target = paneTarget(event);
  const movedPane = transfer.slice(5);
  if (!target || paneOf(target) === movedPane) return;
  event.preventDefault();
  event.stopPropagation();
  editorSession.activeDragType = null;
  editorSession.activeDragPayload = '';
  removeClasses('[data-pane-drop].pane-drop-target', 'pane-drop-target');
  await mergeWorkspacePanes(movedPane, paneOf(target));
  toast('Tabs merged into a single editor');
}

function dragOver(event: DragEvent) {
  // eslint-disable-next-line no-unused-expressions
  treeDragOver(event) || paperDragOver(event) || paneDragOver(event) || taskDragOver(event);
}

async function drop(event: DragEvent) {
  const data = event.dataTransfer;
  const transfer = data.getData('application/x-kavot-workspace') || data.getData('application/x-kavot-paper')
    || data.getData('text/plain') || editorSession.activeDragPayload;
  if (await treeDrop(event, transfer)) return;
  if (await paperDrop(event, transfer)) return;
  await taskDrop(event, transfer);
}

// Rows of the tree are dragged with the pointer (it is captured, so no native drag starts): onto a canvas or a
// document, or onto a folder of the tree. The drop is sent to its target as a native one.
type PointerWorkspaceDrag = { pointerId: number; startX: number; startY: number; dragging: boolean; row: HTMLElement; type: string;
  payload: string; treePayload: string };
let pointerWorkspaceDrag: PointerWorkspaceDrag | null = null;

const elementUnder = (event: PointerEvent) => document.elementFromPoint(event.clientX, event.clientY);
const documentUnder = (event: PointerEvent) => elementUnder(event)?.closest?.('.canvas-viewport, .continuous-editor') || null;

function sendDrop(target: Element, event: PointerEvent, payload: string, format: string) {
  const transfer = new DataTransfer();
  transfer.effectAllowed = 'all';
  transfer.setData(format, payload);
  transfer.setData('text/plain', payload);
  target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: event.clientX, clientY: event.clientY, dataTransfer: transfer }));
}

function clearPointerWorkspaceDrag() {
  const drag = pointerWorkspaceDrag;
  pointerWorkspaceDrag = null;
  // Nothing to undo when the pointer never dragged, or when a native drag replaced it.
  if (!drag?.dragging) return;
  drag.row.classList.remove('dragging');
  removeClasses('.canvas-viewport.is-file-drop', 'is-file-drop');
  removeClasses('.workspace-file-row.multi-selected.dragging', 'dragging');
  treeDropTargetAt(null);
  if (['note', 'workspace'].includes(editorSession.activeDragType)) {
    editorSession.activeDragType = null;
    editorSession.activeDragPayload = '';
  }
}

function initializePointerWorkspaceDrag() {
  document.addEventListener('pointerdown', (event) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>('.workspace-file-row.file[data-note-drag], .workspace-file-row.file[data-workspace-drag]');
    if (!row || event.button !== 0 || target.closest('button, input, label, a, .workspace-item-actions, .workspace-open-side')) return;
    const noteId = Number(row.dataset.noteDrag || 0) || null;
    const payload = noteId ? `note:${noteId}` : `workspace:${row.dataset.workspaceDrag || ''}`;
    pointerWorkspaceDrag = {
      pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dragging: false, row,
      type: noteId ? 'note' : 'workspace', payload,
      // Dragging one row of a multi-selection moves the whole selection within the tree.
      treePayload: isTreeRowSelected(row) ? 'selection:tree' : payload,
    };
    row.setPointerCapture?.(event.pointerId);
  });
  let shownDrop: Element | null = null;
  document.addEventListener('pointermove', (event) => {
    const drag = pointerWorkspaceDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.dragging && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
    if (!drag.dragging) {
      drag.dragging = true;
      drag.row.classList.add('dragging');
      if (drag.treePayload === 'selection:tree')
        document.querySelectorAll('.workspace-file-row.multi-selected').forEach((row) => row.classList.add('dragging'));
      editorSession.activeDragType = drag.type;
      editorSession.activeDragPayload = drag.payload;
      shownDrop = null;
    }
    const viewport = documentUnder(event);
    if (viewport !== shownDrop) {
      document.querySelectorAll('.canvas-viewport').forEach((item) => item.classList.toggle('is-file-drop', item === viewport));
      shownDrop = viewport;
    }
    treeDropTargetAt(viewport ? null : elementUnder(event));
    event.preventDefault();
  });
  document.addEventListener('pointerup', (event) => {
    const drag = pointerWorkspaceDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const viewport = drag.dragging ? documentUnder(event) : null;
    const folder = drag.dragging && !viewport ? treeDropTargetAt(elementUnder(event)) : null;
    if (viewport) {
      event.preventDefault();
      sendDrop(viewport, event, drag.payload, drag.type === 'note' ? 'application/x-kavot-note' : 'application/x-kavot-workspace');
    } else if (folder) {
      event.preventDefault();
      sendDrop(folder, event, drag.treePayload, drag.treePayload.startsWith('note:') ? 'application/x-kavot-note' : 'application/x-kavot-workspace');
    }
    clearPointerWorkspaceDrag();
  });
  document.addEventListener('pointercancel', clearPointerWorkspaceDrag);
}

export function initializeDragAndDrop() {
  initializePointerWorkspaceDrag();
  document.addEventListener('dragstart', dragStart);
  document.addEventListener('dragend', dragEnd);
  document.addEventListener('dragover', dragOver);
  document.addEventListener('drop', paneDrop, true);
  document.addEventListener('drop', drop);
}
