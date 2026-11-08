import { main, state } from '../../../app/state';
import { setMarkdownBlockEditorContent } from '../markdown';
import { decorateTreeSelection } from '../treeSelection';
import { api } from '../../../services/api';
import { prepareEditor } from '../../../app/viewBridge';
import { isDrawingNote, notesForContext, foldersForContext, filterNotesByFolder, activeNoteProjectId } from './notesContext';
import { notesWorkspaceContexts, decorateTreeFocus, bindWorkspaceTreeEditors } from './tree';
import { primaryNoteEditor, drawingNotePane, refreshRelationalNotes, workspaceResourcePane, secondaryResourcePane, emptyWorkspacePane } from './panes';
import { workspaceNoteTab, workspaceResourceTab, ensureWorkspacePaneTab, ensureWorkspaceTab, workspacePaneWithTabs, workspaceTabById, applyWorkspaceTab } from './tabs';
import { flushWorkspaceMarkdownSaves } from './resources';
import { bindNotesWorkspace } from './binding';

function renderNotesWorkspace(projectId = null) {
  const contextNotes = notesForContext(projectId);
  const folders = foldersForContext(projectId);
  const contextProjectId = projectId || activeNoteProjectId();
  if (
    !["all", "root", "readings"].includes(String(state.noteFolderId)) &&
    !folders.some((folder) => folder.id === Number(state.noteFolderId))
  ) {
    state.noteFolderId = "all";
  }
  const scopedNotes = filterNotesByFolder(
    contextNotes,
    folders,
    contextProjectId,
  );
  if (
    state.currentNoteId &&
    !scopedNotes.some((note) => note.id === state.currentNoteId)
  ) state.currentNoteId = null;
  const note =
    scopedNotes.find((item) => item.id === state.currentNoteId) || null;
  ensureWorkspacePaneTab("primary");
  if (state.secondaryResource && !state.workspaceTabs.secondary.length) {
    ensureWorkspaceTab(
      "secondary",
      state.secondaryResource.type === "note"
        ? workspaceNoteTab(
            state.notes.find(
              (item) => item.id === Number(state.secondaryResource.noteId),
            ),
          )
        : workspaceResourceTab(state.secondaryResource),
    );
  }
  const hasSecondaryTabs = state.workspaceTabs.secondary.length > 0;
  const secondary = hasSecondaryTabs
    ? secondaryResourcePane() || emptyWorkspacePane("secondary")
    : "";
  const primary = state.primaryResource
    ? workspaceResourcePane(state.primaryResource, "primary")
    : note
      ? isDrawingNote(note)
        ? drawingNotePane(note, "primary")
        : primaryNoteEditor(note, projectId)
      : emptyWorkspacePane("primary");
  const separator = `<button class="note-workspace-resizer" type="button" role="separator" aria-label="Resize both panes" aria-orientation="vertical" aria-valuemin="25" aria-valuemax="75" aria-valuenow="${state.noteWorkspaceSplitPercent}"><span></span></button>`;
  const primaryStack = workspacePaneWithTabs(primary, "primary");
  const secondaryStack = secondary
    ? workspacePaneWithTabs(secondary, "secondary")
    : "";
  const panes = secondary
    ? state.secondaryFirst
      ? `${secondaryStack}${separator}${primaryStack}`
      : `${primaryStack}${separator}${secondaryStack}`
    : primaryStack;
  const editorWorkspace = `<div class="notes-main-workspace ${secondary ? "with-secondary" : ""} ${state.secondaryFirst ? "secondary-first" : ""}" style="--note-workspace-left:${state.noteWorkspaceSplitPercent}%">${panes}</div>`;
  // The explorer is in the application sidebar: the Workspace view holds only the editor panes.
  return `<section class="notes-layout notes-layout-editor" data-notes-project="${projectId || ""}">${editorWorkspace}</section>`;
}

/** Where everything scrolled inside a pane is. A pane kept across a redraw is moved back into the page, and an
 * element moved in the document loses its scroll position (without any scroll event): it is put back after. */
function scrollPositions(root: Element) {
  return [root, ...root.querySelectorAll("*")]
    .filter((element) => element.scrollTop || element.scrollLeft)
    .map((element) => [element, element.scrollTop, element.scrollLeft] as const);
}

export function renderNotes() {
  prepareEditor();
  const previousPanes = new Map(
    [...main.querySelectorAll("#main-notes-area .workspace-pane-stack")].map(
      (pane) => [(pane as HTMLElement).dataset.workspacePane, pane],
    ),
  );
  const scrolled = new Map([...previousPanes.values()].map((pane) => [pane, scrollPositions(pane)]));
  main.classList.remove("overview-mode");
  main.classList.add("notes-mode");
  const projectId = activeNoteProjectId();
  main.innerHTML = `<div id="main-notes-area">${renderNotesWorkspace(projectId)}</div>`;
  const root = main.querySelector("#main-notes-area");
  // The explorer lives in the application sidebar: redraw it with the editor so it shows the active files.
  rerenderWorkspaceTree();
  previousPanes.forEach((previous, pane) => {
    const replacement = root?.querySelector(
      `.workspace-pane-stack[data-workspace-pane="${pane}"]`,
    );
    if (replacement) {
      let oldSignature, newSignature;
      try {
        oldSignature = JSON.parse((previous as HTMLElement).dataset.workspaceSignature || '{}');
        newSignature = JSON.parse((replacement as HTMLElement).dataset.workspaceSignature || '{}');
      } catch {
        // Rebuild stale panes left by an older interface instead of aborting the refresh.
        return;
      }
      if (!oldSignature || typeof oldSignature !== 'object' || !newSignature || typeof newSignature !== 'object') return;
      const source = previous.querySelector<HTMLTextAreaElement>('textarea.note-content');
      const block = previous.querySelector('.markdown-block-editor');
      const {noteContent: oldContent, ...oldStructure} = oldSignature;
      const {noteContent: newContent, ...newStructure} = newSignature;
      if (source && block && typeof newContent === 'string' && oldContent !== newContent
          && JSON.stringify(oldStructure) === JSON.stringify(newStructure)) {
        // Update the existing CodeMirror session silently, preserving focus/scroll.
        if (source.value !== newContent)
          setMarkdownBlockEditorContent(block, source, newContent, null, null, true);
        (previous as HTMLElement).dataset.workspaceSignature = (replacement as HTMLElement).dataset.workspaceSignature;
      }
    }
    if (
      replacement &&
      (previous as HTMLElement).dataset.workspaceSignature === (replacement as HTMLElement).dataset.workspaceSignature
    )
      replacement.replaceWith(previous);
  });
  // The panes kept as they were are back where they were read (a conversation, a page, a long note).
  for (const [pane, positions] of scrolled) {
    if (!pane.isConnected) continue;
    for (const [element, top, left] of positions) { element.scrollTop = top; element.scrollLeft = left; }
  }
  bindNotesWorkspace(projectId);
  void refreshRelationalNotes();
}

/** Redraws the explorer from the loaded tree: expanding a folder or starting a rename needs no server round trip. */
export function rerenderWorkspaceTree() {
  const tree = document.querySelector("#notes-tree");
  if (!tree) return false;
  state.noteTreeScrollTop = tree.scrollTop;
  tree.innerHTML = notesWorkspaceContexts();
  decorateTreeSelection();
  decorateTreeFocus();
  tree.scrollTop = state.noteTreeScrollTop;
  bindWorkspaceTreeEditors(tree);
  return true;
}

export async function refreshWorkspaceTreeOnly() {
  state.workspaceTree = await api("/workspace/tree");
  if (rerenderWorkspaceTree() && state.view === "notes") await refreshRelationalNotes();
}

export function updateWorkspaceResourcePath(previousPath, renamed) {
  const nextId = `resource:${renamed.path}`;
  ["primary", "secondary"].forEach((pane) => {
    state.workspaceTabs[pane].forEach((tab) => {
      if (tab.type !== "resource" || tab.resource?.path !== previousPath) return;
      const previousId = tab.id;
      tab.resource = { ...tab.resource, ...renamed, title: renamed.name };
      tab.id = nextId;
      if (state.workspaceActiveTabs[pane] === previousId)
        state.workspaceActiveTabs[pane] = nextId;
    });
  });
  if (state.primaryResource?.path === previousPath)
    state.primaryResource = { ...state.primaryResource, ...renamed, title: renamed.name };
  if (state.secondaryResource?.path === previousPath)
    state.secondaryResource = { ...state.secondaryResource, ...renamed, title: renamed.name };
}

export function forgetWorkspaceItems({ path = null, noteIds = [] } = {}) {
  const removedNoteIds = new Set(noteIds.map(Number));
  const matchesPath = (value) =>
    Boolean(path && (value === path || value?.startsWith(`${path}/`)));
  ["primary", "secondary"].forEach((pane) => {
    const active = state.workspaceActiveTabs[pane];
    state.workspaceTabs[pane] = state.workspaceTabs[pane].filter((tab) => {
      if (tab.type === "note") return !removedNoteIds.has(Number(tab.noteId));
      if (tab.type === "resource") return !matchesPath(tab.resource?.path);
      return true;
    });
    if (!state.workspaceTabs[pane].some((tab) => tab.id === active))
      state.workspaceActiveTabs[pane] = state.workspaceTabs[pane][0]?.id || null;
  });
  if (removedNoteIds.has(Number(state.currentNoteId))) state.currentNoteId = null;
  if (
    (state.secondaryResource?.type === "note" &&
      removedNoteIds.has(Number(state.secondaryResource.noteId))) ||
    matchesPath(state.secondaryResource?.path)
  ) state.secondaryResource = null;
  if (matchesPath(state.primaryResource?.path)) state.primaryResource = null;
  const primary = workspaceTabById("primary", state.workspaceActiveTabs.primary);
  const secondary = workspaceTabById("secondary", state.workspaceActiveTabs.secondary);
  if (primary) applyWorkspaceTab("primary", primary);
  if (secondary) applyWorkspaceTab("secondary", secondary);
}

export async function rerenderNotesContext(_projectId = null) {
  const currentTree = document.querySelector("#notes-tree");
  if (currentTree) state.noteTreeScrollTop = currentTree.scrollTop;
  await flushWorkspaceMarkdownSaves();
  renderNotes();
}
