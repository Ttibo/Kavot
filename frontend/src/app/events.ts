import { escapeHtml, flushReaderAutosave, main, modalBackdrop, state } from './state';

import { addProjectResourceModal, editProjectModal, newProjectModal } from '../features/projects/dialogs';

import { newRegistryItemModal } from '../features/collections/customRecord';

import { collectionDragPayload, openCollectionDatabase, openCollectionItem, parseCollectionDragPayload, renderSidebarCollections } from '../features/collections/catalog';

import { openSettings } from '../features/settings/actions';

import { editPaperMetadataModal, editPaperModal, newPaperModal, openPaper, openPaperPdfExternally, paperFolderModal, paperPdfUploadModal, paperReferencesModal, previewPaperPdfModal, savePaperProjects } from '../features/library/documents';

import { closeModal, openModal, initializeDialogs } from '../components/dialogs/controller';

import { navigate, refreshData, refreshState, render, setActiveNavigation, toast } from './navigation';

import { deleteTaskColumnModal, newTaskModal, taskArchivesModal, taskColumnModal } from '../features/tasks/dialogs';

import { renderTaskContext, renderTasks } from '../features/tasks/actions';

import { mergeWorkspacePanes, reloadNoteForOpen, activateWorkspaceTab, activeNoteFolderId, activeNoteLocationLabel, activeNoteProjectId, closeWorkspaceTab, createWorkspaceTab, findWorkspaceNode, flushCurrentNoteAutosave, flushSecondaryNoteAutosave, flushWorkspaceMarkdownSaves, forgetWorkspaceItems, isDrawingNote, openNoteDrawing, refreshWorkspaceTreeOnly, renderNotes, rerenderWorkspaceTree, replaceActiveWorkspaceTab, rerenderNotesContext, saveCurrentNote, splitActiveWorkspaceTab, updateWorkspaceResourcePath, workspaceEmptyTab, workspaceNoteTab, workspaceResourcePayload, workspaceResourceTab } from '../features/documents/workspace';

import { addProjectPaperModal, createNewCanvas, createNewDrawing, createNewNote, createNoteFolder, noteSettingsModal } from '../features/documents/dialogs';

import { flushCanvasSaves, removeNoteFromOpenCanvases } from '../features/documents/canvas';

import { paperFolderDescendantIds, paperFolderIds, paperFolderLabel, renderPapers } from '../features/library/filters';

import { openProjectArea } from '../features/projects/navigation';
import { initializeDocumentLinks } from '../features/documents/linkNavigation';
import { clearTreeSelection, initializeTreeSelection, isTreeRowSelected, selectedTreePaths } from '../features/documents/treeSelection';

import { api } from '../services/api';

import { renderDashboard } from './viewActions';

import { editorSession } from './editorSession';


export async function handleAction(action, source) {
  const projectId =
    Number(source?.dataset.projectId || state.selectedProject?.id || 0) || null;
  if (action === "new-project") newProjectModal();
  if (action === "new-conference") newRegistryItemModal("conference");
  if (action === "new-dataset") newRegistryItemModal("dataset");
  if (action === "toggle-collections-sidebar") {
    state.collectionsSidebarOpen = !state.collectionsSidebarOpen;
    localStorage.setItem(
      "kavot-collections-open",
      String(state.collectionsSidebarOpen),
    );
    renderSidebarCollections();
  }
  if (action === "edit-project") editProjectModal(projectId);
  if (action === "add-project-resource") addProjectResourceModal(projectId);
  if (action === "delete-project-resource") {
    const resourceId = source?.dataset.resourceId;
    if (!projectId || !resourceId) return;
    try {
      await api(`/projects/${projectId}/external-resources/${encodeURIComponent(resourceId)}`, { method: "DELETE" });
      await refreshData();
      state.selectedProject = state.projects.find((item) => item.id === projectId) || state.selectedProject;
      render();
      toast("Resource removed from project");
    } catch (error) { toast(error.message, "error"); }
  }
  if (action === "open-project-resource") {
    const target = source?.dataset.resourceTarget;
    if (!target) return;
    try {
      if (window.pywebview?.api?.open_project_resource) {
        const opened = await window.pywebview.api.open_project_resource(target);
        if (!opened) throw new Error("This resource could not be opened");
      } else if (/^https?:\/\//i.test(target)) {
        window.open(target, "_blank", "noopener,noreferrer");
      } else {
        throw new Error("Local folders can be opened from the Kavot desktop app");
      }
    } catch (error) { toast(error.message, "error"); }
  }
  if (action === "manage-templates") await openSettings("templates");
  if (action === "paper-references")
    await paperReferencesModal(Number(source?.dataset.paperId));
  if (action === "preview-paper-pdf")
    previewPaperPdfModal(Number(source?.dataset.paperId), projectId);
  if (action === "add-paper-pdf")
    paperPdfUploadModal(Number(source?.dataset.paperId));
  if (action === "open-paper-pdf") {
    try {
      if (source?.closest(".library-workspace")) {
        state.libraryReadingPaperId = Number(source?.dataset.paperId);
        state.paperProjectContext = projectId;
        return renderPapers();
      }
      await openPaper(Number(source?.dataset.paperId), projectId);
    } catch (error) { toast(error.message, "error"); }
  }
  if (action === "open-paper-workspace") {
    if (source?.closest(".library-workspace")) {
      state.libraryReadingPaperId = Number(source?.dataset.paperId);
      state.paperProjectContext = projectId;
      return renderPapers();
    }
    await openPaper(Number(source?.dataset.paperId), projectId, {
      withNote: source?.dataset.withNote !== "false",
    });
  }
  if (action === "open-paper-modal-note") {
    try {
      await closeModal();
      await openPaper(Number(source?.dataset.paperId), projectId);
    } catch (error) {
      toast(error.message, "error");
    }
  }
  if (action === "new-task")
    newTaskModal(projectId, Number(source?.dataset.columnId || 0) || null);
  if (action === "edit-task")
    newTaskModal(null, null, Number(source?.dataset.taskId));
  if (action === "new-column") taskColumnModal();
  if (action === "edit-column")
    taskColumnModal(Number(source?.dataset.columnId));
  if (action === "task-archives") await taskArchivesModal();
  if (action === "task-view") {
    state.taskView = source?.dataset.taskView === "list" ? "list" : "kanban";
    localStorage.setItem("kavot-task-view", state.taskView);
    renderTasks();
  }
  if (action === "new-note") {
    const targetProjectId = source?.dataset.generalContext
      ? null
      : projectId || activeNoteProjectId();
    const targetFolderId =
      Number(source?.dataset.folderId || 0) ||
      activeNoteFolderId(targetProjectId);
    await createNewNote(
      targetProjectId,
      Number(source?.dataset.paperId || 0) || null,
      targetFolderId,
    );
  }
  if (action === "new-drawing") {
    const targetProjectId = source?.dataset.generalContext
      ? null
      : projectId || activeNoteProjectId();
    const targetFolderId =
      Number(source?.dataset.folderId || 0) ||
      activeNoteFolderId(targetProjectId);
    await createNewDrawing(targetProjectId, targetFolderId);
  }
  if (action === "new-canvas")
    await createNewCanvas(Number(source?.dataset.folderId || 0) || null);
  if (action === "new-folder") {
    const treeRow = source?.closest("[data-folder-scope]");
    if (treeRow?.dataset.folderScope === "general") state.noteScope = "general";
    const targetProjectId = source?.dataset.generalContext
      ? null
      : projectId ||
        Number(treeRow?.dataset.folderProject || 0) ||
        activeNoteProjectId();
    const requestedParent =
      source?.dataset.parentFolderId === "root"
        ? "root"
        : Number(source?.dataset.parentFolderId || 0) || null;
    await createNoteFolder(targetProjectId, requestedParent);
  }
  if (action === "edit-folder") {
    state.editingNoteFolderId = Number(source?.dataset.folderId);
    renderNotes();
  }
  if (action === "new-paper-folder")
    paperFolderModal(
      null,
      Number(source?.dataset.parentPaperFolderId || 0) || null,
    );
  if (action === "edit-paper-folder")
    paperFolderModal(Number(source?.dataset.paperFolderId));
  if (action === "edit-note") {
    const workspaceProjectId =
      Number(source?.closest(".notes-layout")?.dataset.notesProject || 0) ||
      null;
    noteSettingsModal(
      Number(source?.dataset.noteId),
      Number(source?.dataset.noteProject || 0) || null,
      workspaceProjectId,
    );
  }
  if (action === "close-secondary") {
    await flushSecondaryNoteAutosave();
    state.secondaryResource = null;
    state.workspaceTabs.secondary = [];
    state.workspaceActiveTabs.secondary = null;
    state.secondaryFirst = false;
    state.activeNotePane = "primary";
    rerenderNotesContext();
  }
  if (action === "close-primary-resource") {
    await closeWorkspaceTab(
      "primary",
      state.workspaceActiveTabs.primary,
    );
  }
  if (action === "split-active-tab") splitActiveWorkspaceTab();
  if (action === "new-paper") newPaperModal(projectId);
  if (action === "reset-paper-filters") {
    state.paperSearch = "";
    if (!state.selectedProject) state.paperProjectFilter = "all";
    state.paperStatusFilter = "";
    state.paperYearFilter = "all";
    state.paperFolderFilter = "all";
    state.paperPage = 1;
    renderPapers();
  }
  if (action === "add-project-paper") addProjectPaperModal(projectId);
  if (action === "edit-paper") editPaperModal(Number(source?.dataset.paperId));
  if (action === "edit-paper-metadata")
    await editPaperMetadataModal(Number(source?.dataset.paperId));
  if (action === "save-paper-projects") await savePaperProjects(source);
  if (action === "back-from-paper") {
    if (projectId) await openProjectArea(projectId, "papers");
    else await navigate("notes");
  }
  if (
    action === "archive-project" &&
    projectId &&
    confirm("Archive this project?")
  ) {
    try {
      await api(`/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "archived" }),
      });
      await refreshData();
      if (state.view !== "settings") await navigate("dashboard");
      toast("Project archived. Find it in Settings › Archive.");
    } catch (error) {
      toast(error.message, "error");
    }
  }
  if (action === "unarchive-project" && projectId) {
    try {
      await api(`/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "active" }),
      });
      await refreshData();
      toast("Project restored from the archive");
    } catch (error) {
      toast(error.message, "error");
    }
  }
  if (
    action === "delete-project" &&
    projectId &&
    confirm(
      "Move this project, its tasks and its notes to the trash? Shared articles will be kept.",
    )
  ) {
    try {
      await api(`/projects/${projectId}`, { method: "DELETE" });
      await refreshData();
      if (state.view !== "settings") await navigate("dashboard");
      window.dispatchEvent(new Event("kavot:projects-trashed"));
      toast("Project moved to the trash. You can restore it in Settings › Archive.");
    } catch (error) {
      toast(error.message, "error");
    }
  }
  if (action === "load-demo") {
    try {
      await api("/demo", { method: "POST" });
      await refreshData();
      await navigate("dashboard");
      toast("Demo workspace loaded");
    } catch (error) {
      toast(error.message, "error");
    }
  }
}


let folderDropBusy = false;
async function completeLibraryFolderDrop(folderId: number, folder: HTMLElement | null, project: HTMLElement | null) {
  document.body.classList.remove('paper-drag-active');
  document.querySelectorAll('[data-paper-folder-drop].drag-over, [data-paper-project-drop].drag-over').forEach(item => item.classList.remove('drag-over'));
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
        try { await api('/papers/' + paper.id + '/projects/' + projectId, { method: 'POST' }); added++; }
        catch { failed++; }
      }
      await refreshData();
      renderPapers();
      toast(failed ? added + ' articles linked · ' + failed + ' failed. Drop the folder again to retry.' : added + ' articles linked · ' + (papers.length - pending.length) + ' already in project', failed ? 'error' : undefined);
    } else {
      await api('/paper-folders/' + folderId, { method: 'PATCH', body: JSON.stringify({ parent_id: parentId }) });
      if (parentId !== null) state.expandedPaperFolders.add(parentId);
      await refreshData();
      renderPapers();
      toast('Folder moved');
    }
  } catch (error) { toast(error.message, 'error'); }
  finally { folderDropBusy = false; target?.removeAttribute('aria-busy'); }
}

async function completePaperDrop(paperId, folder, project) {
  document.body.classList.remove("paper-drag-active");
  document
    .querySelectorAll("[data-paper-folder-drop].drag-over, [data-paper-project-drop].drag-over")
    .forEach((item) => item.classList.remove("drag-over"));
  if (project) {
    const projectId = Number(project.dataset.paperProjectDrop);
    if (!paperId || !projectId)
      return toast("Unable to link this article", "error");
    const paper = state.papers.find((item) => item.id === paperId);
    const alreadyLinked = paper?.projects.some((item) => item.id === projectId);
    project.setAttribute("aria-busy", "true");
    try {
      if (!alreadyLinked)
        await api(`/papers/${paperId}/projects/${projectId}`, { method: "POST" });
      await refreshData();
      renderPapers();
      toast(
        alreadyLinked
          ? "Article already linked to this project"
          : `Article added to ${state.projects.find((item) => item.id === projectId)?.name || "project"}`,
      );
    } catch (error) {
      project.removeAttribute("aria-busy");
      toast(error.message, "error");
    }
    return;
  }
  const folderId = folder.dataset.paperFolderDrop === "root"
    ? null
    : Number(folder.dataset.paperFolderDrop);
  try {
    await api(`/papers/${paperId}`, {
      method: "PATCH",
      body: JSON.stringify({ folder_id: folderId }),
    });
    await refreshState(["papers", "workspaceTree"]);
    renderPapers();
    toast(`Article moved to ${paperFolderLabel(folderId)}`);
  } catch (error) {
    toast(error.message, "error");
  }
}


let pointerPaperDrag = null;


let pointerWorkspaceDrag = null;


let suppressPaperOpenUntil = 0;


function workspaceDropContext(target) {
  if (!target?.matches?.("[data-workspace-drop]")) return null;
  return {
    projectId: Number(target.dataset.dropProjectId || 0) || null,
    folderId: Number(target.dataset.dropFolderId || 0) || null,
  };
}


function transferHasExternalFiles(transfer) {
  return Boolean(transfer?.types && [...transfer.types].includes("Files"));
}


async function uploadExternalWorkspaceFiles(files, target) {
  const context = workspaceDropContext(target);
  if (!context || !files.length) return;
  target.setAttribute("aria-busy", "true");
  try {
    for (const file of files) {
      const form = new FormData();
      form.append("file", file, file.name);
      if (context.projectId) form.append("project_id", String(context.projectId));
      if (context.folderId) form.append("folder_id", String(context.folderId));
      await api("/workspace/file", { method: "POST", body: form });
    }
    await refreshData();
    renderNotes();
    toast(`${files.length} file${files.length === 1 ? "" : "s"} imported`);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    target.removeAttribute("aria-busy");
    target.classList.remove("workspace-drag-over");
  }
}


async function moveWorkspaceItem(path, target) {
  const context = workspaceDropContext(target);
  const node = findWorkspaceNode(path);
  if (!context || !node) return;
  target.setAttribute("aria-busy", "true");
  try {
    await flushCurrentNoteAutosave();
    await flushSecondaryNoteAutosave();
    await flushWorkspaceMarkdownSaves();
    await flushCanvasSaves();
    if (node.note_id) {
      await api(`/notes/${node.note_id}`, {
        method: "PATCH",
        body: JSON.stringify({
          project_id: context.projectId,
          folder_id: context.folderId,
        }),
      });
    } else {
      const moved = await api("/workspace/move", {
        method: "POST",
        body: JSON.stringify({
          path,
          project_id: context.projectId,
          folder_id: context.folderId,
        }),
      });
      updateWorkspaceResourcePath(path, moved);
    }
    // Only the tree and note locations change: a full reload made every move slow.
    await refreshState(["notes", "workspaceTree", "projects"]);
    renderNotes();
    toast("Document moved");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    target.removeAttribute("aria-busy");
    target.classList.remove("workspace-drag-over");
  }
}


initializeTreeSelection();


/** Notes inside a folder and all its subfolders (they go to trash with it). */
function folderTreeNoteIds(folderId) {
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
  return state.notes
    .filter((note) => descendants.has(note.folder_id))
    .map((note) => note.id);
}


function treeSelectionItems() {
  return selectedTreePaths().flatMap((path) => {
    const node = findWorkspaceNode(path);
    if (!node) return [];
    const folderId = node.kind === "directory" ? Number(node.creation_context?.folder_id || 0) || null : null;
    return [{ path, node, folderId, noteId: Number(node.note_id || 0) || null }];
  });
}


async function flushOpenEditors() {
  await flushCurrentNoteAutosave();
  await flushSecondaryNoteAutosave();
  await flushWorkspaceMarkdownSaves();
  await flushCanvasSaves();
}


function batchToast(done, failed, verb) {
  const plural = (count) => `${count} item${count === 1 ? "" : "s"}`;
  if (failed) toast(`${plural(done)} ${verb}; ${plural(failed)} could not be ${verb}`, "error");
  else toast(`${plural(done)} ${verb}`);
}


async function trashTreeSelection() {
  const items = treeSelectionItems();
  if (!items.length || !confirm(`Move ${items.length === 1 ? "this item" : `these ${items.length} items`} to trash?`)) return;
  try {
    await flushOpenEditors();
  } catch (error) {
    return toast(error.message, "error");
  }
  let done = 0;
  for (const item of items) {
    try {
      let noteIds = item.noteId ? [item.noteId] : [];
      if (item.folderId) {
        noteIds = folderTreeNoteIds(item.folderId);
        await api(`/note-folders/${item.folderId}`, { method: "DELETE" });
      } else {
        await api("/workspace/trash", { method: "POST", body: JSON.stringify({ path: item.path }) });
      }
      noteIds.forEach(removeNoteFromOpenCanvases);
      forgetWorkspaceItems({ path: item.path, noteIds });
      done += 1;
    } catch {
      // Keep going: the summary reports the items that stayed in place.
    }
  }
  clearTreeSelection();
  state.expandedWorkspacePaths.add("trash");
  await refreshState(["notes", "noteFolders", "notePlacements", "workspaceTree", "projects"]);
  await rerenderNotesContext();
  batchToast(done, items.length - done, "moved to trash");
}


async function moveTreeSelection(target) {
  const context = workspaceDropContext(target);
  const items = treeSelectionItems();
  if (!context || !items.length) return;
  target.setAttribute("aria-busy", "true");
  let done = 0;
  let skipped = 0;
  try {
    await flushOpenEditors();
    for (const item of items) {
      try {
        if (item.folderId) {
          // Dropping a folder on itself is a no-op; folders stay within their workspace or project.
          if (item.folderId === context.folderId) { skipped += 1; continue; }
          const folder = state.noteFolders.find((entry) => entry.id === item.folderId);
          if (!folder || (folder.project_id || null) !== context.projectId)
            throw new Error("Folders move within their workspace or project");
          await api(`/note-folders/${item.folderId}`, {
            method: "PATCH",
            body: JSON.stringify({ parent_id: context.folderId }),
          });
        } else if (item.noteId) {
          const note = state.notes.find((entry) => entry.id === item.noteId);
          if (note?.paper_id) {
            if (!context.projectId) throw new Error("Article notes stay in the article folder");
            await api(`/note-placements/${item.noteId}`, {
              method: "PUT",
              body: JSON.stringify({ project_id: context.projectId, folder_id: context.folderId }),
            });
          } else {
            await api(`/notes/${item.noteId}`, {
              method: "PATCH",
              body: JSON.stringify({ project_id: context.projectId, folder_id: context.folderId }),
            });
          }
        } else {
          const moved = await api("/workspace/move", {
            method: "POST",
            body: JSON.stringify({ path: item.path, project_id: context.projectId, folder_id: context.folderId }),
          });
          updateWorkspaceResourcePath(item.path, moved);
        }
        done += 1;
      } catch {
        // Keep going: the summary reports the items that stayed in place.
      }
    }
    clearTreeSelection();
    await refreshState(["notes", "noteFolders", "notePlacements", "workspaceTree", "projects"]);
    await rerenderNotesContext();
    batchToast(done, items.length - done - skipped, "moved");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    target.removeAttribute("aria-busy");
    target.classList.remove("workspace-drag-over");
  }
}


function createPaperDragPreview(paperId, x, y) {
  const paper = state.papers.find((item) => item.id === Number(paperId));
  if (!paper) return null;
  const preview = document.createElement("div");
  preview.className = "paper-drag-preview";
  preview.innerHTML = `<span class="paper-drag-preview-icon">▤</span><div><strong>${escapeHtml(paper.title)}</strong><small>${escapeHtml((paper.authors || []).join(", ") || paper.publication || "Article")}</small><em data-paper-drag-intent>Choose a folder or project</em></div>`;
  document.body.appendChild(preview);
  movePaperDragPreview(preview, x, y);
  requestAnimationFrame(() => preview.classList.add("visible"));
  return preview;
}


function movePaperDragPreview(preview, x, y, folder = null, project = null) {
  if (!preview) return;
  preview.style.transform = `translate3d(${Math.round(x + 18)}px, ${Math.round(y + 16)}px, 0)`;
  const target = project || folder;
  const label = target?.querySelector("strong")?.textContent?.trim();
  const intent = preview.querySelector("[data-paper-drag-intent]");
  if (intent)
    intent.textContent = project
      ? `Add to ${label || "project"}`
      : folder
        ? `Move to ${label || "folder"}`
        : "Choose a folder or project";
  preview.classList.toggle("has-target", Boolean(target));
}


function pointerPaperDropTarget(event) {
  const target = document.elementFromPoint(event.clientX, event.clientY);
  return {
    folder: target?.closest("[data-paper-folder-drop]") || null,
    project: target?.closest("[data-paper-project-drop]") || null,
  };
}


function clearPointerPaperDrag() {
  if (!pointerPaperDrag) return;
  pointerPaperDrag?.row?.classList.remove("dragging");
  pointerPaperDrag?.preview?.remove();
  pointerPaperDrag = null;
  editorSession.activeDragType = null;
  editorSession.activeDragPayload = "";
  document.body.classList.remove("paper-drag-active");
  document
    .querySelectorAll("[data-paper-folder-drop].drag-over, [data-paper-project-drop].drag-over")
    .forEach((item) => item.classList.remove("drag-over"));
}


function clearPointerWorkspaceDrag() {
  pointerWorkspaceDrag?.row?.classList.remove("dragging");
  document
    .querySelectorAll(".canvas-viewport.is-file-drop")
    .forEach((item) => item.classList.remove("is-file-drop"));
  pointerWorkspaceDrag = null;
  if (["note", "workspace"].includes(editorSession.activeDragType)) {
    editorSession.activeDragType = null;
    editorSession.activeDragPayload = "";
  }
}




let initialized = false;
export function initializeEvents() {
  if (initialized) return;
  initialized = true;
  initializeDocumentLinks();
  // A missing optional overlay must not disable the application's global
  // navigation and command handlers.
  try { initializeDialogs(); }
  catch (error) { console.error("Unable to initialize dialogs", error); }



// macOS turns Ctrl+left-click into a context menu, so handle the pointer
// gesture directly and suppress its native follow-up events.
let ctrlDocumentClick = false;
// In the notes tree, Ctrl+click selects several rows instead (see treeSelection).
const documentOpenControl = (target: EventTarget | null) =>
  target instanceof Element && !target.closest('#notes-tree .workspace-file-row')
    ? target.closest<HTMLElement>('[data-note], [data-open-workspace-resource]')
    : null;
document.addEventListener("pointerdown", event => {
  const control = documentOpenControl(event.target);
  ctrlDocumentClick = event.button === 0 && event.ctrlKey && Boolean(control);
  if (!ctrlDocumentClick) return;
  event.preventDefault();
  event.stopPropagation();
  control.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ctrlKey: true }));
}, true);
document.addEventListener("click", event => {
  if (ctrlDocumentClick && event.isTrusted && event.ctrlKey && documentOpenControl(event.target)) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);
document.addEventListener("contextmenu", event => {
  if (ctrlDocumentClick && documentOpenControl(event.target)) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);

document.addEventListener("click", async (event) => {
  const modalClose = (event.target as HTMLElement).closest("[data-close-modal]");
  if (modalClose) {
    event.preventDefault();
    return closeModal();
  }
  // Commands must win over generic row selection. Several modal buttons live
  // inside draggable/selectable cards, so handling the row first can swallow
  // the command that is supposed to open the dialog.
  const action = (event.target as HTMLElement).closest("[data-action]");
  if (action) {
    event.preventDefault();
    return handleAction((action as HTMLElement).dataset.action, action);
  }
  const newWorkspaceTab = (event.target as HTMLElement).closest("[data-new-workspace-tab]");
  if (newWorkspaceTab) {
    event.preventDefault();
    return createWorkspaceTab((newWorkspaceTab as HTMLElement).dataset.newWorkspaceTab);
  }
  const closeTab = (event.target as HTMLElement).closest("[data-close-workspace-tab]");
  if (closeTab) {
    event.preventDefault();
    event.stopPropagation();
    return closeWorkspaceTab(
      (closeTab as HTMLElement).dataset.workspaceTabPane,
      (closeTab as HTMLElement).dataset.closeWorkspaceTab,
    );
  }
  const workspaceTab = (event.target as HTMLElement).closest("[data-workspace-tab]");
  if (workspaceTab) {
    event.preventDefault();
    return activateWorkspaceTab(
      (workspaceTab as HTMLElement).dataset.workspaceTabPane,
      (workspaceTab as HTMLElement).dataset.workspaceTab,
    );
  }
  const internalNoteLink = (event.target as HTMLElement).closest('a[href^="#note-"]');
  if (internalNoteLink) {
    event.preventDefault();
    const noteId = Number(internalNoteLink.getAttribute("href").slice(6));
    if (state.notes.some((note) => note.id === noteId)) {
      await flushCurrentNoteAutosave();
      await flushSecondaryNoteAutosave();
      const freshNote = await reloadNoteForOpen(noteId);
      if (!freshNote) return;
      if (
        internalNoteLink.closest(".secondary-note-pane") &&
        state.secondaryResource?.type === "note" &&
        noteId !== state.currentNoteId
      ) {
        replaceActiveWorkspaceTab("secondary", workspaceNoteTab(state.notes.find(item => item.id === noteId)));
        state.activeNotePane = "secondary";
        return rerenderNotesContext();
      }
      const linkedNote = state.notes.find((note) => note.id === noteId);
      if (linkedNote?.paper_id)
        return openPaper(linkedNote.paper_id, activeNoteProjectId());
      replaceActiveWorkspaceTab("primary", workspaceNoteTab(linkedNote));
      state.editorMode = "edit";
      state.activeNotePane = "primary";
      state.view = "notes";
      return rerenderNotesContext();
    }
    return toast("This note no longer exists", "error");
  }
  const paperNoteLink = (event.target as HTMLElement).closest('a[href^="#paper-"]');
  const externalPdfLink = (event.target as HTMLElement).closest('a[href^="#pdf-external-"]');
  if (externalPdfLink) {
    event.preventDefault();
    const paperId = Number(externalPdfLink.getAttribute('href').slice('#pdf-external-'.length));
    if (Number.isInteger(paperId) && paperId > 0) return openPaperPdfExternally(paperId);
    return;
  }
  if (paperNoteLink) {
    event.preventDefault();
    const paperId = Number(paperNoteLink.getAttribute("href").slice(7));
    const projectId = activeNoteProjectId();
    if (paperId) return openPaper(paperId, projectId);
  }
  const collectionOpen = (event.target as HTMLElement).closest("[data-collection-open]");
  if (collectionOpen) {
    event.preventDefault();
    return openCollectionItem(
      parseCollectionDragPayload(
        (collectionOpen as HTMLElement).dataset.collectionOpen,
      ),
    );
  }
  const collectionNavigation = (event.target as HTMLElement).closest("[data-collection-nav]");
  if (collectionNavigation) {
    event.preventDefault();
    return openCollectionDatabase(
      (collectionNavigation as HTMLElement).dataset.collectionNav,
    );
  }
  const nav = (event.target as HTMLElement).closest("[data-nav]");
  if (nav) {
    event.preventDefault();
    return navigate((nav as HTMLElement).dataset.nav);
  }
  const projectArea = (event.target as HTMLElement).closest("[data-project-area]");
  if (projectArea)
    return openProjectArea(
      Number((projectArea as HTMLElement).dataset.projectId),
      (projectArea as HTMLElement).dataset.projectArea,
    );
  const libraryFolder = (event.target as HTMLElement).closest("[data-library-paper-folder]");
  if (libraryFolder) {
    state.paperFolderFilter = (libraryFolder as HTMLElement).dataset.libraryPaperFolder;
    state.paperProjectFilter = "all";
    state.paperPage = 1;
    return navigate("papers");
  }
  const paperFolderToggle = (event.target as HTMLElement).closest("[data-toggle-paper-folder]");
  if (paperFolderToggle) {
    const folderId = Number((paperFolderToggle as HTMLElement).dataset.togglePaperFolder);
    if (state.expandedPaperFolders.has(folderId))
      state.expandedPaperFolders.delete(folderId);
    else state.expandedPaperFolders.add(folderId);
    return state.view === "papers" ? renderPapers() : renderNotes();
  }
  const paperTreeLeaf = (event.target as HTMLElement).closest(".paper-tree-leaf[data-paper]");
  if (paperTreeLeaf) {
    if (Date.now() < suppressPaperOpenUntil) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const paperId = Number((paperTreeLeaf as HTMLElement).dataset.paper);
    if ((paperTreeLeaf as HTMLElement).closest(".library-workspace")) {
      state.libraryReadingPaperId = paperId;
      return renderPapers();
    }
    return openPaper(paperId);
  }
  const paper = (event.target as HTMLElement).closest("[data-paper]");
  if (paper && Date.now() < suppressPaperOpenUntil) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (
    paper &&
    !(event.target as HTMLElement).closest(
      "select, button, input, label, summary, details, [data-paper-control], [data-paper-drag]",
    )
  )
    {
      const paperId = Number((paper as HTMLElement).dataset.paper);
      const selected = state.papers.find((item) => item.id === paperId);
      if ((paper as HTMLElement).closest(".library-workspace")) {
        state.libraryReadingPaperId = paperId;
        state.paperProjectContext = Number((paper as HTMLElement).dataset.projectContext || 0) || null;
        return renderPapers();
      }
      return selected?.file_path
        ? openPaper(
            paperId,
            Number((paper as HTMLElement).dataset.projectContext || 0) || null,
          )
        : paperPdfUploadModal(paperId);
    }
  if ((event.target as HTMLElement).closest("[data-trash-tree-selection]")) {
    await trashTreeSelection();
    return;
  }
  const trashWorkspace = (event.target as HTMLElement).closest("[data-trash-workspace]");
  if (trashWorkspace) {
    const path = (trashWorkspace as HTMLElement).dataset.trashWorkspace;
    const trashedNoteId = Number(findWorkspaceNode(path)?.note_id || 0) || null;
    if (!confirm("Move this item to trash?")) return;
    try {
      await flushCurrentNoteAutosave();
      await flushSecondaryNoteAutosave();
      await flushCanvasSaves();
      await api("/workspace/trash", {
        method: "POST",
        body: JSON.stringify({ path }),
      });
      if (trashedNoteId) removeNoteFromOpenCanvases(trashedNoteId);
      forgetWorkspaceItems({ path, noteIds: trashedNoteId ? [trashedNoteId] : [] });
      state.expandedWorkspacePaths.add("trash");
      await refreshData();
      await rerenderNotesContext();
      toast("Item moved to trash");
    } catch (error) {
      toast(error.message, "error");
    }
    return;
  }
  const restoreTrash = (event.target as HTMLElement).closest("[data-restore-trash]");
  if (restoreTrash) {
    try {
      const restored = await api(
        `/workspace/trash/${(restoreTrash as HTMLElement).dataset.restoreTrash}/restore`,
        { method: "POST" },
      );
      const parentPath = restored.path.split("/").slice(0, -1).join("/");
      state.expandedWorkspacePaths.add(restored.path.split("/")[0]);
      if (parentPath) state.expandedWorkspacePaths.add(parentPath);
      await refreshData();
      await rerenderNotesContext();
      toast("Item restored to its original location");
    } catch (error) {
      toast(error.message, "error");
    }
    return;
  }
  const deleteTrash = (event.target as HTMLElement).closest("[data-delete-trash]");
  if (deleteTrash) {
    if (
      !confirm(
        "Permanently delete this item? This cannot be undone.",
      )
    )
      return;
    try {
      await api(`/workspace/trash/${(deleteTrash as HTMLElement).dataset.deleteTrash}`, {
        method: "DELETE",
      });
      const marker = `trash/${(deleteTrash as HTMLElement).dataset.deleteTrash}/`;
      if (state.primaryResource?.path?.startsWith(marker))
        state.primaryResource = null;
      if (state.secondaryResource?.path?.startsWith(marker))
        state.secondaryResource = null;
      await refreshData();
      await rerenderNotesContext();
      toast("Item permanently deleted");
    } catch (error) {
      toast(error.message, "error");
    }
    return;
  }
  const deletePaperFolder = (event.target as HTMLElement).closest("[data-delete-paper-folder]");
  if (deletePaperFolder) {
    if (
      !confirm(
        "Delete this folder and its subfolders? Articles will be kept and moved to Unfiled.",
      )
    )
      return;
    try {
      await api(
        `/paper-folders/${(deletePaperFolder as HTMLElement).dataset.deletePaperFolder}`,
        { method: "DELETE" },
      );
      closeModal();
      state.paperFolderFilter = "all";
      await refreshData();
      if (state.view === "papers") renderPapers();
      else renderNotes();
      toast("Folder deleted; articles kept");
    } catch (error) {
      toast(error.message, "error");
    }
    return;
  }
  const workspaceToggle = (event.target as HTMLElement).closest("[data-workspace-toggle]");
  if (workspaceToggle) {
    const path = (workspaceToggle as HTMLElement).dataset.workspaceToggle;
    if (state.expandedWorkspacePaths.has(path))
      state.expandedWorkspacePaths.delete(path);
    else state.expandedWorkspacePaths.add(path);
    return rerenderWorkspaceTree();
  }
  const inlineFolderRename = (event.target as HTMLElement).closest(
    "[data-inline-rename-folder]",
  );
  if (inlineFolderRename) {
    state.editingNoteFolderId = Number(
      (inlineFolderRename as HTMLElement).dataset.inlineRenameFolder,
    );
    rerenderWorkspaceTree();
    return;
  }
  const renameNote = (event.target as HTMLElement).closest<HTMLElement>("[data-rename-note]");
  if (renameNote) {
    await flushCurrentNoteAutosave();
    await flushSecondaryNoteAutosave();
    const note = state.notes.find(item => item.id === Number(renameNote.dataset.renameNote));
    if (!note) return;
    openModal(`<header class="modal-header"><h2>Rename note</h2></header><form id="rename-note-form" class="modal-body form-grid"><label class="form-field full">Note title<input name="title" required maxlength="240" value="${escapeHtml(note.title)}"></label><div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button class="button button-primary">Rename</button></div></form>`);
    const form = document.querySelector<HTMLFormElement>("#rename-note-form");
    form.querySelector<HTMLInputElement>("input").select();
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const title = String(new FormData(form).get("title") || "").trim();
      if (!title) return;
      try {
        Object.assign(note, await api(`/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ title }) }));
        await refreshState(["notes", "workspaceTree"]);
        const query = document.querySelector<HTMLInputElement>("#note-filter")?.value || "";
        closeModal();
        await rerenderNotesContext();
        const filter = document.querySelector<HTMLInputElement>("#note-filter");
        if (filter && query) { filter.value = query; filter.dispatchEvent(new Event("input", { bubbles: true })); }
        toast("Note renamed");
      } catch (error) { toast(error.message, "error"); }
    });
    return;
  }
  const inlineWorkspaceRename = (event.target as HTMLElement).closest(
    "[data-inline-rename-workspace]",
  );
  if (inlineWorkspaceRename) {
    await flushCurrentNoteAutosave();
    await flushSecondaryNoteAutosave();
    state.editingWorkspacePath = (inlineWorkspaceRename as HTMLElement).dataset.inlineRenameWorkspace;
    rerenderWorkspaceTree();
    return;
  }
  const secondaryNote = (event.target as HTMLElement).closest("[data-open-secondary-note]");
  if (secondaryNote) {
    await flushCurrentNoteAutosave();
    await flushSecondaryNoteAutosave();
    const noteId = Number((secondaryNote as HTMLElement).dataset.openSecondaryNote);
    const drawing = await reloadNoteForOpen(noteId);
    if (!drawing) return;
    if (!state.primaryResource && noteId === state.currentNoteId)
      return toast(
        "This note is already open in the primary pane",
        "error",
      );
    state.editorMode = "edit";
    replaceActiveWorkspaceTab(
      "secondary",
      workspaceNoteTab(state.notes.find((item) => item.id === noteId)),
    );
    return rerenderNotesContext();
  }
  const workspaceResource = (event.target as HTMLElement).closest(
    "[data-open-workspace-resource], [data-open-secondary-resource]",
  );
  if (workspaceResource) {
    event.preventDefault();
    await flushCurrentNoteAutosave();
    await flushSecondaryNoteAutosave();
    await flushWorkspaceMarkdownSaves();
    await flushCanvasSaves();
    const openBeside = Boolean((workspaceResource as HTMLElement).dataset.openSecondaryResource);
    const path =
      (workspaceResource as HTMLElement).dataset.openWorkspaceResource ||
      (workspaceResource as HTMLElement).dataset.openSecondaryResource;
    const node = findWorkspaceNode(path);
    if (!node) return toast("This file no longer exists", "error");
    state.editorMode = "edit";
    try {
      const resource = await workspaceResourcePayload(node);
      if (state.view !== "notes") {
        state.view = "notes";
        main.classList.remove("overview-mode", "tasks-mode", "calendar-mode");
        setActiveNavigation("notes");
      }
      const pane = openBeside
        ? "secondary"
        : state.activeNotePane === "secondary" && state.workspaceTabs.secondary.length
          ? "secondary"
          : "primary";
      replaceActiveWorkspaceTab(pane, workspaceResourceTab(resource), (workspaceResource as HTMLElement).dataset.openInNewTab === "true" || (event.button === 0 && event.ctrlKey));
    } catch (error) {
      return toast(error.message, "error");
    }
    return rerenderNotesContext();
  }
  const folderToggle = (event.target as HTMLElement).closest("[data-toggle-folder]");
  if (folderToggle) {
    const folderId = Number((folderToggle as HTMLElement).dataset.toggleFolder);
    if (state.collapsedFolders.has(folderId))
      state.collapsedFolders.delete(folderId);
    else state.collapsedFolders.add(folderId);
    const projectId =
      Number(
        (folderToggle.closest(".notes-layout") as HTMLElement)?.dataset.notesProject || 0,
      ) || null;
    return rerenderNotesContext(projectId);
  }
  const spaceToggle = (event.target as HTMLElement).closest("[data-toggle-space]");
  if (spaceToggle) {
    const scope = (spaceToggle as HTMLElement).dataset.toggleSpace;
    if (state.collapsedSpaces.has(scope)) state.collapsedSpaces.delete(scope);
    else state.collapsedSpaces.add(scope);
    const projectId =
      Number((spaceToggle.closest(".notes-layout") as HTMLElement)?.dataset.notesProject || 0) ||
      null;
    return rerenderNotesContext(projectId);
  }
  const noteScope = (event.target as HTMLElement).closest("[data-note-scope]");
  if (noteScope) {
    state.noteScope = (noteScope as HTMLElement).dataset.noteScope;
    state.noteFolderId = "all";
    state.currentNoteId = null;
    state.primaryResource = null;
    replaceActiveWorkspaceTab("primary", workspaceEmptyTab("primary"));
    const projectId =
      Number((noteScope.closest(".notes-layout") as HTMLElement)?.dataset.notesProject || 0) ||
      null;
    return rerenderNotesContext(projectId);
  }
  const noteFolder = (event.target as HTMLElement).closest("[data-note-folder]");
  if (noteFolder) {
    state.noteScope = (noteFolder as HTMLElement).dataset.folderProject
      ? `project:${(noteFolder as HTMLElement).dataset.folderProject}`
      : (noteFolder as HTMLElement).dataset.folderScope || "general";
    state.noteFolderId = (noteFolder as HTMLElement).dataset.noteFolder;
    state.currentNoteId = null;
    state.primaryResource = null;
    replaceActiveWorkspaceTab("primary", workspaceEmptyTab("primary"));
    const projectId =
      Number((noteFolder.closest(".notes-layout") as HTMLElement)?.dataset.notesProject || 0) ||
      null;
    return rerenderNotesContext(projectId);
  }
  const drawing = (event.target as HTMLElement).closest("[data-open-note-drawing]");
  if (drawing) {
    const drawingNote = state.notes.find(item => item.id === Number((drawing as HTMLElement).dataset.openNoteDrawing));
    if (drawingNote) openNoteDrawing(drawingNote);
    return;
  }
  const note = (event.target as HTMLElement).closest("[data-note]");
  if (note) {
    event.preventDefault();
    await flushCurrentNoteAutosave();
    await flushSecondaryNoteAutosave();
    await flushWorkspaceMarkdownSaves();
    const selectedNoteId = Number((note as HTMLElement).dataset.note);
    const selectedNote = await reloadNoteForOpen(selectedNoteId);
    if (!selectedNote) return;
    const projectId =
      Number((note.closest(".notes-layout") as HTMLElement)?.dataset.notesProject || 0) || null;
    if ((note as HTMLElement).dataset.noteTreeScope) {
      state.noteScope = (note as HTMLElement).dataset.noteTreeScope;
      state.noteFolderId =
        (note as HTMLElement).dataset.noteTreeFolder === "readings"
          ? "readings"
          : (note as HTMLElement).dataset.noteTreeFolder
            ? Number((note as HTMLElement).dataset.noteTreeFolder)
            : "root";
    } else if (selectedNote) {
      state.noteScope = selectedNote.project_id
        ? `project:${selectedNote.project_id}`
        : "general";
      state.noteFolderId = selectedNote.folder_id || "root";
    }
    if (isDrawingNote(selectedNote)) {
      state.currentNoteId = selectedNote.id;
      state.primaryResource = null;
      replaceActiveWorkspaceTab("primary", workspaceNoteTab(selectedNote), (note as HTMLElement).dataset.openInNewTab === "true" || (event.button === 0 && event.ctrlKey));
      state.editorMode = "edit";
      if (!projectId) state.view = "notes";
      return rerenderNotesContext(projectId);
    }
    const pane =
      state.activeNotePane === "secondary" && state.workspaceTabs.secondary.length
        ? "secondary"
        : "primary";
    replaceActiveWorkspaceTab(pane, workspaceNoteTab(selectedNote), (note as HTMLElement).dataset.openInNewTab === "true" || (event.button === 0 && event.ctrlKey));
    state.editorMode = "edit";
    state.activeNotePane = pane;
    if (!projectId) state.view = "notes";
    return rerenderNotesContext(projectId);
  }
  const taskStatus = (event.target as HTMLElement).closest("[data-task-status]");
  if (taskStatus) {
    try {
      await api(`/tasks/${(taskStatus as HTMLElement).dataset.taskStatus}`, {
        method: "PATCH",
        body: JSON.stringify({ status: (taskStatus as HTMLElement).dataset.status }),
      });
      await refreshState(["tasks", "taskColumns", "projects"]);
      await renderTaskContext();
      toast("Status updated");
    } catch (error) {
      toast(error.message, "error");
    }
  }
  const deleteTask = (event.target as HTMLElement).closest("[data-delete-task]");
  if (deleteTask && confirm("Delete this task?")) {
    try {
      await api(`/tasks/${(deleteTask as HTMLElement).dataset.deleteTask}`, {
        method: "DELETE",
      });
      await refreshState(["tasks", "taskColumns", "projects"]);
      await renderTaskContext();
      toast("Task deleted");
    } catch (error) {
      toast(error.message, "error");
    }
  }
  const archiveTask = (event.target as HTMLElement).closest("[data-archive-task]");
  if (archiveTask) {
    try {
      await api(`/tasks/${(archiveTask as HTMLElement).dataset.archiveTask}/archive`, {
        method: "POST",
      });
      closeModal();
      await refreshState(["tasks", "taskColumns", "projects"]);
      await renderTaskContext();
      toast("Task archived");
    } catch (error) {
      toast(error.message, "error");
    }
  }
  const restoreTask = (event.target as HTMLElement).closest("[data-restore-task]");
  if (restoreTask) {
    try {
      await api(`/tasks/${(restoreTask as HTMLElement).dataset.restoreTask}/restore`, {
        method: "POST",
      });
      closeModal();
      await refreshState(["tasks", "taskColumns", "projects"]);
      renderTasks();
      toast("Task restored");
      await taskArchivesModal();
    } catch (error) {
      toast(error.message, "error");
    }
  }
  const deleteArchivedTask = (event.target as HTMLElement).closest(
    "[data-delete-archived-task]",
  );
  if (
    deleteArchivedTask &&
    confirm("Permanently delete this archived task?")
  ) {
    try {
      await api(`/tasks/${(deleteArchivedTask as HTMLElement).dataset.deleteArchivedTask}`, {
        method: "DELETE",
      });
      closeModal();
      await refreshState(["tasks", "taskColumns", "projects"]);
      renderTasks();
      toast("Task permanently deleted");
      await taskArchivesModal();
    } catch (error) {
      toast(error.message, "error");
    }
  }
  const deleteColumn = (event.target as HTMLElement).closest("[data-delete-column]");
  if (deleteColumn)
    return deleteTaskColumnModal(Number((deleteColumn as HTMLElement).dataset.deleteColumn));
  const deleteTemplate = (event.target as HTMLElement).closest("[data-delete-template]");
  if (
    deleteTemplate &&
    confirm("Delete this template? Existing notes will be kept.")
  ) {
    try {
      await api(`/note-templates/${(deleteTemplate as HTMLElement).dataset.deleteTemplate}`, {
        method: "DELETE",
      });
      await refreshData();
      if (state.view === "dashboard") renderDashboard();
      await openSettings("templates");
      toast("Template deleted");
    } catch (error) {
      toast(error.message, "error");
    }
  }
  const deleteNote = (event.target as HTMLElement).closest("[data-delete-note]");
  if (deleteNote && confirm("Move this note to trash?")) {
    const deletedNoteId = Number((deleteNote as HTMLElement).dataset.deleteNote);
    const projectId =
      Number(
        (deleteNote as HTMLElement).dataset.workspaceProject ||
          (deleteNote.closest(".notes-layout") as HTMLElement)?.dataset.notesProject ||
          0,
      ) || null;
    try {
      await flushCanvasSaves();
      await api(`/notes/${deletedNoteId}`, {
        method: "DELETE",
      });
      removeNoteFromOpenCanvases(deletedNoteId);
      forgetWorkspaceItems({ noteIds: [deletedNoteId] });
      closeModal();
      state.currentNoteId = null;
      state.expandedWorkspacePaths.add("trash");
      await refreshState(["notes", "workspaceTree", "projects", "papers"]);
      await rerenderNotesContext(projectId);
      toast("Note moved to trash");
    } catch (error) {
      toast(error.message, "error");
    }
  }
  const deleteFolder = (event.target as HTMLElement).closest("[data-delete-folder]");
  if (
    deleteFolder &&
    confirm(
      "Move this folder, its subfolders, and notes to trash?",
    )
  ) {
    const folderId = Number((deleteFolder as HTMLElement).dataset.deleteFolder);
    const folder = state.noteFolders.find(
      (item) => item.id === folderId,
    );
    const removedNoteIds = folderTreeNoteIds(folderId);
    try {
      await flushCanvasSaves();
      await api(`/note-folders/${folderId}`, {
        method: "DELETE",
      });
      removedNoteIds.forEach(removeNoteFromOpenCanvases);
      forgetWorkspaceItems({ noteIds: removedNoteIds });
      closeModal();
      state.noteFolderId = "all";
      state.expandedWorkspacePaths.add("trash");
      await refreshState(["notes", "noteFolders", "workspaceTree", "projects"]);
      await rerenderNotesContext(folder?.project_id || null);
      toast("Folder moved to trash");
    } catch (error) {
      toast(error.message, "error");
    }
  }
  const removePaperProject = (event.target as HTMLElement).closest("[data-remove-paper-project]");
  if (removePaperProject) {
    const paperId = (removePaperProject as HTMLElement).dataset.removePaperProject;
    const projectId = (removePaperProject as HTMLElement).dataset.projectId;
    if (!paperId || !projectId || !confirm("Remove this article from the project? The article will remain in your library.")) return;
    try {
      await api(`/papers/${paperId}/projects/${projectId}`, { method: "DELETE" });
      closeModal();
      await refreshData();
      renderPapers();
      toast("Article removed from project");
    } catch (error) {
      toast(error.message, "error");
    }
    return;
  }
  const deletePaper = (event.target as HTMLElement).closest("[data-delete-paper]");
  if (
    deletePaper &&
    confirm("Delete this article, its PDF, and its reading notes?")
  ) {
    clearTimeout(editorSession.readerAutosaveTimer);
    editorSession.pendingReaderSave = null;
    try {
      const returnProject = state.view === "notes" ? state.paperProjectContext : null;
      await api(`/papers/${(deletePaper as HTMLElement).dataset.deletePaper}`, {
        method: "DELETE",
      });
      closeModal();
      await refreshData();
      toast("Article deleted");
      if (returnProject) await openProjectArea(returnProject, "papers");
      else await navigate("papers");
    } catch (error) {
      toast(error.message, "error");
    }
  }
});



document.addEventListener("change", async (event) => {
  const folderColor = (event.target as HTMLElement).closest("[data-workspace-folder-color]");
  if (folderColor) {
    event.stopPropagation();
    const folderId = Number((folderColor as HTMLElement).dataset.workspaceFolderColor);
    try {
      const updated = await api(`/note-folders/${folderId}`, {
        method: "PATCH",
        body: JSON.stringify({ color: (folderColor as HTMLInputElement).value }),
      });
      const cached = state.noteFolders.find((item) => item.id === folderId);
      if (cached) Object.assign(cached, updated);
      await refreshWorkspaceTreeOnly();
      toast("Folder color updated");
    } catch (error) {
      toast(error.message, "error");
    }
    return;
  }
  const taskColumn = (event.target as HTMLElement).closest("[data-task-column-set]");
  if (taskColumn) {
    event.stopPropagation();
    try {
      await api(`/tasks/${(taskColumn as HTMLElement).dataset.taskColumnSet}`, {
        method: "PATCH",
        body: JSON.stringify({ column_id: Number((taskColumn as HTMLInputElement).value) }),
      });
      await refreshState(["tasks", "taskColumns", "projects"]);
      renderTasks();
      toast("Task status updated");
    } catch (error) {
      toast(error.message, "error");
    }
    return;
  }
  const folderControl = (event.target as HTMLElement).closest("[data-paper-folder-set]");
  if (folderControl) {
    event.stopPropagation();
    const folderId = (folderControl as HTMLInputElement).value ? Number((folderControl as HTMLInputElement).value) : null;
    try {
      await api(`/papers/${(folderControl as HTMLElement).dataset.paperFolderSet}`, {
        method: "PATCH",
        body: JSON.stringify({ folder_id: folderId }),
      });
      await refreshState(["papers", "workspaceTree"]);
      renderPapers();
      toast(`Article moved to ${paperFolderLabel(folderId)}`);
    } catch (error) {
      toast(error.message, "error");
    }
    return;
  }
  const control = (event.target as HTMLElement).closest("[data-paper-status]");
  if (!control) return;
  event.stopPropagation();
  try {
    await api(`/papers/${(control as HTMLElement).dataset.paperStatus}`, {
      method: "PATCH",
      body: JSON.stringify({ status: (control as HTMLInputElement).value }),
    });
    await refreshState(["papers"]);
    render();
    toast("Reading status updated");
  } catch (error) {
    toast(error.message, "error");
  }
});



document.addEventListener("pointerdown", (event) => {
  const row = (event.target as HTMLElement).closest(
    ".workspace-file-row.file[data-note-drag], .workspace-file-row.file[data-workspace-drag]",
  );
  if (!row || event.button !== 0) return;
  if (
    (event.target as HTMLElement).closest(
      "button, input, label, a, .workspace-item-actions, .workspace-open-side",
    )
  ) return;
  const noteId = Number((row as HTMLElement).dataset.noteDrag || 0) || null;
  const workspacePath = (row as HTMLElement).dataset.workspaceDrag || "";
  pointerWorkspaceDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    dragging: false,
    row,
    type: noteId ? "note" : "workspace",
    payload: noteId ? `note:${noteId}` : `workspace:${workspacePath}`,
  };
  (row as HTMLElement).setPointerCapture?.(event.pointerId);
});



document.addEventListener("pointermove", (event) => {
  const drag = pointerWorkspaceDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  const distance = Math.hypot(
    event.clientX - drag.startX,
    event.clientY - drag.startY,
  );
  if (!drag.dragging && distance < 6) return;
  if (!drag.dragging) {
    drag.dragging = true;
    drag.row.classList.add("dragging");
    editorSession.activeDragType = drag.type;
    editorSession.activeDragPayload = drag.payload;
  }
  const viewport = document
    .elementFromPoint(event.clientX, event.clientY)
    ?.closest?.(".canvas-viewport, .continuous-editor");
  document.querySelectorAll(".canvas-viewport").forEach((item) =>
    item.classList.toggle("is-file-drop", item === viewport),
  );
  event.preventDefault();
});



document.addEventListener("pointerup", (event) => {
  const drag = pointerWorkspaceDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  const viewport = document
    .elementFromPoint(event.clientX, event.clientY)
    ?.closest?.(".canvas-viewport, .continuous-editor");
  if (drag.dragging && viewport) {
    event.preventDefault();
    const transfer = new DataTransfer();
    transfer.effectAllowed = "all";
    transfer.setData(
      drag.type === "note"
        ? "application/x-kavot-note"
        : "application/x-kavot-workspace",
      drag.payload,
    );
    transfer.setData("text/plain", drag.payload);
    viewport.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        clientX: event.clientX,
        clientY: event.clientY,
        dataTransfer: transfer,
      }),
    );
  }
  clearPointerWorkspaceDrag();
});



document.addEventListener("pointercancel", clearPointerWorkspaceDrag);



document.addEventListener("pointerdown", (event) => {
  const handle = (event.target as HTMLElement).closest("[data-paper-drag]");
  const row = (event.target as HTMLElement).closest(".paper-row[data-paper]");
  if (!row || event.button !== 0) return;
  // The explicit handle uses native drag-and-drop so it also works with an
  // open project canvas. Keep pointer dragging only for the rest of the row.
  if (handle) return;
  if (
    !handle &&
    (event.target as HTMLElement).closest(
      "select, button, input, label, summary, details, a, [data-paper-control]",
    )
  )
    return;
  pointerPaperDrag = {
    id: Number((handle as HTMLElement)?.dataset.paperDrag || (row as HTMLElement).dataset.paper),
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    dragging: false,
    row,
    preview: null,
  };
  row.setPointerCapture?.(event.pointerId);
});



document.addEventListener("pointermove", (event) => {
  if (!pointerPaperDrag || event.pointerId !== pointerPaperDrag.pointerId) return;
  const distance = Math.hypot(
    event.clientX - pointerPaperDrag.startX,
    event.clientY - pointerPaperDrag.startY,
  );
  if (!pointerPaperDrag.dragging && distance < 6) return;
  if (!pointerPaperDrag.dragging) {
    pointerPaperDrag.dragging = true;
    editorSession.activeDragType = "paper";
    editorSession.activeDragPayload = `paper:${pointerPaperDrag.id}`;
    pointerPaperDrag.row?.classList.add("dragging");
    document.body.classList.add("paper-drag-active");
    pointerPaperDrag.preview = createPaperDragPreview(
      pointerPaperDrag.id,
      event.clientX,
      event.clientY,
    );
  }
  const { folder, project } = pointerPaperDropTarget(event);
  movePaperDragPreview(
    pointerPaperDrag.preview,
    event.clientX,
    event.clientY,
    folder,
    project,
  );
  document.querySelectorAll("[data-paper-folder-drop]").forEach((item) =>
    item.classList.toggle("drag-over", item === folder),
  );
  document.querySelectorAll("[data-paper-project-drop]").forEach((item) =>
    item.classList.toggle("drag-over", item === project),
  );
  event.preventDefault();
});



document.addEventListener("pointerup", async (event) => {
  if (!pointerPaperDrag || event.pointerId !== pointerPaperDrag.pointerId) return;
  const drag = pointerPaperDrag;
  const { folder, project } = pointerPaperDropTarget(event);
  if (drag.dragging) suppressPaperOpenUntil = Date.now() + 500;
  clearPointerPaperDrag();
  if (!drag.dragging || (!folder && !project)) return;
  event.preventDefault();
  await completePaperDrop(drag.id, folder, project);
});



document.addEventListener("pointercancel", clearPointerPaperDrag);



document.addEventListener("dragstart", (event) => {
  // Dragging one row of a multi-selection carries the whole selection.
  const treeRow = (event.target as HTMLElement).closest?.(".workspace-file-row");
  if (isTreeRowSelected(treeRow)) {
    editorSession.activeDragType = "workspace";
    editorSession.activeDragPayload = "selection:tree";
    document.querySelectorAll(".workspace-file-row.multi-selected").forEach((row) => row.classList.add("dragging"));
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", editorSession.activeDragPayload);
    return;
  }
  const collectionItem = (event.target as HTMLElement).closest("[data-collection-drag]");
  if (collectionItem) {
    editorSession.activeDragType = "collection";
    editorSession.activeDragPayload = (collectionItem as HTMLElement).dataset.collectionDrag;
    collectionItem.classList.add("dragging");
    event.dataTransfer.effectAllowed = "link";
    event.dataTransfer.setData(
      "application/x-kavot-collection",
      editorSession.activeDragPayload,
    );
    event.dataTransfer.setData("text/plain", editorSession.activeDragPayload);
    return;
  }
  const draggedNote = (event.target as HTMLElement).closest("[data-note-drag]");
  if (draggedNote) {
    editorSession.activeDragType = "note";
    editorSession.activeDragPayload = `note:${(draggedNote as HTMLElement).dataset.noteDrag}`;
    draggedNote.classList.add("dragging");
    event.dataTransfer.effectAllowed = draggedNote.hasAttribute("data-reference-drag") ? "link" : "all";
    event.dataTransfer.setData("application/x-kavot-note", editorSession.activeDragPayload);
    event.dataTransfer.setData("text/plain", editorSession.activeDragPayload);
    return;
  }
  // Only canvases accept a project: they import its canvas.
  const draggedProject = (event.target as HTMLElement).closest<HTMLElement>("[data-project-drag]");
  if (draggedProject) {
    editorSession.activeDragType = "project";
    editorSession.activeDragPayload = `project:${draggedProject.dataset.projectDrag}`;
    draggedProject.classList.add("dragging");
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("application/x-kavot-project", editorSession.activeDragPayload);
    return;
  }
  const workspaceItem = (event.target as HTMLElement).closest("[data-workspace-drag]");
  if (workspaceItem) {
    editorSession.activeDragType = "workspace";
    editorSession.activeDragPayload = `workspace:${(workspaceItem as HTMLElement).dataset.workspaceDrag}`;
    workspaceItem.classList.add("dragging");
    event.dataTransfer.effectAllowed = workspaceItem.hasAttribute("data-reference-drag") ? "link" : "all";
    event.dataTransfer.setData("application/x-kavot-workspace", editorSession.activeDragPayload);
    event.dataTransfer.setData("text/plain", editorSession.activeDragPayload);
    return;
  }
  const libraryFolder = (event.target as HTMLElement).closest<HTMLElement>('[data-paper-folder-drag]');
  if (libraryFolder) {
    editorSession.activeDragType = 'paper-folder';
    editorSession.activeDragPayload = 'paper-folder:' + libraryFolder.dataset.paperFolderDrag;
    event.dataTransfer.effectAllowed = 'all';
    event.dataTransfer.setData('text/plain', editorSession.activeDragPayload);
    document.body.classList.add('paper-drag-active');
    return;
  }
  const paper = (event.target as HTMLElement).closest("[data-paper-drag]");
  if (paper) {
    const paperId = Number((paper as HTMLElement).dataset.paperDrag);
    editorSession.activeDragType = "paper";
    editorSession.activeDragPayload = `paper:${paperId}`;
    paper.closest(".paper-row")?.classList.add("dragging");
    document.body.classList.add("paper-drag-active");
    event.dataTransfer.effectAllowed = "all";
    event.dataTransfer.setData("application/x-kavot-paper", editorSession.activeDragPayload);
    event.dataTransfer.setData(
      "application/x-kavot-collection",
      collectionDragPayload("paper", paperId, "articles"),
    );
    event.dataTransfer.setData("text/plain", editorSession.activeDragPayload);
    return;
  }
  const paneHandle = (event.target as HTMLElement).closest("[data-pane-drag]");
  if (paneHandle) {
    editorSession.activeDragType = "pane";
    editorSession.activeDragPayload = `pane:${(paneHandle as HTMLElement).dataset.paneDrag}`;
    paneHandle.closest("[data-workspace-pane]")?.classList.add("pane-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(
      "text/plain",
      `pane:${(paneHandle as HTMLElement).dataset.paneDrag}`,
    );
    return;
  }
  const folder = (event.target as HTMLElement).closest("[data-folder-drag]");
  if (folder) {
    editorSession.activeDragType = "folder";
    editorSession.activeDragPayload = `folder:${(folder as HTMLElement).dataset.folderDrag}`;
    folder.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(
      "text/plain",
      `folder:${(folder as HTMLElement).dataset.folderDrag}`,
    );
    return;
  }
  const columnHandle = (event.target as HTMLElement).closest("[data-column-drag]");
  if (columnHandle) {
    editorSession.activeDragType = "column";
    editorSession.activeDragPayload = `column:${(columnHandle as HTMLElement).dataset.columnDrag}`;
    columnHandle.closest(".kanban-column")?.classList.add("column-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(
      "text/plain",
      `column:${(columnHandle as HTMLElement).dataset.columnDrag}`,
    );
    return;
  }
  const card = (event.target as HTMLElement).closest("[data-task-id]");
  if (!card) return;
  editorSession.activeDragType = "task";
  editorSession.activeDragPayload = (card as HTMLElement).dataset.taskId;
  card.classList.add("dragging");
  event.dataTransfer.effectAllowed = "all";
  event.dataTransfer.setData(
    "application/x-kavot-collection",
    collectionDragPayload("task", Number(editorSession.activeDragPayload), "tasks"),
  );
  event.dataTransfer.setData("text/plain", (card as HTMLElement).dataset.taskId);
});



document.addEventListener("dragend", (event) => {
  if (editorSession.activeDragType === "paper") suppressPaperOpenUntil = Date.now() + 500;
  editorSession.activeDragType = null;
  editorSession.activeDragPayload = "";
  document.body.classList.remove("paper-drag-active");
  (event.target as HTMLElement).closest("[data-task-id]")?.classList.remove("dragging");
  (event.target as HTMLElement).closest("[data-note-drag]")?.classList.remove("dragging");
  (event.target as HTMLElement).closest("[data-folder-drag]")?.classList.remove("dragging");
  (event.target as HTMLElement).closest("[data-workspace-drag]")?.classList.remove("dragging");
  (event.target as HTMLElement).closest("[data-project-drag]")?.classList.remove("dragging");
  document.querySelectorAll(".workspace-file-row.multi-selected.dragging").forEach((row) => row.classList.remove("dragging"));
  (event.target as HTMLElement).closest("[data-collection-drag]")?.classList.remove("dragging");
  (event.target as HTMLElement).closest(".paper-row")?.classList.remove("dragging");
  (event.target as HTMLElement).closest("[data-workspace-pane]")?.classList.remove("pane-dragging");
  document
    .querySelectorAll("[data-pane-drop].pane-drop-target")
    .forEach((pane) => pane.classList.remove("pane-drop-target"));
  (event.target as HTMLElement).closest(".kanban-column")?.classList.remove("column-dragging");
  document
    .querySelectorAll(".kanban-column.drag-over")
    .forEach((column) => column.classList.remove("drag-over"));
  document
    .querySelectorAll(
      ".kanban-column.column-reorder-over, .kanban-column.column-reorder-after",
    )
    .forEach((column) =>
      column.classList.remove("column-reorder-over", "column-reorder-after"),
    );
  document
    .querySelectorAll(".note-folder-row.drag-over, .note-space-root.drag-over")
    .forEach((folder) => folder.classList.remove("drag-over"));
  document
    .querySelectorAll("[data-paper-folder-drop].drag-over")
    .forEach((folder) => folder.classList.remove("drag-over"));
  document
    .querySelectorAll("[data-paper-project-drop].drag-over")
    .forEach((project) => project.classList.remove("drag-over"));
  document
    .querySelectorAll("[data-workspace-drop].workspace-drag-over")
    .forEach((target) => target.classList.remove("workspace-drag-over"));
});



document.addEventListener("dragover", (event) => {
  const workspaceTarget = (event.target as HTMLElement).closest("[data-workspace-drop]");
  if (
    workspaceTarget &&
    (["workspace", "note", "folder"].includes(editorSession.activeDragType) ||
      transferHasExternalFiles(event.dataTransfer))
  ) {
    event.preventDefault();
    event.dataTransfer.dropEffect = ["workspace", "note", "folder"].includes(
      editorSession.activeDragType,
    ) ? "move" : "copy";
    document.querySelectorAll("[data-workspace-drop]").forEach((item) =>
      item.classList.toggle("workspace-drag-over", item === workspaceTarget),
    );
    return;
  }
  if (["paper", "paper-folder"].includes(editorSession.activeDragType)) {
    const folder = (event.target as HTMLElement).closest("[data-paper-folder-drop]");
    const project = (event.target as HTMLElement).closest("[data-paper-project-drop]");
    if (!folder && !project) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = project ? "copy" : "move";
    document.querySelectorAll("[data-paper-folder-drop]").forEach((item) =>
      item.classList.toggle("drag-over", item === folder),
    );
    document.querySelectorAll("[data-paper-project-drop]").forEach((item) =>
      item.classList.toggle("drag-over", item === project),
    );
    return;
  }
  if (editorSession.activeDragType === "pane") {
    const targetPane = (event.target as HTMLElement).closest<HTMLElement>("[data-pane-drop], [data-workspace-pane]");
    const draggedPane = editorSession.activeDragPayload.slice(5);
    if (!targetPane || (targetPane.dataset.paneDrop || targetPane.dataset.workspacePane) === draggedPane) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    document
      .querySelectorAll("[data-pane-drop]")
      .forEach((item) =>
        item.classList.toggle("pane-drop-target", item === targetPane),
      );
    return;
  }
  if (editorSession.activeDragType === "column") {
    const targetColumn = (event.target as HTMLElement).closest("[data-column-id]");
    if (!targetColumn) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const targetBox = targetColumn.getBoundingClientRect();
    const insertAfter = event.clientX > targetBox.left + targetBox.width / 2;
    document.querySelectorAll(".kanban-column").forEach((item) => {
      item.classList.toggle("column-reorder-over", item === targetColumn);
      item.classList.toggle(
        "column-reorder-after",
        item === targetColumn && insertAfter,
      );
    });
    return;
  }
  const folder = (event.target as HTMLElement).closest("[data-folder-drop]");
  if (folder) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    document
      .querySelectorAll(
        ".note-folder-row.drag-over, .note-space-root.drag-over",
      )
      .forEach((item) => item.classList.toggle("drag-over", item === folder));
    return;
  }
  const column = (event.target as HTMLElement).closest("[data-drop-column]");
  if (!column) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  document
    .querySelectorAll(".kanban-column")
    .forEach((item) => item.classList.toggle("drag-over", item === column));
});



// Handle pane moves before editor drop handlers can insert the drag payload as text.
document.addEventListener("drop", async (event) => {
  const transfer = event.dataTransfer?.getData("text/plain") || editorSession.activeDragPayload;
  if (transfer.startsWith("pane:")) {
    const targetPane = (event.target as HTMLElement).closest<HTMLElement>("[data-pane-drop], [data-workspace-pane]");
    const movedPane = transfer.slice(5);
    if (!targetPane || (targetPane.dataset.paneDrop || targetPane.dataset.workspacePane) === movedPane) return;
    event.preventDefault();
    event.stopPropagation();
    editorSession.activeDragType = null;
    document
      .querySelectorAll("[data-pane-drop].pane-drop-target")
      .forEach((pane) => pane.classList.remove("pane-drop-target"));
    editorSession.activeDragPayload = "";
    await mergeWorkspacePanes(movedPane, targetPane.dataset.paneDrop || targetPane.dataset.workspacePane);
    toast("Tabs merged into a single editor");
    return;
  }
}, true);

document.addEventListener("drop", async (event) => {
  const workspaceTarget = (event.target as HTMLElement).closest("[data-workspace-drop]");
  if (workspaceTarget && transferHasExternalFiles(event.dataTransfer)) {
    event.preventDefault();
    await uploadExternalWorkspaceFiles([...event.dataTransfer.files], workspaceTarget);
    return;
  }
  const transfer =
    event.dataTransfer.getData("application/x-kavot-workspace") ||
    event.dataTransfer.getData("application/x-kavot-paper") ||
    event.dataTransfer.getData("text/plain") ||
    editorSession.activeDragPayload;
  if (workspaceTarget && transfer === "selection:tree") {
    event.preventDefault();
    editorSession.activeDragType = null;
    await moveTreeSelection(workspaceTarget);
    return;
  }
  if (workspaceTarget && transfer.startsWith("workspace:")) {
    event.preventDefault();
    editorSession.activeDragType = null;
    await moveWorkspaceItem(transfer.slice(10), workspaceTarget);
    return;
  }
  if (transfer.startsWith('paper-folder:')) {
    event.preventDefault();
    editorSession.activeDragType = null;
    editorSession.activeDragPayload = '';
    await completeLibraryFolderDrop(Number(transfer.slice(13)), (event.target as HTMLElement).closest<HTMLElement>('[data-paper-folder-drop]'), (event.target as HTMLElement).closest<HTMLElement>('[data-paper-project-drop]'));
    return;
  }
  if (transfer.startsWith("paper:")) {
    const folder = (event.target as HTMLElement).closest("[data-paper-folder-drop]");
    const project = (event.target as HTMLElement).closest("[data-paper-project-drop]");
    if (!folder && !project) return;
    event.preventDefault();
    const paperId = Number(transfer.slice(6));
    await completePaperDrop(paperId, folder, project);
    return;
  }
  const folder = (event.target as HTMLElement).closest("[data-folder-drop]");
  if (transfer.startsWith("column:")) {
    const targetColumn = (event.target as HTMLElement).closest("[data-column-id]");
    if (!targetColumn) return;
    event.preventDefault();
    editorSession.activeDragType = null;
    const movedColumnId = Number(transfer.slice(7));
    const targetColumnId = Number((targetColumn as HTMLElement).dataset.columnId);
    document
      .querySelectorAll(
        ".kanban-column.column-reorder-over, .kanban-column.column-reorder-after",
      )
      .forEach((item) =>
        item.classList.remove("column-reorder-over", "column-reorder-after"),
      );
    if (!movedColumnId || movedColumnId === targetColumnId) return;
    const orderedIds = state.taskColumns
      .map((column) => column.id)
      .filter((id) => id !== movedColumnId);
    const targetIndex = orderedIds.indexOf(targetColumnId);
    const targetBox = targetColumn.getBoundingClientRect();
    const insertAfter = event.clientX > targetBox.left + targetBox.width / 2;
    orderedIds.splice(targetIndex + (insertAfter ? 1 : 0), 0, movedColumnId);
    try {
      await api("/task-columns/reorder", {
        method: "PUT",
        body: JSON.stringify({ ordered_ids: orderedIds }),
      });
      await refreshState(["taskColumns"]);
      await renderTaskContext();
      toast("Column order saved");
    } catch (error) {
      toast(error.message, "error");
    }
    return;
  }
  if (folder && transfer.startsWith("folder:")) {
    event.preventDefault();
    folder.classList.remove("drag-over");
    const movedFolderId = Number(transfer.slice(7));
    const movedFolder = state.noteFolders.find(
      (item) => item.id === movedFolderId,
    );
    const targetParentId =
      (folder as HTMLElement).dataset.folderDrop === "root"
        ? null
        : Number((folder as HTMLElement).dataset.folderDrop);
    const targetProjectId = Number((folder as HTMLElement).dataset.folderProject || 0) || null;
    const projectId =
      Number((folder.closest(".notes-layout") as HTMLElement)?.dataset.notesProject || 0) ||
      null;
    if (!movedFolder || movedFolder.project_id !== targetProjectId)
      return toast(
        "Move a folder within the same workspace or project",
        "error",
      );
    if (targetParentId === movedFolderId) return;
    try {
      await api(`/note-folders/${movedFolderId}`, {
        method: "PATCH",
        body: JSON.stringify({ parent_id: targetParentId }),
      });
      state.noteScope = targetProjectId
        ? `project:${targetProjectId}`
        : "general";
      state.noteFolderId = movedFolderId;
      await refreshState(["notes", "noteFolders", "workspaceTree"]);
      await rerenderNotesContext(projectId);
      toast("Folder and its entire tree moved");
    } catch (error) {
      toast(error.message, "error");
    }
    return;
  }
  if (folder && transfer.startsWith("note:")) {
    event.preventDefault();
    folder.classList.remove("drag-over");
    const noteId = Number(transfer.slice(5));
    const folderValue = (folder as HTMLElement).dataset.folderDrop;
    const folderId = folderValue === "root" ? null : Number(folderValue);
    const targetProjectId = Number((folder as HTMLElement).dataset.folderProject || 0) || null;
    const targetScope =
      (folder as HTMLElement).dataset.folderScope || (targetProjectId ? "project" : "general");
    if (targetScope === "readings")
      return toast(
        "Reading notes remain linked to their article",
        "error",
      );
    const projectId =
      Number((folder.closest(".notes-layout") as HTMLElement)?.dataset.notesProject || 0) ||
      null;
    const note = state.notes.find((item) => item.id === noteId);
    if (note?.paper_id && !targetProjectId)
      return toast(
        "The original note stays in the article folder; only move its shortcut into a project",
        "error",
      );
    try {
      if (note?.paper_id)
        await api(`/note-placements/${noteId}`, {
          method: "PUT",
          body: JSON.stringify({
            project_id: targetProjectId,
            folder_id: folderId,
          }),
        });
      else
        await api(`/notes/${noteId}`, {
          method: "PATCH",
          body: JSON.stringify({
            folder_id: folderId,
            project_id: targetProjectId,
          }),
        });
      state.noteScope = targetProjectId
        ? `project:${targetProjectId}`
        : "general";
      state.noteFolderId = folderId || "all";
      state.currentNoteId = noteId;
      await refreshState(["notes", "notePlacements", "workspaceTree", "projects"]);
      await rerenderNotesContext(projectId);
      toast(
        note?.paper_id
          ? "Shortcut moved; article note unchanged"
          : `Note moved to ${activeNoteLocationLabel(projectId)}`,
      );
    } catch (error) {
      toast(error.message, "error");
    }
    return;
  }
  const column = (event.target as HTMLElement).closest("[data-drop-column]");
  if (!column) return;
  event.preventDefault();
  const taskId = Number(event.dataTransfer.getData("text/plain"));
  const task = state.tasks.find((item) => item.id === taskId);
  column.classList.remove("drag-over");
  if (!task || task.column_id === Number((column as HTMLElement).dataset.dropColumn)) return;
  try {
    await api(`/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify({ column_id: Number((column as HTMLElement).dataset.dropColumn) }),
    });
    await refreshState(["tasks", "taskColumns", "projects"]);
    await renderTaskContext();
    toast(
      `Task moved to “${state.taskColumns.find((item) => item.id === Number((column as HTMLElement).dataset.dropColumn))?.name || "the column"}”`,
    );
  } catch (error) {
    toast(error.message, "error");
  }
});



// Delete moves the tree selection to trash while the explorer has focus.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Delete" || event.ctrlKey || event.altKey || event.metaKey) return;
  const target = event.target as HTMLElement;
  if (!target.closest?.(".notes-sidebar") || target.closest("input, textarea, [contenteditable='true']")) return;
  if (!selectedTreePaths().length) return;
  event.preventDefault();
  void trashTreeSelection();
});


document.querySelector("#modal-close")?.addEventListener("click", closeModal);


modalBackdrop?.addEventListener("click", (event) => {
  if (event.target === modalBackdrop) closeModal();
});


let workspaceTabSwitch = Promise.resolve();
document.addEventListener("keydown", (event) => {
  if (event.key !== "Tab" || !event.ctrlKey || event.altKey || event.metaKey ||
      (modalBackdrop && !modalBackdrop.classList.contains("hidden"))) return;
  const focusedPane = (event.target as HTMLElement).closest<HTMLElement>("[data-workspace-pane]")?.dataset.workspacePane;
  const pane = focusedPane || state.activeNotePane || "primary";
  if (!document.querySelector(`[data-workspace-pane="${pane}"]`)) return;
  event.preventDefault();
  event.stopPropagation();
  const direction = event.shiftKey ? -1 : 1;
  // Serialize switches so rapid key presses advance from the last activated tab.
  workspaceTabSwitch = workspaceTabSwitch.then(async () => {
    const tabs = state.workspaceTabs[pane];
    if (tabs.length < 2 || !document.querySelector(`[data-workspace-pane="${pane}"]`)) return;
    const index = tabs.findIndex(tab => tab.id === state.workspaceActiveTabs[pane]);
    const next = tabs[(index + direction + tabs.length) % tabs.length];
    await activateWorkspaceTab(pane, next.id);
    document.querySelector<HTMLElement>(`:is([data-tabs-pane="${pane}"], [data-workspace-pane="${pane}"]) .workspace-tab.active [data-workspace-tab]`)?.focus();
  }).catch(error => toast(error.message, "error"));
}, true);

document.addEventListener("keydown", (event) => {
  const focusedTask = (event.target as HTMLElement).matches?.(".task-card[data-task-id]")
    ? event.target
    : null;
  if (focusedTask && ["Enter", " "].includes(event.key)) {
    event.preventDefault();
    newTaskModal(null, null, Number((focusedTask as HTMLElement).dataset.taskId));
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    if (document.querySelector("#note-content")) {
      event.preventDefault();
      saveCurrentNote();
    } else if (document.querySelector("#secondary-note-content")) {
      event.preventDefault();
      flushSecondaryNoteAutosave();
    } else if (document.querySelector("#reader-note-content")) {
      event.preventDefault();
      flushReaderAutosave();
    } else if (document.querySelector("#save-project-note")) {
      event.preventDefault();
      (document.querySelector("#save-project-note") as HTMLElement).click();
    }
  }
  if (event.key === "Escape" && !event.defaultPrevented) closeModal();
});
}
