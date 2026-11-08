/** Opening things: editor tabs, notes and files of the vault, internal links, and the pages of the application. */
import { main, state } from '../state';
import { navigate, setActiveNavigation, toast } from '../navigation';
import { ensureEditor } from '../tabs/pages';
import { openCollectionDatabase } from '../../features/collections/catalog';
import { openProjectArea } from '../../features/projects/navigation';
import { openPaper } from '../../features/library/documents';
import { activateWorkspaceTab, activeNoteProjectId, closeWorkspaceTab, createWorkspaceTab, findWorkspaceNode, flushWorkspaceMarkdownSaves, isDrawingNote, reloadNoteForOpen, replaceActiveWorkspaceTab, rerenderNotesContext, workspaceNoteTab, workspaceResourcePayload, workspaceResourceTab } from '../../features/documents/workspace';
import { flushNoteEditors, flushOpenEditors, layoutProjectId, showError, wantsNewTab, type Route } from './shared';

/** The pane a document opens in: the secondary one when it has the focus. */
const focusedPane = () => state.activeNotePane === 'secondary' && state.workspaceTabs.secondary.length ? 'secondary' : 'primary';

async function openNoteLink(link: HTMLElement) {
  const noteId = Number(link.getAttribute('href').slice(6));
  if (!state.notes.some((note) => note.id === noteId)) return toast('This note no longer exists', 'error');
  await flushNoteEditors();
  if (!(await reloadNoteForOpen(noteId))) return;
  const linkedNote = state.notes.find((note) => note.id === noteId);
  if (link.closest('.secondary-note-pane') && state.secondaryResource?.type === 'note' && noteId !== state.currentNoteId) {
    replaceActiveWorkspaceTab('secondary', workspaceNoteTab(linkedNote));
    state.activeNotePane = 'secondary';
    return rerenderNotesContext();
  }
  if (linkedNote?.paper_id) return openPaper(linkedNote.paper_id, activeNoteProjectId());
  replaceActiveWorkspaceTab('primary', workspaceNoteTab(linkedNote));
  state.editorMode = 'edit';
  state.activeNotePane = 'primary';
  state.view = 'notes';
  return rerenderNotesContext();
}

async function openSecondaryNote(button: HTMLElement) {
  await flushNoteEditors();
  const noteId = Number(button.dataset.openSecondaryNote);
  if (!(await reloadNoteForOpen(noteId))) return;
  ensureEditor();
  if (!state.primaryResource && noteId === state.currentNoteId) return toast('This note is already open in the primary pane', 'error');
  state.editorMode = 'edit';
  replaceActiveWorkspaceTab('secondary', workspaceNoteTab(state.notes.find((item) => item.id === noteId)));
  return rerenderNotesContext();
}

async function openWorkspaceResource(control: HTMLElement, event: MouseEvent) {
  event.preventDefault();
  await flushOpenEditors();
  const openBeside = Boolean(control.dataset.openSecondaryResource);
  const node = findWorkspaceNode(control.dataset.openWorkspaceResource || control.dataset.openSecondaryResource);
  if (!node) return toast('This file no longer exists', 'error');
  state.editorMode = 'edit';
  try {
    const resource = await workspaceResourcePayload(node);
    if (state.view !== 'notes') {
      state.view = 'notes';
      main.classList.remove('overview-mode', 'tasks-mode', 'calendar-mode');
      setActiveNavigation('notes');
    }
    replaceActiveWorkspaceTab(openBeside ? 'secondary' : focusedPane(), workspaceResourceTab(resource), wantsNewTab(control, event));
  } catch (error) {
    return showError(error);
  }
  return rerenderNotesContext();
}

async function openNote(control: HTMLElement, event: MouseEvent) {
  event.preventDefault();
  await flushNoteEditors();
  await flushWorkspaceMarkdownSaves();
  const note = await reloadNoteForOpen(Number(control.dataset.note));
  if (!note) return;
  const projectId = layoutProjectId(control);
  state.noteScope = note.project_id ? `project:${note.project_id}` : 'general';
  state.noteFolderId = note.folder_id || 'root';
  // A drawing always opens in the primary pane.
  const drawing = isDrawingNote(note);
  const pane = drawing ? 'primary' : focusedPane();
  if (drawing) {
    state.currentNoteId = note.id;
    state.primaryResource = null;
  }
  replaceActiveWorkspaceTab(pane, workspaceNoteTab(note), wantsNewTab(control, event));
  state.editorMode = 'edit';
  if (!drawing) state.activeNotePane = pane;
  if (!projectId) state.view = 'notes';
  return rerenderNotesContext(projectId);
}

/** Editor tabs (the tab bar is in the window header). */
export const tabClickRoutes: Route[] = [
  { selector: '[data-new-workspace-tab]', run: (button, event) => {
    event.preventDefault();
    return createWorkspaceTab(button.dataset.newWorkspaceTab);
  } },
  { selector: '[data-close-workspace-tab]', run: (button, event) => {
    event.preventDefault();
    event.stopPropagation();
    return closeWorkspaceTab(button.dataset.workspaceTabPane, button.dataset.closeWorkspaceTab);
  } },
  { selector: '[data-workspace-tab]', run: (tab, event) => {
    event.preventDefault();
    return activateWorkspaceTab(tab.dataset.workspaceTabPane, tab.dataset.workspaceTab);
  } },
  { selector: 'a[href^="#note-"]', run: (link, event) => {
    event.preventDefault();
    return openNoteLink(link);
  } },
];

/** Pages of the application, collections and projects. */
export const pageClickRoutes: Route[] = [
  { selector: '[data-collection-nav]', run: (link, event) => {
    event.preventDefault();
    return openCollectionDatabase(link.dataset.collectionNav, { newTab: event.ctrlKey || event.metaKey });
  } },
  { selector: '[data-nav]', run: (link, event) => {
    event.preventDefault();
    // From inside a pane (its new-tab launcher), the page opens in that pane.
    const fromPane = link.closest<HTMLElement>('[data-workspace-pane]')?.dataset.workspacePane;
    if (fromPane === 'primary' || fromPane === 'secondary') state.activeNotePane = fromPane;
    return navigate(link.dataset.nav, { newTab: event.ctrlKey || event.metaKey });
  } },
  { selector: '[data-project-area]', run: (link) => openProjectArea(Number(link.dataset.projectId), link.dataset.projectArea) },
];

/** Notes and files of the vault tree. */
export const documentClickRoutes: Route[] = [
  { selector: '[data-open-secondary-note]', run: (button) => openSecondaryNote(button) },
  { selector: '[data-open-workspace-resource], [data-open-secondary-resource]', run: openWorkspaceResource },
  { selector: '[data-note]', run: openNote },
];

/** Ctrl+click opens a document in a new tab (in the notes tree too; Ctrl+Shift selects there, see treeSelection).
 * macOS turns Ctrl+left-click into a context menu: the gesture is handled at pointerdown and its native
 * follow-up events are suppressed. */
export function initializeCtrlClick() {
  let ctrlDocumentClick = false;
  const documentControl = (target: EventTarget | null) =>
    target instanceof Element ? target.closest<HTMLElement>('[data-note], [data-open-workspace-resource]') : null;
  document.addEventListener('pointerdown', (event) => {
    const control = documentControl(event.target);
    ctrlDocumentClick = event.button === 0 && event.ctrlKey && !event.shiftKey && Boolean(control);
    if (!ctrlDocumentClick) return;
    event.preventDefault();
    event.stopPropagation();
    control.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true }));
  }, true);
  const suppress = (event: MouseEvent) => {
    if (!ctrlDocumentClick || !documentControl(event.target)) return;
    if (event.type === 'click' && !(event.isTrusted && event.ctrlKey)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  document.addEventListener('click', suppress, true);
  document.addEventListener('contextmenu', suppress, true);
}
