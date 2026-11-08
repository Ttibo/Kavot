/** The global event handlers of the application: delegated clicks and changes, drag and drop, and the keyboard.
 * Each concern lives in its own module; this one wires them, in the order their routes must be tried. */
import { modalBackdrop, state } from '../state';
import { toast } from '../navigation';
import { ensureEditor } from '../tabs/pages';
import { closeModal, initializeDialogs } from '../../components/dialogs/controller';
import { initializeDocumentLinks } from '../../features/documents/linkNavigation';
import { initializeTreeSelection, selectedTreePaths } from '../../features/documents/treeSelection';
import { activateWorkspaceTab, closeWorkspaceTab, createWorkspaceTab, flushSecondaryNoteAutosave, saveCurrentNote } from '../../features/documents/workspace';
import { handleAction } from './actions';
import { initializeDragAndDrop } from './dragDrop';
import { initializePaperPointerDrag, libraryChangeRoutes, libraryClickRoutes } from './library';
import { documentClickRoutes, initializeCtrlClick, pageClickRoutes, tabClickRoutes } from './opening';
import { dispatch, type Route } from './shared';
import { openFocusedTask, taskChangeRoutes, taskClickRoutes } from './tasks';
import { trashTreeSelection, treeChangeRoutes, treeClickRoutes, treeDeleteRoutes } from './workspaceTree';

export { handleAction };

/** Commands win over generic row selection: several dialog buttons live inside draggable, selectable cards. */
const clickRoutes: Route[] = [
  { selector: '[data-close-modal]', run: (_, event) => { event.preventDefault(); return closeModal(); } },
  { selector: '[data-action]', run: (button, event) => { event.preventDefault(); return handleAction(button.dataset.action, button); } },
  ...tabClickRoutes,
  ...pageClickRoutes,
  ...libraryClickRoutes,
  ...treeClickRoutes,
  ...documentClickRoutes,
  ...taskClickRoutes,
  ...treeDeleteRoutes,
];

const changeRoutes: Route<Event>[] = [...treeChangeRoutes, ...taskChangeRoutes, ...libraryChangeRoutes];

const modalOpen = () => Boolean(modalBackdrop && !modalBackdrop.classList.contains('hidden'));
const pane = () => state.activeNotePane === 'secondary' && state.workspaceTabs.secondary.length ? 'secondary' : 'primary';

function initializeKeyboard() {
  // Delete moves the tree selection to trash while the explorer has focus.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Delete' || event.ctrlKey || event.altKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (!target.closest?.('.notes-sidebar') || target.closest('input, textarea, [contenteditable="true"]') || !selectedTreePaths().length) return;
    event.preventDefault();
    void trashTreeSelection();
  });

  // Ctrl+Tab cycles the tabs of the focused pane. Switches are serialized so rapid presses advance from the last tab.
  let tabSwitch = Promise.resolve();
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || !event.ctrlKey || event.altKey || event.metaKey || modalOpen()) return;
    const focused = (event.target as HTMLElement).closest<HTMLElement>('[data-workspace-pane]')?.dataset.workspacePane;
    const target = focused || state.activeNotePane || 'primary';
    if (!document.querySelector(`[data-workspace-pane="${target}"]`)) return;
    event.preventDefault();
    event.stopPropagation();
    const direction = event.shiftKey ? -1 : 1;
    tabSwitch = tabSwitch.then(async () => {
      const tabs = state.workspaceTabs[target];
      if (tabs.length < 2 || !document.querySelector(`[data-workspace-pane="${target}"]`)) return;
      const index = tabs.findIndex((tab) => tab.id === state.workspaceActiveTabs[target]);
      await activateWorkspaceTab(target, tabs[(index + direction + tabs.length) % tabs.length].id);
      document.querySelector<HTMLElement>(`:is([data-tabs-pane="${target}"], [data-workspace-pane="${target}"]) .workspace-tab.active [data-workspace-tab]`)?.focus();
    }).catch((error) => toast(error.message, 'error'));
  }, true);

  document.addEventListener('keydown', (event) => {
    if (openFocusedTask(event)) return;
    const command = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (command && key === 's') {
      if (document.querySelector('#note-content')) { event.preventDefault(); saveCurrentNote(); }
      else if (document.querySelector('#secondary-note-content')) { event.preventDefault(); flushSecondaryNoteAutosave(); }
    }
    // Ctrl/Cmd+T opens a new tab in the active pane, Ctrl/Cmd+W closes its active tab.
    if (command && !event.altKey && !event.shiftKey && (key === 't' || key === 'w') && !document.querySelector('.modal-backdrop:not(.hidden)')) {
      event.preventDefault();
      const target = pane();
      if (key === 't') { ensureEditor(); void createWorkspaceTab(target); }
      else if (state.workspaceActiveTabs[target]) void closeWorkspaceTab(target, state.workspaceActiveTabs[target]);
    }
    if (event.key === 'Escape' && !event.defaultPrevented) closeModal();
  });
}

let initialized = false;
export function initializeEvents() {
  if (initialized) return;
  initialized = true;
  initializeDocumentLinks();
  initializeTreeSelection();
  // A missing optional overlay must not disable the application's global navigation and command handlers.
  try { initializeDialogs(); }
  catch (error) { console.error('Unable to initialize dialogs', error); }
  initializeCtrlClick();
  document.addEventListener('click', (event) => dispatch(clickRoutes, event));
  document.addEventListener('change', (event) => dispatch(changeRoutes, event));
  initializePaperPointerDrag();
  initializeDragAndDrop();
  initializeKeyboard();
  document.querySelector('#modal-close')?.addEventListener('click', closeModal);
  modalBackdrop?.addEventListener('click', (event) => { if (event.target === modalBackdrop) closeModal(); });
}
