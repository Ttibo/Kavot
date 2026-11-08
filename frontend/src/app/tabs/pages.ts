/** Opening a page of the application (see ../pages.ts) as a tab of the editor. */
import { flushReaderAutosave, main, state } from '../state';
import { publish } from '../viewBridge';
import { isPage, type PageId } from '../pages';
import { viewTitle } from './kinds';
import { applyWorkspaceTab, ensureWorkspaceTab, flushCurrentNoteAutosave, flushSecondaryNoteAutosave, flushWorkspaceMarkdownSaves, renderNotes, replaceActiveWorkspaceTab, workspaceResourceTab } from '../../features/documents/workspace';
import { flushCanvasSaves } from '../../features/documents/canvas';

type Pane = 'primary' | 'secondary';

/** The resource of a page tab. */
function pageResource(view: PageId) {
  return { type: 'view', view, path: `view/${view}`, title: viewTitle(view) };
}

/** The main area shows the editor (it always does once the application has started). */
export function ensureEditor() {
  if (state.view === 'notes') return;
  state.view = 'notes';
  main.classList.remove('reader-mode', 'tasks-mode', 'calendar-mode', 'overview-mode');
  publish();
}

const otherPane = (pane: Pane): Pane => pane === 'secondary' ? 'primary' : 'secondary';

/** Opens a page in the focused pane (in its active tab, or a new one), or in the other pane. */
export async function openPage(view: string, options: { beside?: boolean; newTab?: boolean } = {}) {
  if (!isPage(view)) return;
  await flushCurrentNoteAutosave();
  await flushSecondaryNoteAutosave();
  await flushReaderAutosave();
  await flushWorkspaceMarkdownSaves();
  await flushCanvasSaves();
  ensureEditor();
  const focused: Pane = state.activeNotePane === 'secondary' ? 'secondary' : 'primary';
  const tab = workspaceResourceTab(pageResource(view));
  if (options.beside) {
    const target = otherPane(focused);
    ensureWorkspaceTab(target, tab);
    applyWorkspaceTab(target, tab);
  } else replaceActiveWorkspaceTab(focused, tab, options.newTab);
  renderNotes();
}
