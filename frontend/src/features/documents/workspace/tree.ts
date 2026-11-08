import { workspaceColor } from '../../../styles/palette';
import { escapeHtml, formatDate, state } from '../../../app/state';
import { api } from '../../../services/api';
import { refreshData, refreshState, toast } from '../../../app/navigation';
import { noteContextLabel, isDrawingNote, notesForContext, foldersForContext, filterNotesByFolder, activeNoteProjectId } from './notesContext';
import { interfaceIcon } from './icons';
import { renderNotes, rerenderWorkspaceTree, refreshWorkspaceTreeOnly, updateWorkspaceResourcePath } from './render';

function workspaceNodeIcon(kind) {
  return interfaceIcon(
    kind === "directory" ? "folder" : kind === "drawing" ? "canvas" : kind,
    `workspace-icon ${kind}`,
  );
}

function workspaceCreateButtons(node) {
  if (!node.creation_context) return "";
  const projectId = node.creation_context.project_id || "";
  const folderId = node.creation_context.folder_id || "";
  const generalContext = node.creation_context.project_id
    ? ""
    : `data-general-context="true"`;
  const contextAttributes = `data-project-id="${projectId}" data-folder-id="${folderId}" ${generalContext}`;
  const folderAttributes = `data-project-id="${projectId}" data-parent-folder-id="${folderId || "root"}" ${generalContext}`;
  const label = escapeHtml(node.label || node.name);
  // Free canvases belong to General; projects keep their single project canvas.
  const canvasButton = node.creation_context.project_id
    ? ""
    : `<button data-action="new-canvas" ${contextAttributes} title="New canvas" aria-label="Create canvas in ${label}">${interfaceIcon("canvas")}</button>`;
  // The type buttons feed the "+" menu, the explorer toolbar and the context menu.
  return `<span class="workspace-create-actions"><button data-action="new-note" ${contextAttributes} title="New note" aria-label="Create note in ${label}">${interfaceIcon("note")}</button><button data-action="new-drawing" ${contextAttributes} title="New Draw diagram" aria-label="Create Draw diagram in ${label}">${interfaceIcon("draw")}</button>${canvasButton}<button data-action="new-folder" ${folderAttributes} title="New folder" aria-label="Create subfolder in ${label}">${interfaceIcon("folder")}</button><button class="tree-row-tool" data-tree-create-menu title="New in ${label}" aria-label="New item in ${label}" aria-haspopup="menu">${interfaceIcon("plus")}</button></span>`;
}

function workspaceDropAttributes(node) {
  if (!node?.creation_context || !["notes", "projects"].includes(node.path?.split("/")[0]))
    return "";
  const projectId = node.creation_context.project_id || "";
  const folderId = node.creation_context.folder_id || "";
  return `data-workspace-drop="true" data-drop-project-id="${projectId}" data-drop-folder-id="${folderId}" data-folder-drop="${folderId || "root"}" data-folder-project="${projectId}"`;
}

const treeRowMenu = (label) =>
  `<button class="tree-row-tool" data-workspace-row-menu title="More actions" aria-label="More actions for ${label}" aria-haspopup="menu">${interfaceIcon("more")}</button>`;

const treeChevron = (hasChildren) => (hasChildren ? interfaceIcon("chevron", "tree-chevron") : "");

/** Children of an open folder; dropping anywhere on them files the item into that folder.
 * A project lists its own tasks and library first. */
function workspaceTreeChildren(node, children, depth, allowCanvas = true) {
  return `<div class="workspace-tree-children" ${workspaceDropAttributes(node)} style="--file-depth:${depth}">${node.project_id ? projectLinks(Number(node.project_id), depth + 1) : ""}${workspaceFileTree(children, depth + 1, allowCanvas)}</div>`;
}

/** The pages of a project, filtered on it: its tasks and its articles. */
function projectLinks(projectId, depth) {
  const tasks = (state.tasks || []).filter((task) => task.project_id === projectId && task.status !== "done" && !task.archived_at).length;
  const papers = (state.papers || []).filter((paper) =>
    (paper.projects || []).some((link) => link.id === projectId)).length;
  const row = (area, icon, label, count) =>
    `<div class="workspace-file-row file workspace-project-link" style="--file-depth:${depth}"><span class="workspace-file-spacer"></span><button class="workspace-file-label" data-project-area="${area}" data-project-id="${projectId}" title="${label} of this project"><span class="file-kind">${interfaceIcon(icon)}</span><strong>${label}</strong><small>${count}</small></button></div>`;
  return row("tasks", "tasks", "Tasks", tasks) + row("papers", "papers", "Library", papers);
}

function visibleNoteTreeNodes(nodes) {
  return nodes || [];
}

function workspaceFileTree(nodes, depth = 0, allowCanvas = true) {
  return (nodes || [])
    .map((node) => {
      const selectedPrimary =
        state.primaryResource?.path === node.path ||
        (node.note_id && state.currentNoteId === node.note_id);
      const selectedSecondary =
        state.secondaryResource?.path === node.path ||
        (node.note_id &&
          state.secondaryResource?.type === "note" &&
          state.secondaryResource.noteId === node.note_id);
      if (node.kind === "directory") {
        const expanded = state.expandedWorkspacePaths.has(node.path);
        const children = visibleNoteTreeNodes(node.children);
        const createButton = workspaceCreateButtons(node);
        const noteFolderId =
          Number(node.creation_context?.folder_id || 0) || null;
        const folderColor = node.color || node.creation_context?.color || "#b17a22";
        const folderLabel =
          noteFolderId && state.editingNoteFolderId === noteFolderId
            ? `<label class="workspace-folder-inline-edit" style="--folder-color:${escapeHtml(workspaceColor(folderColor))}"><span class="file-kind directory">${workspaceNodeIcon(node.kind)}</span><input data-inline-folder-name="${noteFolderId}" value="${escapeHtml(node.label || node.name)}" maxlength="120" aria-label="Folder name"></label>`
            : `<button class="workspace-file-label" data-workspace-toggle="${escapeHtml(node.path)}" title="${escapeHtml(node.label || node.name)}" aria-expanded="${expanded}"><span class="file-kind directory">${node.project_id ? interfaceIcon("project", "workspace-icon directory") : workspaceNodeIcon(node.paper_id ? "pdf" : node.kind)}</span><strong>${escapeHtml(node.label || node.name)}</strong><small>${node.paper_count ?? children.length}</small></button>`;
        const readArticle = node.paper_id && node.has_pdf
          ? `<button class="tree-row-tool" data-action="open-paper-workspace" data-paper-id="${node.paper_id}" title="Read article with notes" aria-label="Read ${escapeHtml(node.label || node.name)} with notes">${interfaceIcon("panels")}</button>`
          : "";
        const paperFolderActions = node.paper_folder_id
          ? `<span class="workspace-item-actions paper-storage-actions"><button data-action="new-paper-folder" data-parent-paper-folder-id="${node.paper_folder_id}" title="Create subfolder">＋</button><button data-action="edit-paper-folder" data-paper-folder-id="${node.paper_folder_id}" title="Edit filing">•••</button></span>`
          : "";
        const projectLabel = escapeHtml(node.label || node.name);
        const actions = node.virtual_paper_folder
          ? paperFolderActions
          : node.project_id
            ? `<span class="workspace-item-actions"><button data-action="edit-project" data-project-id="${node.project_id}" title="Edit project" aria-label="Edit ${projectLabel}">✎</button><button data-action="archive-project" data-project-id="${node.project_id}" title="Archive project" aria-label="Archive ${projectLabel}">${interfaceIcon("archive")}</button><button class="danger" data-action="delete-project" data-project-id="${node.project_id}" title="Delete project" aria-label="Delete ${projectLabel}">⌫</button></span>`
          : node.trash_id
            ? `<span class="workspace-item-actions"><button data-restore-trash="${node.trash_id}" title="Restore" aria-label="Restore ${escapeHtml(node.label || node.name)}">↶</button><button class="danger" data-delete-trash="${node.trash_id}" title="Delete permanently" aria-label="Delete permanently ${escapeHtml(node.label || node.name)}">×</button></span>`
            : !node.root && !node.trashed && !node.protected
              ? `<span class="workspace-item-actions">${noteFolderId ? `<label class="workspace-folder-color" title="Change folder color"><input type="color" data-workspace-folder-color="${noteFolderId}" value="${escapeHtml(workspaceColor(folderColor))}" aria-label="Color of ${escapeHtml(node.label || node.name)}"><span style="--folder-color:${escapeHtml(workspaceColor(folderColor))}"></span></label><button data-inline-rename-folder="${noteFolderId}" title="Rename" aria-label="Rename ${escapeHtml(node.label || node.name)}">✎</button><button class="danger" data-delete-folder="${noteFolderId}" title="Move folder to trash" aria-label="Move ${escapeHtml(node.label || node.name)} to trash">⌫</button>` : `<button class="danger" data-trash-workspace="${escapeHtml(node.path)}" title="Move to trash" aria-label="Move ${escapeHtml(node.label || node.name)} to trash">⌫</button>`}</span>`
              : "";
        const visibleCreateButton = node.virtual_paper_folder || node.trash_id ? "" : createButton;
        const libraryDirectory = node.paper_id || node.paper_folder_id;
        const folderDragAttributes = libraryDirectory
          ? `draggable="true" data-workspace-drag="${escapeHtml(node.path)}" data-reference-drag="true"`
          : noteFolderId
          ? `draggable="true" data-folder-drag="${noteFolderId}"`
          : node.project_id
          ? `draggable="true" data-project-drag="${Number(node.project_id)}" title="Drag onto a canvas to import this project"`
          : "";
        return `<div class="workspace-tree-branch ${node.virtual_paper_folder ? "paper-storage-branch" : ""}"><div data-workspace-path="${escapeHtml(node.path)}" class="workspace-file-row directory ${node.virtual_paper_folder ? "paper-storage-folder" : ""} ${actions || visibleCreateButton ? "with-actions" : ""}" ${workspaceDropAttributes(node)} ${folderDragAttributes} style="--file-depth:${depth};--folder-color:${escapeHtml(workspaceColor(folderColor))}"><button class="tree-toggle ${children.length ? "" : "empty"}" data-workspace-toggle="${escapeHtml(node.path)}" aria-label="${expanded ? "Collapse" : "Expand"} ${escapeHtml(node.label || node.name)}" aria-expanded="${expanded}">${treeChevron(children.length)}</button>${folderLabel}${readArticle}${visibleCreateButton}${actions}${actions || visibleCreateButton ? treeRowMenu(escapeHtml(node.label || node.name)) : ""}</div>${expanded ? workspaceTreeChildren(node, children, depth, allowCanvas) : ""}</div>`;
      }
      const primaryAttributes = node.note_id
        ? `data-note="${node.note_id}"`
        : `data-open-workspace-resource="${escapeHtml(node.path)}"`;
      const secondaryAttributes = node.note_id
        ? `data-open-secondary-note="${node.note_id}"`
        : `data-open-secondary-resource="${escapeHtml(node.path)}"`;
      const note = node.note_id
        ? state.notes.find((item) => item.id === Number(node.note_id))
        : null;
      const editing = state.editingWorkspacePath === node.path;
      const displayName = note?.title || node.label || node.name || node.path?.split("/").pop();
      const fileIcon = note && isDrawingNote(note)
        ? interfaceIcon("draw", "workspace-icon drawing")
        : workspaceNodeIcon(node.kind);
      const fileLabel = editing
        ? `<label class="workspace-file-inline-edit"><span class="file-kind ${node.kind}">${fileIcon}</span><input data-inline-workspace-name="${escapeHtml(node.path)}" ${node.note_id ? `data-inline-workspace-note-id="${node.note_id}"` : ""} value="${escapeHtml(node.note_id ? displayName : node.name)}" maxlength="240" aria-label="File name"></label>`
        : `<button class="workspace-file-label" ${primaryAttributes} title="${escapeHtml(isDrawingNote(note) ? "Open Draw diagram" : node.path)}"><span class="file-kind ${node.kind}">${fileIcon}</span><strong>${escapeHtml(displayName)}</strong>${isDrawingNote(note) ? '<small class="workspace-drawing-label workspace-kind-label">Draw</small>' : node.kind === "canvas" ? '<small class="workspace-kind-label">Canvas</small>' : ""}</button>`;
      const actions = node.trash_id
        ? `<span class="workspace-item-actions"><button data-restore-trash="${node.trash_id}" title="Restore" aria-label="Restore ${escapeHtml(node.label || node.name)}">↶</button><button class="danger" data-delete-trash="${node.trash_id}" title="Delete permanently" aria-label="Delete permanently ${escapeHtml(node.label || node.name)}">×</button></span>`
        : !node.trashed && !node.protected
          ? `<span class="workspace-item-actions">${node.renamable || node.note_id ? `<button class="note-rename-button" data-inline-rename-workspace="${escapeHtml(node.path)}" title="Rename" aria-label="Rename ${escapeHtml(displayName)}">${interfaceIcon("edit")}</button>` : ""}<button class="danger" data-trash-workspace="${escapeHtml(node.path)}" title="Move to trash" aria-label="Move ${escapeHtml(displayName)} to trash">⌫</button></span>`
          : "";
      const libraryReference = node.path?.startsWith("library/");
      const canDrag = ["notes", "projects", "databases", "library"].includes(
        node.path?.split("/")[0],
      ) && !node.trashed && (!node.protected || libraryReference);
      // A project canvas cannot be moved, but dropping it on another canvas imports it like its project.
      const projectCanvas = node.kind === "canvas" && node.project_id && !node.trashed;
      const rowDragAttributes = projectCanvas
        ? `data-project-drag="${Number(node.project_id)}" draggable="true"`
        : canDrag
        ? `${libraryReference ? 'data-reference-drag="true" ' : ''}${node.note_id
          ? `data-note-drag="${Number(node.note_id)}"`
          : `data-workspace-drag="${escapeHtml(node.path)}"`}`
        : "";
      const dragGrip = canDrag || projectCanvas
        ? `<span class="workspace-file-spacer workspace-file-grip" title="Drag into a note or canvas" aria-hidden="true">⠿</span>`
        : `<span class="workspace-file-spacer"></span>`;
      return `<div data-workspace-path="${escapeHtml(node.path)}" class="workspace-file-row file ${selectedPrimary ? "primary-active" : ""} ${selectedSecondary ? "secondary-active" : ""} ${actions ? "with-actions" : ""}" ${rowDragAttributes} ${canDrag ? `draggable="true" aria-label="Drag ${escapeHtml(displayName)} into a folder or project canvas"` : ""} style="--file-depth:${depth}">${dragGrip}${fileLabel}<button class="workspace-open-side" ${secondaryAttributes} title="Open beside" aria-label="Open ${escapeHtml(displayName)} beside">${interfaceIcon("panels")}</button>${actions}${actions ? treeRowMenu(escapeHtml(displayName)) : ""}</div>`;
    })
    .join("");
}

export function findWorkspaceNode(path, nodes = state.workspaceTree) {
  for (const node of nodes || []) {
    if (node.path === path) return node;
    const child = findWorkspaceNode(path, node.children || []);
    if (child) return child;
  }
  return null;
}

export function findWorkspaceNodeByFolderId(folderId, nodes = state.workspaceTree) {
  for (const node of nodes || []) {
    if (
      Number(node.creation_context?.folder_id || 0) === Number(folderId || 0) &&
      node.creation_context?.folder_id != null
    )
      return node;
    const child = findWorkspaceNodeByFolderId(folderId, node.children || []);
    if (child) return child;
  }
  return null;
}

/** The explorer, like a vault: the folders and notes of the workspace at the top level, folders first.
 * Former projects show as folders among the others. The library has its own page and the trash its own tab. */
function workspaceExplorer() {
  const general = findWorkspaceNode("notes/general") || findWorkspaceNode("notes/daily");
  if (!general) return `<div class="workspace-project-empty">No notes yet.</div>`;
  const projects = findWorkspaceNode("notes/projects")?.children || [];
  const nodes = [...visibleNoteTreeNodes(general.children), ...projects];
  const label = (node) => String(node.label || node.name || "");
  const folders = nodes.filter((node) => node.kind === "directory").sort((a, b) => label(a).localeCompare(label(b), undefined, { sensitivity: "base" }));
  const files = nodes.filter((node) => node.kind !== "directory");
  // The head is hidden: it only carries the creation buttons of the top level for the toolbar and the context menu.
  return `<section class="workspace-root-section workspace-general-root workspace-vault-root" data-workspace-root="${escapeHtml(general.path)}" ${workspaceDropAttributes(general)}><div class="notes-contexts-head workspace-root-head workspace-vault-head" hidden>${workspaceCreateButtons(general)}</div><div class="workspace-file-tree" ${workspaceDropAttributes(general)}>${workspaceFileTree([...folders, ...files], 0, false)}</div></section>${workspaceLibrary()}`;
}

/** The Library under the notes, folded until opened: its folders, then each article with its PDF and notes.
 * Articles and their notes open from here, and drag onto a note or a canvas. */
function workspaceLibrary() {
  const library = findWorkspaceNode("notes/library");
  if (!library) return "";
  const expanded = state.expandedWorkspacePaths.has(library.path);
  const count = library.paper_count ?? (state.papers || []).length;
  return `<section class="workspace-root-section workspace-library-root" data-workspace-root="${escapeHtml(library.path)}"><div class="notes-contexts-head workspace-root-head"><button data-workspace-toggle="${escapeHtml(library.path)}" aria-label="${expanded ? "Collapse" : "Expand"} the Library" aria-expanded="${expanded}"><span>${treeChevron(true)}</span>${interfaceIcon("papers")}<strong>Library</strong><small>${count}</small></button></div>${expanded ? `<div class="workspace-file-tree">${library.children?.length ? workspaceFileTree(library.children) : `<p class="workspace-library-empty">No articles yet. Add them from the Library page.</p>`}</div>` : ""}</section>`;
}

function fileExplorerNavigation() {
  return `<div class="files-explorer-roots">${workspaceExplorer()}</div>`;
}

export function findWorkspaceNodeByNoteId(noteId, nodes = state.workspaceTree) {
  for (const node of nodes || []) {
    if (Number(node.note_id || 0) === Number(noteId || 0)) return node;
    const child = findWorkspaceNodeByNoteId(noteId, node.children || []);
    if (child) return child;
  }
  return null;
}

export function expandWorkspacePathParents(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  for (let index = 1; index < parts.length; index += 1)
    state.expandedWorkspacePaths.add(parts.slice(0, index).join("/"));
}

export function notesWorkspaceContexts() {
  return fileExplorerNavigation();
}

/** Explorer toolbar: every document type, created in the folder that has the tree focus. */
export function notesExplorerToolbar() {
  const button = (action, icon, label) =>
    `<button type="button" data-tree-create="${action}" title="${label}" aria-label="${label}">${interfaceIcon(icon)}</button>`;
  return `<div class="notes-explorer-toolbar" role="toolbar" aria-label="New documents">${button("new-note", "noteplus", "New note")}${button("new-folder", "folderplus", "New folder")}${button("new-canvas", "canvas", "New canvas")}${button("new-drawing", "draw", "New Draw diagram")}<span class="notes-explorer-toolbar-spacer"></span><button type="button" data-tree-search title="Find a note or a file (Ctrl+F)" aria-label="Find a note or a file">${interfaceIcon("search")}</button><button type="button" data-tree-collapse-all title="Collapse all" aria-label="Collapse all folders">${interfaceIcon("collapse")}</button><button type="button" data-nav="trash" title="Trash" aria-label="Trash">${interfaceIcon("trash")}</button></div>`;
}

// Last row or section head clicked in the tree. New documents go into that
// folder, or into the folder of the clicked file, like a desktop explorer.
let treeFocusPath: string | null = null;

const treeRowByPath = (tree: Element, path: string) =>
  [...tree.querySelectorAll<HTMLElement>(".workspace-file-row[data-workspace-path]")].find(
    (row) => row.dataset.workspacePath === path,
  );

const creationButtons = (element: Element | null | undefined) =>
  element?.querySelector('[data-action="new-note"]') ? (element as HTMLElement) : null;

/** Creation buttons of the folder that receives new documents. */
function treeCreateTarget(): HTMLElement | null {
  const tree = document.querySelector<HTMLElement>("#notes-tree");
  if (!tree) return null;
  const section = treeFocusPath
    ? [...tree.querySelectorAll<HTMLElement>("[data-workspace-root]")].find((item) => item.dataset.workspaceRoot === treeFocusPath)
    : null;
  const start = section
    ? null
    : (treeFocusPath && treeRowByPath(tree, treeFocusPath)) || tree.querySelector<HTMLElement>(".workspace-file-row.primary-active");
  for (let row = start; row; ) {
    const own = creationButtons(row.querySelector(":scope > .workspace-create-actions"));
    if (own) return own;
    const parent = row.parentElement?.closest(".workspace-tree-children");
    row = parent?.parentElement?.querySelector<HTMLElement>(":scope > .workspace-file-row") || null;
  }
  const head = (root: Element | null | undefined) =>
    creationButtons(root?.querySelector(":scope > .workspace-root-head > .workspace-create-actions"));
  return (
    head(section || start?.closest("[data-workspace-root]")) ||
    [...tree.querySelectorAll("[data-workspace-root]")].map(head).find(Boolean) ||
    null
  );
}

export function decorateTreeFocus() {
  const tree = document.querySelector("#notes-tree");
  if (!tree) return;
  tree.querySelectorAll(".tree-focused").forEach((row) => row.classList.remove("tree-focused"));
  if (treeFocusPath) treeRowByPath(tree, treeFocusPath)?.classList.add("tree-focused");
  // Projects keep their single project canvas, so the toolbar cannot add one there.
  const canvas = document.querySelector<HTMLButtonElement>('[data-tree-create="new-canvas"]');
  if (canvas) {
    const allowed = Boolean(treeCreateTarget()?.querySelector('[data-action="new-canvas"]'));
    canvas.disabled = !allowed;
    canvas.title = allowed ? "New canvas" : "Canvases live in General; projects use their project canvas";
  }
}

let themedPreviewsBound = false;

/** HTML previews are separate documents: they get the app's theme so their own colors follow it. */
export function bindThemedDocumentPreviews() {
  if (themedPreviewsBound) return;
  themedPreviewsBound = true;
  const syncOne = (frame: HTMLIFrameElement) => {
    try {
      const doc = frame.contentDocument;
      if (doc?.documentElement)
        doc.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    } catch (_) { /* cross-origin or not loaded yet */ }
  };
  const syncAll = () => document.querySelectorAll<HTMLIFrameElement>(".secondary-document-view").forEach(syncOne);
  // Capture phase: load does not bubble, and a frame rerendered after the change still gets the theme.
  document.addEventListener("load", (event) => {
    if ((event.target as Element)?.matches?.(".secondary-document-view")) syncOne(event.target as HTMLIFrameElement);
  }, true);
  window.addEventListener("kavot:colors-changed", syncAll);
  syncAll();
}

let explorerBound = false;

export function bindNotesExplorerOnce() {
  if (explorerBound) return;
  explorerBound = true;
  // Capture phase: the focus is known before a click rerenders the tree.
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (!target?.closest) return;
    if (target.closest("#notes-tree")) {
      const row = target.closest<HTMLElement>(".workspace-file-row[data-workspace-path]");
      const head = target.closest(".workspace-root-head") && target.closest<HTMLElement>("[data-workspace-root]");
      treeFocusPath = row?.dataset.workspacePath || head?.dataset.workspaceRoot || null;
      decorateTreeFocus();
      return;
    }
    const create = target.closest<HTMLElement>("[data-tree-create]");
    if (create) {
      treeCreateTarget()?.querySelector<HTMLElement>(`[data-action="${create.dataset.treeCreate}"]`)?.click();
      return;
    }
    if (target.closest("[data-tree-search]")) {
      window.dispatchEvent(new Event("kavot:open-search"));
      return;
    }
    if (target.closest("[data-tree-collapse-all]")) {
      const roots = new Set(
        [...document.querySelectorAll<HTMLElement>("#notes-tree [data-workspace-root]")].map((item) => item.dataset.workspaceRoot),
      );
      [...state.expandedWorkspacePaths].forEach((path) => {
        if (path !== "notes" && !roots.has(path)) state.expandedWorkspacePaths.delete(path);
      });
      rerenderWorkspaceTree();
    }
  }, true);
}

async function persistWorkspaceTreeName(input) {
  const path = input.dataset.inlineWorkspaceName;
  const noteId = Number(input.dataset.inlineWorkspaceNoteId || 0);
  const node = findWorkspaceNode(path);
  const note = noteId
    ? state.notes.find((item) => item.id === noteId)
    : null;
  const original = note?.title || node?.name || "";
  const name = input.value.trim();
  state.editingWorkspacePath = null;
  if (!name || name === original) {
    await refreshWorkspaceTreeOnly();
    return;
  }
  try {
    if (note) {
      const updated = await api(`/notes/${note.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: name }),
      });
      Object.assign(note, updated);
    } else {
      const renamed = await api("/workspace/item", {
        method: "PATCH",
        body: JSON.stringify({ path, name }),
      });
      updateWorkspaceResourcePath(path, renamed);
    }
    await (note ? refreshState(["notes", "workspaceTree"]) : refreshData());
    renderNotes();
    toast("File renamed");
  } catch (error) {
    state.editingWorkspacePath = path;
    await refreshWorkspaceTreeOnly();
    toast(error.message, "error");
  }
}

export function bindWorkspaceTreeEditors(root) {
  root?.querySelectorAll("[data-inline-folder-name]").forEach((input) => {
    if (input.dataset.inlineBound === "true") return;
    input.dataset.inlineBound = "true";
    const folderId = Number(input.dataset.inlineFolderName);
    const original =
      state.noteFolders.find((item) => item.id === folderId)?.name || input.value;
    let committed = false;
    const finish = async (save = true) => {
      if (committed) return;
      committed = true;
      const name = input.value.trim();
      state.editingNoteFolderId = null;
      if (!save || !name || name === original)
        return rerenderWorkspaceTree();
      try {
        await api(`/note-folders/${folderId}`, {
          method: "PATCH",
          body: JSON.stringify({ name }),
        });
        await refreshState(["notes", "noteFolders", "workspaceTree"]);
        renderNotes();
        toast("Folder renamed");
      } catch (error) {
        state.editingNoteFolderId = folderId;
        await refreshWorkspaceTreeOnly();
        toast(error.message, "error");
      }
    };
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  });
  root?.querySelectorAll("[data-inline-workspace-name]").forEach((input) => {
    if (input.dataset.inlineBound === "true") return;
    input.dataset.inlineBound = "true";
    let committed = false;
    const finish = async (save = true) => {
      if (committed) return;
      committed = true;
      if (save) await persistWorkspaceTreeName(input);
      else {
        state.editingWorkspacePath = null;
        rerenderWorkspaceTree();
      }
    };
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  });
}

/** Filter the notes explorer from the titlebar search field. */
export function applyNoteSearch(value: string) {
  const tree = document.querySelector("#notes-tree");
  const results = document.querySelector("#note-items");
  if (!tree || !results) return;
  const query = value.trim().toLowerCase();
  if (!query) {
    tree.classList.remove("hidden");
    results.classList.add("hidden");
    results.innerHTML = "";
    return;
  }
  const projectId = activeNoteProjectId();
  const visibleNotes = filterNotesByFolder(
    notesForContext(projectId),
    foldersForContext(projectId),
    projectId,
  );
  const matches = visibleNotes.filter((note) =>
    `${note.title} ${note.content} ${noteContextLabel(note)}`
      .toLowerCase()
      .includes(query),
  );
  tree.classList.add("hidden");
  results.classList.remove("hidden");
  results.innerHTML = noteItems(matches);
}

let noteSearchBound = false;

export function bindNoteSearchOnce() {
  if (noteSearchBound) return;
  noteSearchBound = true;
  const update = (event: Event) => {
    const input = event.target as HTMLInputElement;
    if (input?.id === "note-filter") applyNoteSearch(input.value);
  };
  document.addEventListener("input", update);
  document.addEventListener("search", update, true);
}

function noteItems(notes) {
  const kindLabel = (note) =>
    isDrawingNote(note) ? "Draw diagram" : note.paper_id ? "Linked article" : note.project_id ? "Project" : "General";
  const contextProjectId = activeNoteProjectId();
  return (
    notes
      .map(
        (note) =>
          `<div class="note-item-row ${note.id === state.currentNoteId ? "active" : ""}" data-note-drag="${note.id}" draggable="true"><button class="note-item" data-note="${note.id}"><span class="note-kind">${kindLabel(note)}${note.folder_name ? ` · ${escapeHtml(note.folder_name)}` : ""}</span><strong>${escapeHtml(note.title)}</strong><small>${escapeHtml(noteContextLabel(note))}</small><time>${formatDate(note.updated_at)}</time></button><button class="workspace-open-side" data-open-secondary-note="${note.id}" title="Open beside" aria-label="Open ${escapeHtml(note.title)} beside">${interfaceIcon("panels")}</button><button class="note-rename-button" data-rename-note="${note.id}" title="Rename note" aria-label="Rename ${escapeHtml(note.title)}">${interfaceIcon("edit")}</button><button class="tree-note-menu" data-action="edit-note" data-note-id="${note.id}" ${contextProjectId ? `data-note-project="${contextProjectId}"` : ""} aria-label="Rename, move, or delete ${escapeHtml(note.title)}">•••</button></div>`,
      )
      .join("") || `<div class="notes-list-empty">No notes here.</div>`
  );
}
