/** Tasks: the commands of their cards and context menus, and the drag and drop of the Kanban board. */
import { state } from '../state';
import { refreshState, toast } from '../navigation';
import { editorSession } from '../editorSession';
import { api } from '../../services/api';
import { closeModal } from '../../components/dialogs/controller';
import { deleteTaskColumnModal, newTaskModal, taskArchivesModal } from '../../features/tasks/dialogs';
import { renderTasks } from '../../features/tasks/actions';
import { removeClasses, showError, type Route } from './shared';

/** Runs a change to tasks, then reloads them and redraws the boards. */
async function changeTasks(request: () => Promise<unknown>, message: string, options: { closeDialog?: boolean; reopenArchives?: boolean } = {}) {
  try {
    await request();
    if (options.closeDialog) closeModal();
    await refreshState(['tasks', 'taskColumns', 'projects']);
    renderTasks();
    toast(message);
    if (options.reopenArchives) await taskArchivesModal();
  } catch (error) { showError(error); }
}

const taskRequest = (id: string, path = '', init: RequestInit = { method: 'POST' }) => () => api(`/tasks/${id}${path}`, init);

export const taskClickRoutes: Route[] = [
  { selector: '[data-task-status]', run: (button) => changeTasks(
    taskRequest(button.dataset.taskStatus, '', { method: 'PATCH', body: JSON.stringify({ status: button.dataset.status }) }), 'Status updated') },
  { selector: '[data-delete-task]', run: (button) => confirm('Delete this task?')
    && changeTasks(taskRequest(button.dataset.deleteTask, '', { method: 'DELETE' }), 'Task deleted') },
  { selector: '[data-archive-task]', run: (button) => changeTasks(
    taskRequest(button.dataset.archiveTask, '/archive'), 'Task archived', { closeDialog: true }) },
  { selector: '[data-restore-task]', run: (button) => changeTasks(
    taskRequest(button.dataset.restoreTask, '/restore'), 'Task restored', { closeDialog: true, reopenArchives: true }) },
  { selector: '[data-delete-archived-task]', run: (button) => confirm('Permanently delete this archived task?')
    && changeTasks(taskRequest(button.dataset.deleteArchivedTask, '', { method: 'DELETE' }), 'Task permanently deleted', { closeDialog: true, reopenArchives: true }) },
  { selector: '[data-delete-column]', run: (button) => deleteTaskColumnModal(Number(button.dataset.deleteColumn)) },
];

export const taskChangeRoutes: Route<Event>[] = [
  { selector: '[data-task-column-set]', run: (select, event) => {
    event.stopPropagation();
    return changeTasks(taskRequest(select.dataset.taskColumnSet, '', {
      method: 'PATCH', body: JSON.stringify({ column_id: Number((select as HTMLSelectElement).value) }),
    }), 'Task status updated');
  } },
];

const insertsAfter = (column: Element, event: DragEvent) => {
  const box = column.getBoundingClientRect();
  return event.clientX > box.left + box.width / 2;
};

/** Reordering columns (by their handle) and moving cards between columns. */
export function taskDragOver(event: DragEvent) {
  const target = event.target as Element;
  if (editorSession.activeDragType === 'column') {
    const targetColumn = target.closest('[data-column-id]');
    if (!targetColumn) return true;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const after = insertsAfter(targetColumn, event);
    document.querySelectorAll('.kanban-column').forEach((item) => {
      item.classList.toggle('column-reorder-over', item === targetColumn);
      item.classList.toggle('column-reorder-after', item === targetColumn && after);
    });
    return true;
  }
  const column = target.closest('[data-drop-column]');
  if (!column) return false;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.kanban-column').forEach((item) => item.classList.toggle('drag-over', item === column));
  return true;
}

async function reorderColumns(event: DragEvent, movedColumnId: number) {
  const targetColumn = (event.target as Element).closest<HTMLElement>('[data-column-id]');
  if (!targetColumn) return;
  event.preventDefault();
  editorSession.activeDragType = null;
  const targetColumnId = Number(targetColumn.dataset.columnId);
  removeClasses('.kanban-column.column-reorder-over, .kanban-column.column-reorder-after', 'column-reorder-over', 'column-reorder-after');
  if (!movedColumnId || movedColumnId === targetColumnId) return;
  const orderedIds = state.taskColumns.map((column) => column.id).filter((id) => id !== movedColumnId);
  orderedIds.splice(orderedIds.indexOf(targetColumnId) + (insertsAfter(targetColumn, event) ? 1 : 0), 0, movedColumnId);
  try {
    await api('/task-columns/reorder', { method: 'PUT', body: JSON.stringify({ ordered_ids: orderedIds }) });
    await refreshState(['taskColumns']);
    renderTasks();
    toast('Column order saved');
  } catch (error) { showError(error); }
}

async function moveTask(event: DragEvent, column: HTMLElement) {
  event.preventDefault();
  const taskId = Number(event.dataTransfer.getData('text/plain'));
  const columnId = Number(column.dataset.dropColumn);
  const task = state.tasks.find((item) => item.id === taskId);
  column.classList.remove('drag-over');
  if (!task || task.column_id === columnId) return;
  await changeTasks(() => api(`/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify({ column_id: columnId }) }),
    `Task moved to “${state.taskColumns.find((item) => item.id === columnId)?.name || 'the column'}”`);
}

export async function taskDrop(event: DragEvent, transfer: string) {
  if (transfer.startsWith('column:')) {
    await reorderColumns(event, Number(transfer.slice(7)));
    return true;
  }
  const column = (event.target as Element).closest<HTMLElement>('[data-drop-column]');
  if (!column) return false;
  await moveTask(event, column);
  return true;
}

/** Enter or Space on a focused card opens it. */
export function openFocusedTask(event: KeyboardEvent) {
  const card = event.target as HTMLElement;
  if (!card.matches?.('.task-card[data-task-id]') || !['Enter', ' '].includes(event.key)) return false;
  event.preventDefault();
  newTaskModal(null, null, Number(card.dataset.taskId));
  return true;
}
