import { getRuntime } from './runtime';
import { openShareDialog, type ShareSource } from '../components/SharingPanel';
import { findWorkspaceNode, interfaceIcon } from '../features/documents/workspace';
import { isTreeRowSelected, selectedTreePaths } from '../features/documents/treeSelection';
import { flushCollectionSaves } from '../features/collections/noteEditor';
import { parseCollectionDragPayload } from '../features/collections/catalog';
import { ContextAction, closeContextMenu, initializeContextMenuDismissal, showContextMenu } from '../components/contextMenu';

// Route commands through the existing controls to preserve validation, autosave,
// project scope, and the confirmation dialogs used by the rest of the UI.
function command(label: string, data: Record<string, string | number>, danger = false): ContextAction {
  return { label, danger, run: () => {
    const source = document.createElement('button');
    source.hidden = true;
    for (const [key, value] of Object.entries(data)) source.dataset[key] = String(value);
    document.body.append(source);
    source.click();
    source.remove();
  } };
}

function control(element: HTMLElement, label?: string): ContextAction {
  const standard = element.matches('.workspace-file-label, .note-item, [data-collection-open]') ? 'Open'
    : element.matches('[data-action="edit-note"]') ? 'Note settings'
    : element.matches('[data-workspace-tab]') ? 'Activate tab' : null;
  const text = label || standard || element.title || element.getAttribute('aria-label') || element.querySelector(':scope > span')?.textContent?.trim() || element.textContent?.trim() || 'Open';
  return { label: text, danger: /delete|remove|trash|archive/i.test(text), run: () => { if (element.isConnected) element.click(); } };
}

function controls(scope: Element, selector = 'button, a[download], input[type="color"]'): ContextAction[] {
  return [...scope.querySelectorAll<HTMLElement>(selector)]
    .filter(el => !el.matches(':disabled, [hidden], [data-workspace-row-menu]') && !el.closest('.hidden'))
    .map(el => control(el));
}

function share(source: ShareSource): ContextAction {
  return {label: 'Share', run: async () => {
    const runtime = getRuntime();
    try {
      await runtime.flushCurrentNoteAutosave();
      await runtime.flushSecondaryNoteAutosave();
      await runtime.flushWorkspaceMarkdownSaves();
      await runtime.flushCanvasSaves();
      await flushCollectionSaves();
      if (document.querySelector('.note-autosave-state[data-state="error"]')) throw new Error('Save your changes before sharing.');
      openShareDialog(source);
    } catch (error) { runtime.toast((error as Error).message, 'error'); }
  }};
}

function rowShare(row: HTMLElement): ContextAction[] {
  const {state} = getRuntime();
  const noteId = row.querySelector<HTMLElement>('[data-note]')?.dataset.note;
  if (noteId) return [share({kind: 'note', id: noteId})];
  const tabButton = row.querySelector<HTMLElement>('[data-workspace-tab]');
  const tab = tabButton && state.workspaceTabs[tabButton.dataset.workspaceTabPane]?.find(item => item.id === tabButton.dataset.workspaceTab);
  if (tab?.type === 'note') return [share({kind: 'note', id: String(tab.noteId)})];
  const node = findWorkspaceNode(row.dataset.workspacePath);
  if (node?.note_id) return [share({kind: 'note', id: String(node.note_id)})];
  if (node?.paper_id) return [share({kind: 'item', collection: 'articles', id: String(node.paper_id)})];
  if (node?.project_id && node.kind === 'directory') return [share({kind: 'project', id: String(node.project_id)})];
  const payload = row.querySelector<HTMLElement>('[data-collection-open]')?.dataset.collectionOpen;
  if (payload) {
    const ref = parseCollectionDragPayload(payload);
    if (ref) return [share(ref.type === 'note' ? {kind: 'note', id: String(ref.id)} : {kind: 'item', collection: ref.databaseId, id: String(ref.id)})];
  }
  return [];
}

const CREATE_ICONS: Record<string, string> = { 'new-note': 'note', 'new-drawing': 'draw', 'new-canvas': 'canvas', 'new-folder': 'folder', 'new-project': 'project' };

/** "New …" entries of a folder or section, from its creation buttons. */
function createActions(scope: Element | null | undefined): ContextAction[] {
  return [...(scope?.querySelectorAll<HTMLElement>(':scope > .workspace-create-actions > [data-action]') || [])]
    .map(element => ({ ...control(element), icon: interfaceIcon(CREATE_ICONS[element.dataset.action] || 'plus') }));
}

/** Join non-empty groups with dividers. */
function grouped(...groups: ContextAction[][]): ContextAction[] {
  return groups.filter(group => group.length).flatMap((group, index) => group.map((action, position) => ({ ...action, separator: index > 0 && position === 0 })));
}

function treeActions(row: HTMLElement): ContextAction[] {
  // Right-clicking inside a multi-selection acts on every selected item.
  if (isTreeRowSelected(row))
    return [command(`Move ${selectedTreePaths().length} items to trash`, { trashTreeSelection: 'true' }, true)];
  const opening: ContextAction[] = [];
  const open = row.querySelector<HTMLElement>('.workspace-file-label, .note-item');
  if (open) {
    const toggle = open.dataset.workspaceToggle;
    opening.push(control(open, toggle ? (open.getAttribute('aria-expanded') === 'true' ? 'Collapse' : 'Expand') : 'Open'));
    if (open.dataset.note || open.dataset.openWorkspaceResource) {
      opening.push(command('Open in a new tab', { ...open.dataset, openInNewTab: 'true' }));
    }
  }
  const beside = row.querySelector<HTMLElement>('[data-open-secondary-note], [data-open-secondary-resource]');
  if (beside) opening.push(control(beside, 'Open to the side'));
  const editing: ContextAction[] = [];
  const removal: ContextAction[] = [];
  const labels = [
    ['[data-inline-rename-workspace], [data-inline-rename-folder], [data-rename-note]', 'Rename'],
    ['[data-restore-trash]', 'Restore'],
    ['[data-trash-workspace], [data-delete-folder], [data-delete-note]', 'Delete'],
    ['[data-action="delete-project"]', 'Delete project'],
    ['[data-delete-trash]', 'Delete permanently'],
  ];
  for (const [selector, label] of labels) {
    const element = row.querySelector<HTMLElement>(selector);
    if (element) (label.startsWith('Delete') ? removal : editing).push({ ...control(element, label), danger: label.startsWith('Delete') });
  }
  const creation = createActions(row);
  editing.push(...controls(row, '[data-action]:not(.workspace-create-actions > *):not(.workspace-file-label):not([data-action="delete-project"]), [data-collection-nav], input[type="color"]'), ...rowShare(row));
  return grouped(creation, opening, editing, removal);
}

/** Empty tree space and section heads: create at that level, or tidy the tree. */
function treeAreaActions(target: HTMLElement): ContextAction[] {
  const section = target.closest('[data-workspace-root]') || document.querySelector('#notes-tree [data-workspace-root]');
  const head = section?.querySelector<HTMLElement>(':scope > .workspace-root-head > button[data-workspace-toggle]');
  const collapse = document.querySelector<HTMLElement>('[data-tree-collapse-all]');
  return grouped(
    createActions(section?.querySelector(':scope > .workspace-root-head')),
    [...(head && target.closest('.workspace-root-head') ? [control(head, head.getAttribute('aria-expanded') === 'true' ? 'Collapse' : 'Expand')] : []),
      ...(collapse ? [control(collapse, 'Collapse all folders')] : [])],
  );
}

function actionsFor(target: HTMLElement): ContextAction[] {
  const runtime = getRuntime();
  const { state } = runtime;
  const task = target.closest<HTMLElement>('[data-task-id]');
  if (task) {
    const id = task.dataset.taskId;
    const record = state.tasks.find(item => item.id === Number(id));
    return [command('Edit task', { action: 'edit-task', taskId: id }),
      command(record?.status === 'done' ? 'Mark as to do' : 'Mark as done', { taskStatus: id, status: record?.status === 'done' ? 'todo' : 'done' }),
      command('Archive task', { archiveTask: id }), command('Delete task', { deleteTask: id }, true)];
  }
  const paper = target.closest<HTMLElement>('[data-paper]');
  if (paper) {
    const id = paper.dataset.paper;
    const projectId = paper.dataset.projectContext || state.selectedProject?.id || '';
    const source = { paperId: id, projectId };
    const open = paper.querySelector<HTMLElement>('[data-action="open-paper-workspace"]');
    return [open ? control(open, 'Open article') : control(paper, 'Open article'), share({kind: 'item', collection: 'articles', id}),
      command('Edit article', { action: 'edit-paper', ...source }),
      command('Edit metadata', { action: 'edit-paper-metadata', ...source }),
      command('References', { action: 'paper-references', ...source }),
      command('Add PDF', { action: 'add-paper-pdf', ...source }),
      projectId ? command('Remove from project', { removePaperProject: id, projectId }, true) : command('Delete article', { deletePaper: id }, true)];
  }
  const project = target.closest<HTMLElement>('.project-card, .sidebar-project');
  if (project) {
    if (project.matches('.project-card')) {
      const id = project.dataset.projectId || project.querySelector<HTMLElement>('[data-project-id]')?.dataset.projectId;
      return [...controls(project, '[data-project-area], .project-admin-actions button, a[download]'), ...(id ? [share({kind: 'project', id})] : [])];
    }
    const id = project.dataset.projectId;
    return [control(project, 'Open project'), share({kind: 'project', id}), command('Edit project', { action: 'edit-project', projectId: id }), command('Archive project', { action: 'archive-project', projectId: id }), command('Delete project', { action: 'delete-project', projectId: id }, true)];
  }
  const treeRow = target.closest<HTMLElement>('.workspace-file-row, .note-item-row');
  if (treeRow) return treeActions(treeRow);
  if (target.closest('#notes-tree')) return treeAreaActions(target);
  const row = target.closest<HTMLElement>('.workspace-file-row, .note-item-row, .paper-folder-row, .workspace-tab, .collection-item-row');
  if (row) return [...controls(row), ...rowShare(row)];
  const notePane = target.closest<HTMLElement>('[data-primary-note-id], [data-secondary-note-id]');
  if (notePane) return [share({kind: 'note', id: notePane.dataset.primaryNoteId || notePane.dataset.secondaryNoteId})];
  const registry = target.closest<HTMLElement>('.registry-edit-target');
  if (registry) return [control(registry, 'Edit record')];
  const calendarEvent = target.closest<HTMLElement>('.calendar-event');
  if (calendarEvent) return [control(calendarEvent, 'Open event')];
  const day = target.closest<HTMLElement>('[data-calendar-day]');
  if (day) return [
    { label: 'New event', run: () => runtime.calendarEventModal(null, day.dataset.calendarDay) },
    { label: 'Show day agenda', run: () => runtime.calendarDayAgenda(day.dataset.calendarDay) },
  ];
  const drawing = target.closest<HTMLElement>('.drawing-editor');
  if (drawing && target.closest('.drawing-paper')) return controls(drawing,
    '[data-drawing-command="undo"], [data-drawing-command="redo"], [data-drawing-command="copy"], [data-drawing-command="paste"], [data-drawing-command="duplicate"], [data-drawing-command="select-all"], [data-drawing-command="delete"], [data-drawing-command="front"], [data-drawing-command="back"], [data-drawing-command="fit"], [data-drawing-command="png"]');
  // With several cards selected, grouping them into a zone is offered first.
  const studio = target.closest('.canvas-studio');
  const canvasGroup = studio?.querySelector<HTMLElement>('[data-canvas-group]:not([hidden])');
  const group = canvasGroup ? [control(canvasGroup, 'Group selection')] : [];
  const card = target.closest<HTMLElement>('[data-canvas-node]');
  // Cards of a shown canvas are edited in their source.
  if (card?.dataset.mirrorOf) return [{ label: 'Open its canvas', run: () => card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) }];
  if (card) {
    // A card of a multi-selection acts on the whole selection; cards drawn inside an embedded canvas are not this card's.
    const removeSelection = card.classList.contains('is-selected') && studio?.querySelector<HTMLElement>('[data-canvas-delete-selection]:not([hidden])');
    const own = [...card.querySelectorAll<HTMLElement>('[data-canvas-delete-node], [data-canvas-open-paper], [data-canvas-collection-item]')]
      .filter(el => !el.closest('.canvas-embed-stage, .hidden') && !el.matches(':disabled, [hidden]') &&
        !(removeSelection && el.matches('[data-canvas-delete-node]')))
      .map(el => control(el));
    const open = card.classList.contains('canvas-node-canvas')
      ? { label: 'Open its canvas', run: () => card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) }
      : control(card, 'Edit card');
    return [...(card.classList.contains('is-selected') ? group : []), open, ...own,
      ...(removeSelection ? [control(removeSelection, `${removeSelection.textContent.trim()} from canvas`)] : [])];
  }
  const canvas = target.closest<HTMLElement>('.canvas-viewport');
  if (canvas) return [...group, ...controls(canvas.parentElement, '[data-canvas-add], [data-canvas-upload-image], [data-canvas-zoom]')];
  const column = target.closest<HTMLElement>('.kanban-column');
  if (column) return controls(column, '.kanban-head button, .kanban-add');
  const navigation = target.closest<HTMLElement>('[data-nav], [data-collection-nav], [data-project-area]');
  if (navigation) return [control(navigation, 'Open')];
  const button = target.closest<HTMLElement>('button, a[download]');
  if (button && !button.matches(':disabled')) return [control(button)];
  // Background menus expose creation and view commands only, never actions on
  // an unrelated record elsewhere on the page.
  const scope = target.closest<HTMLElement>('.modal, [role="dialog"], #main-content, #sidebar, .agent-panel');
  if (!scope) return [];
  const actions = [...scope.querySelectorAll<HTMLElement>('[data-action^="new-"], [data-action="add-project-resource"], [data-action="task-archives"], [data-action="reset-paper-filters"]')]
    .filter(el => !el.closest('.workspace-file-row, .paper-folder-row, .kanban-column') && !el.matches(':disabled') && !el.closest('.hidden'))
    .map(el => control(el));
  if (scope.matches('#main-content') && state.view === 'calendar') actions.push({ label: 'New event', run: () => runtime.calendarEventModal() });
  if (!scope.closest('[role="dialog"]')) actions.push(
    command('Research Home', { nav: 'dashboard' }),
    command('Workspace', { nav: 'notes' }),
    command('Settings', { nav: 'settings' }),
  );
  return actions.filter((item, index) => actions.findIndex(other => other.label === item.label) === index);
}

export function initializeAppContextMenus() {
  initializeContextMenuDismissal();
  document.addEventListener('click', event => {
    const button = (event.target as Element)?.closest<HTMLElement>('[data-workspace-row-menu], [data-tree-create-menu]');
    if (!button) return;
    event.preventDefault();
    const rect = button.getBoundingClientRect();
    const actions = button.matches('[data-tree-create-menu]') ? createActions(button.parentElement?.parentElement) : actionsFor(button);
    showContextMenu(actions, rect.left, rect.bottom, button);
  });
  const open = (event: MouseEvent | KeyboardEvent, target: HTMLElement) => {
    if (event.defaultPrevented || target.closest('.app-context-menu')) return;
    closeContextMenu();
    // Native editing, spelling, copy/paste, links and selected text stay usable.
    if (target.closest('input, textarea, select, [contenteditable="true"], .cm-editor, a:not([download])') || (window.getSelection()?.toString() && !target.closest('.workspace-file-row, .note-item-row'))) return;
    const actions = actionsFor(target);
    if (!actions.length) return;
    event.preventDefault();
    const rect = target.getBoundingClientRect();
    const pointer = event instanceof MouseEvent && (event.clientX || event.clientY);
    showContextMenu(actions, pointer ? event.clientX : rect.left, pointer ? event.clientY : rect.bottom, target);
  };
  document.addEventListener('contextmenu', event => { if (event.target instanceof HTMLElement || event.target instanceof SVGElement) open(event, event.target as HTMLElement); });
  document.addEventListener('keydown', event => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) open(event, event.target as HTMLElement);
  });
}
