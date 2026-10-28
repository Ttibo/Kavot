import { escapeHtml, state } from '../../app/state';
import { api } from '../../services/api';
import { navigate, refreshData, refreshState, toast } from '../../app/navigation';
import { contextualFolderId, expandWorkspacePathParents, findWorkspaceNode, findWorkspaceNodeByFolderId, findWorkspaceNodeByNoteId, folderOptions, renderNotes, replaceActiveWorkspaceTab, rerenderNotesContext, workspaceNoteTab, workspaceResourcePayload, workspaceResourceTab } from './workspace';
import { drawingPreviewPng, emptyDrawing } from './drawing';
import { closeModal, openModal } from '../../components/dialogs/controller';
import { newPaperModal } from '../library/documents';
import { openProjectArea } from '../projects/navigation';

export async function createNewNote(
  projectId = null,
  paperId = null,
  folderId = null,
) {
  const paper = state.papers.find((item) => item.id === Number(paperId));
  const folder = state.noteFolders.find(item => item.id === Number(folderId));
  const daily = !paper && folder?.system_kind === "daily";
  const date = new Date();
  const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const existingDaily = daily ? state.notes.find(note => note.folder_id === folder.id && note.title === today && !note.trashed_at) : null;
  const defaultTitle = daily ? today : paper ? `Notes — ${paper.title}` : "Note";
  try {
    const note = existingDaily || await api<Note>("/notes", {
      method: "POST",
      body: JSON.stringify({
        project_id: paper ? null : Number(projectId) || null,
        paper_id: paper ? paper.id : null,
        folder_id: paper ? null : Number(folderId) || null,
        title: defaultTitle,
        template_id: !paper ? folder?.default_template_id || null : null,
        content: folder?.default_template_id ? "" : `# ${defaultTitle}\n\n`,
      }),
    });
    await refreshState(note.paper_id ? ["notes", "workspaceTree", "projects", "papers"] : ["notes", "workspaceTree", "projects"]);
    state.currentNoteId = note.id;
    state.primaryResource = null;
    const targetScope = note.paper_id
      ? `paper:${note.paper_id}`
      : note.project_id
        ? `project:${note.project_id}`
        : "general";
    const targetFolder = note.folder_id || "root";
    if (state.view !== "notes") await navigate("notes");
    state.noteScope = targetScope;
    state.noteFolderId = targetFolder;
    const treeNode = findWorkspaceNodeByNoteId(note.id);
    if (treeNode) {
      if (!daily) state.editingWorkspacePath = treeNode.path;
      expandWorkspacePathParents(treeNode.path);
    }
    replaceActiveWorkspaceTab("primary", workspaceNoteTab(note));
    renderNotes();
    toast(daily ? "Daily note opened" : "Note created — enter its name in the tree");
  } catch (error) {
    toast(error.message, "error");
  }
}

export async function createNewDrawing(
  projectId = null,
  folderId = null,
) {
  const effectiveProjectId = Number(projectId) || null;
  const effectiveFolderId = Number(folderId) || null;
  const siblings = state.notes.filter(
    (note) => note.project_id === effectiveProjectId && (note.folder_id || null) === effectiveFolderId,
  );
  let title = "New drawing";
  let suffix = 2;
  while (siblings.some(note => note.title.toLocaleLowerCase() === title.toLocaleLowerCase())) {
    title = `New drawing ${suffix}`;
    suffix += 1;
  }
  const drawing = emptyDrawing();
  try {
    const created = await api<Note>("/notes", {
      method: "POST",
      body: JSON.stringify({
        project_id: effectiveProjectId,
        folder_id: effectiveFolderId,
        title,
        content: "",
        drawing,
        drawing_preview: drawingPreviewPng(drawing),
      }),
    });
    await refreshState(["notes", "workspaceTree", "projects"]);
    const note = state.notes.find(item => Number(item.id) === Number(created.id)) || created;
    state.currentNoteId = note.id;
    state.primaryResource = null;
    state.noteScope = note.project_id ? `project:${note.project_id}` : "general";
    state.noteFolderId = note.folder_id || "root";
    if (state.view !== "notes") await navigate("notes");
    const treeNode = findWorkspaceNodeByNoteId(note.id);
    if (treeNode) expandWorkspacePathParents(treeNode.path);
    replaceActiveWorkspaceTab("primary", workspaceNoteTab(note));
    renderNotes();
  } catch (error) {
    toast(error.message, "error");
  }
}

/** Free canvases only exist in General; projects keep their single project canvas. */
export async function createNewCanvas(folderId = null) {
  try {
    const created = await api<{ path: string }>("/workspace/canvas", {
      method: "POST",
      body: JSON.stringify({ title: "New canvas", project_id: null, folder_id: Number(folderId) || null }),
    });
    await refreshState(["workspaceTree"]);
    const node = findWorkspaceNode(created.path);
    if (!node) throw new Error("The created canvas was not found in Documents");
    state.currentNoteId = null;
    state.noteScope = "general";
    state.noteFolderId = Number(folderId) || "root";
    state.primaryResource = await workspaceResourcePayload(node);
    if (state.view !== "notes") await navigate("notes");
    expandWorkspacePathParents(node.path);
    replaceActiveWorkspaceTab("primary", workspaceResourceTab(state.primaryResource));
    renderNotes();
  } catch (error) {
    toast(error.message, "error");
  }
}

function currentFolderProjectId(explicitProjectId = null) {
  if (explicitProjectId) return Number(explicitProjectId);
  if (state.noteScope.startsWith("project:"))
    return Number(state.noteScope.split(":")[1]);
  return null;
}

export async function createNoteFolder(projectId = null, parentFolderId = null) {
  const effectiveProjectId = currentFolderProjectId(projectId);
  const parentId =
    parentFolderId === "root" ? null : Number(parentFolderId || 0) || null;
  let name = "New folder";
  let suffix = 2;
  const siblings = state.noteFolders.filter(
    (folder) =>
      folder.project_id === effectiveProjectId &&
      (folder.parent_id || null) === parentId,
  );
  while (
    siblings.some(
      (folder) =>
        folder.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    )
  ) {
    name = `New folder ${suffix}`;
    suffix += 1;
  }
  try {
    const saved = await api("/note-folders", {
      method: "POST",
      body: JSON.stringify({
        name,
        project_id: effectiveProjectId,
        parent_id: parentId,
      }),
    });
    await refreshState(["noteFolders", "workspaceTree"]);
    state.noteScope = effectiveProjectId
      ? `project:${effectiveProjectId}`
      : "general";
    state.noteFolderId = saved.id;
    state.editingNoteFolderId = saved.id;
    const parentNode = parentId ? findWorkspaceNodeByFolderId(parentId) : null;
    if (parentNode) state.expandedWorkspacePaths.add(parentNode.path);
    renderNotes();
    toast("Folder created — enter its name");
  } catch (error) {
    toast(error.message, "error");
  }
}

export function noteSettingsModal(
  noteId,
  projectContextId = null,
  workspaceProjectId = null,
) {
  const note = state.notes.find((item) => item.id === Number(noteId));
  if (!note) return;
  if (note.system_kind === "project_home") {
    openModal(`<header class="modal-header"><h2>Project note</h2><p>Edit its title and content directly in the editor. This note stays at the root of the project and cannot be deleted.</p></header><div class="modal-body"><div class="form-actions"><button type="button" class="button button-primary" data-close-modal>Close</button></div></div>`);
    return;
  }
  const effectiveProjectId =
    Number(projectContextId || note.project_id || 0) || null;
  const folders = state.noteFolders.filter(
    (folder) => folder.project_id === effectiveProjectId,
  );
  const selectedFolderId = contextualFolderId(note, effectiveProjectId);
  const rootLabel = effectiveProjectId
    ? state.projects.find((item) => item.id === effectiveProjectId)?.name ||
      "Project"
    : "General notes";
  const canChooseFolder = !note.paper_id || effectiveProjectId;
  const folderField = canChooseFolder
    ? `<div class="form-field full"><label>${note.paper_id ? "Shortcut folder" : "Dossier"}</label><select name="folder_id"><option value="" ${!selectedFolderId ? "selected" : ""}>Root of ${escapeHtml(rootLabel)}</option>${folderOptions(folders, selectedFolderId)}</select></div>`
    : "";
  openModal(
    `<header class="modal-header"><h2>Organize or delete note</h2><p>Rename the file directly from the document tree.</p></header><div class="modal-body"><form id="note-settings-form" class="form-grid">${folderField}<div class="form-actions"><button type="button" class="button button-danger" data-delete-note="${note.id}" data-workspace-project="${workspaceProjectId || ""}">Delete note</button><button type="button" class="button" data-close-modal>Cancel</button>${canChooseFolder ? `<button class="button button-primary">Save location</button>` : ""}</div></form></div>`,
  );
  document
    .querySelector("#note-settings-form")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData((event.target as HTMLFormElement)));
      const folderId = values.folder_id ? Number(values.folder_id) : null;
      try {
        await api(`/notes/${note.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            ...(!note.paper_id ? { folder_id: folderId } : {}),
          }),
        });
        if (note.paper_id && effectiveProjectId) {
          await api(`/note-placements/${note.id}`, {
            method: "PUT",
            body: JSON.stringify({
              project_id: effectiveProjectId,
              folder_id: folderId,
            }),
          });
        }
        closeModal();
        await refreshState(["notes", "notePlacements", "workspaceTree"]);
        state.currentNoteId = note.id;
        rerenderNotesContext(workspaceProjectId);
        toast("Note properties updated");
      } catch (error) {
        toast(error.message, "error");
      }
    });
}

export function addProjectPaperModal(projectId) {
  const project = state.projects.find((item) => item.id === Number(projectId));
  if (!project) return;
  const available = state.papers.filter(
    (paper) => !paper.projects.some((item) => item.id === Number(projectId)),
  );
  openModal(
    `<header class="modal-header"><h2>Add articles to project</h2><p>Create a reference or reuse articles already in the general library.</p></header><div class="modal-body"><button class="import-paper-choice" id="import-new-project-paper"><span>＋</span><div><strong>Create a new article</strong><small>Add its metadata and attach a PDF now or later</small></div></button><div class="section-heading"><div><h2>Existing library</h2><p>${available.length} article(s) available</p></div></div>${available.length ? `<form id="existing-papers-form"><div class="existing-paper-list">${available.map((paper) => `<label class="existing-paper-option"><input type="checkbox" name="paper_ids" value="${paper.id}"><span class="list-icon">▤</span><span><strong>${escapeHtml(paper.title)}</strong><small>${escapeHtml((paper.authors || []).join(", ") || paper.publication || "Reference")}</small></span>${paper.file_path ? `<i>PDF</i>` : `<i class="warning">No PDF</i>`}</label>`).join("")}</div><div class="form-actions" style="margin-top:18px"><button type="button" class="button" data-close-modal>Cancel</button><button class="button button-primary">Add selection</button></div></form>` : `<div class="empty-state" style="min-height:170px"><p>All library articles are already linked to this project.</p></div>`}</div>`,
    true,
  );
  document
    .querySelector("#import-new-project-paper")
    .addEventListener("click", () => newPaperModal(projectId));
  document
    .querySelector("#existing-papers-form")
    ?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const ids = new FormData((event.target as HTMLFormElement)).getAll("paper_ids").map(Number);
      if (!ids.length)
        return toast("Select at least one article", "error");
      try {
        await Promise.all(
          ids.map((id) =>
            api(`/papers/${id}/projects/${projectId}`, { method: "POST" }),
          ),
        );
        closeModal();
        await refreshData();
        await openProjectArea(projectId, "papers");
        toast(`${ids.length} article(s) added to project`);
      } catch (error) {
        toast(error.message, "error");
      }
    });
}
