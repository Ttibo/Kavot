import { collectionRecordMarkup, bindCollectionEditors, flushCollectionSaves } from '../collections/noteEditor';
import { workspaceColor } from '../../styles/palette';
import { canvasTemplateIcon } from './canvasModel';
import { escapeHtml, flushReaderAutosave, formatDate, main, noteAssetBase, noteTitleTimers, rememberWorkspaceSession, renderMarkdown, state, workspaceMarkdownTimers } from '../../app/state';
import { collectionDatabaseDefinitions, collectionDragPayload, collectionItems, findCollectionItem } from '../collections/catalog';
import { bindMarkdownBlockEditor, currentMarkdownBlockInput, markdownBlockEditorMarkup, markdownBlockSourceOffset, setMarkdownBlockEditorContent } from './markdown';
import { bindCanvasEditors, canvasEditorMarkup, flushCanvasSaves } from './canvas';
import { openDrawingEditor } from './drawing';
import { decorateTreeSelection } from './treeSelection';
import { bindWorkspacePdfExtractors, pdfCaptureWorkspaceMarkup } from '../library/documents';
import { api } from '../../services/api';
import { refreshData, refreshState, toast } from '../../app/navigation';
import { prepareEditor } from '../../app/viewBridge';
import { editorSession } from '../../app/editorSession';

export function noteContextLabel(note) {
  if (isDrawingNote(note)) return "Draw diagram";
  if (note.paper_title) return `Reading · ${note.paper_title}`;
  if (note.project_name) return note.project_name;
  return "General note";
}

export function isDrawingNote(note) {
  return Boolean(note?.drawing);
}

function noteMatchesScope(note, scope = state.noteScope) {
  if (scope === "general") return !note.project_id && !note.paper_id;
  if (scope === "readings") return Boolean(note.paper_id);
  if (scope.startsWith("paper:"))
    return note.paper_id === Number(scope.split(":")[1]);
  if (scope.startsWith("project:"))
    return note.project_id === Number(scope.split(":")[1]);
  return true;
}

function notesForContext(projectId = null) {
  if (!projectId) {
    if (state.noteScope.startsWith("project:"))
      return notesForContext(Number(state.noteScope.split(":")[1]));
    return state.notes.filter((note) => noteMatchesScope(note));
  }
  return state.notes.filter(
    (note) => note.project_id === Number(projectId) && !note.paper_id,
  );
}

function foldersForContext(projectId = null) {
  if (!projectId && state.noteScope.startsWith("paper:")) return [];
  const effectiveProject =
    projectId ||
    (state.noteScope.startsWith("project:")
      ? Number(state.noteScope.split(":")[1])
      : null);
  if (
    !projectId &&
    state.noteScope !== "general" &&
    !state.noteScope.startsWith("project:")
  )
    return [];
  return state.noteFolders.filter(
    (folder) => folder.project_id === effectiveProject,
  );
}

function folderDescendants(folderId, folders) {
  const ids = new Set([Number(folderId)]);
  let changed = true;
  while (changed) {
    changed = false;
    folders.forEach((folder) => {
      if (
        folder.parent_id &&
        ids.has(folder.parent_id) &&
        !ids.has(folder.id)
      ) {
        ids.add(folder.id);
        changed = true;
      }
    });
  }
  return ids;
}

export function contextualFolderId(note, projectId = null) {
  if (!note.paper_id) return note.folder_id || null;
  if (!projectId) return null;
  return (
    state.notePlacements.find(
      (item) =>
        item.note_id === note.id && item.project_id === Number(projectId),
    )?.folder_id || null
  );
}

function filterNotesByFolder(notes, folders, projectId = null) {
  if (state.noteFolderId === "all") return notes;
  if (state.noteFolderId === "readings")
    return notes.filter((note) => note.paper_id);
  if (state.noteFolderId === "root")
    return notes.filter((note) => !contextualFolderId(note, projectId));
  const ids = folderDescendants(Number(state.noteFolderId), folders);
  return notes.filter((note) => ids.has(contextualFolderId(note, projectId)));
}

export function folderOptions(
  folders,
  selected = null,
  parentId = null,
  depth = 0,
  excluded = new Set(),
) {
  return folders
    .filter(
      (folder) => folder.parent_id === parentId && !excluded.has(folder.id),
    )
    .map(
      (folder) =>
        `<option value="${folder.id}" ${Number(selected) === folder.id ? "selected" : ""}>${"— ".repeat(depth)}${escapeHtml(folder.name)}</option>${folderOptions(folders, selected, folder.id, depth + 1, excluded)}`,
    )
    .join("");
}

export function interfaceIcon(name, className = "") {
  const paths = {
    calendar: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v5m8-5v5M4 11h16m-11 4h2m3 0h2"/>',
    archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8m-9 4h4"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m7 12 3 3 7-7"/>',
    trash: '<path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    edit: '<path d="m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14Z"/>',
    link: '<path d="m10 14 4-4m-6 6-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 1 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/>',
    folder:
      '<path d="M3.5 7.5h6l1.8 2H20a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 20 19.5H4A1.5 1.5 0 0 1 2.5 18V9A1.5 1.5 0 0 1 4 7.5Z"/><path d="M3.5 7.5V6A1.5 1.5 0 0 1 5 4.5h4l2 2h5"/>',
    markdown:
      '<path d="M6 2.75h8l4 4V21.25H6Z"/><path d="M14 2.75v4h4M8.5 16v-5l2 2 2-2v5m2-2 1.5 2 1.5-2"/>',
    pdf: '<path d="M6 2.75h8l4 4V21.25H6Z"/><path d="M14 2.75v4h4M8 16v-4h1.25a1.25 1.25 0 0 1 0 2.5H8m4 1.5v-4h1a2 2 0 0 1 0 4Zm4 0v-4h2"/>',
    canvas: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="9" r="2"/><circle cx="16" cy="15" r="2"/><path d="m10 10.5 4 3"/>',
    graph: '<circle cx="6" cy="6" r="2.25"/><circle cx="18" cy="8" r="2.25"/><circle cx="9" cy="18" r="2.25"/><path d="m8.1 6.6 7.7 1M7 8.1l1.4 7.7m2.3.9 5.6-7"/>',
    image:
      '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m5 18 4.5-4.5 3 3 2-2 4.5 3.5"/>',
    json: '<path d="M8.5 3.5c-2 0-2 1.5-2 3.5v2c0 1.5-1 2-2 2 1 0 2 .5 2 2v2c0 2 0 3.5 2 3.5m7-15c2 0 2 1.5 2 3.5v2c0 1.5 1 2 2 2-1 0-2 .5-2 2v2c0 2 0 3.5-2 3.5"/>',
    file: '<path d="M6 2.75h8l4 4V21.25H6Z"/><path d="M14 2.75v4h4M9 12h6m-6 3h6m-6 3h4"/>',
    panels:
      '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
    grip: '<circle cx="8" cy="7" r="1"/><circle cx="16" cy="7" r="1"/><circle cx="8" cy="12" r="1"/><circle cx="16" cy="12" r="1"/><circle cx="8" cy="17" r="1"/><circle cx="16" cy="17" r="1"/>',
    note: '<path d="M6 3.5h9l3 3v14H6Z"/><path d="M15 3.5v3h3M9 11h6m-6 3h6m-6 3h4"/>',
    project:
      '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M8 5V3.5h8V5M8 10h8m-8 4h5"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
    template: '<path d="M5 3.5h14v17H5Z"/><path d="M8.5 8h7m-7 4h7m-7 4h4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    sparkle: '<path d="M12 2.5c.7 4.7 2.8 6.8 7.5 7.5-4.7.7-6.8 2.8-7.5 7.5-.7-4.7-2.8-6.8-7.5-7.5 4.7-.7 6.8-2.8 7.5-7.5Z"/><path d="M19 16.5c.25 1.7 1.05 2.5 2.5 2.75-1.45.25-2.25 1.05-2.5 2.75-.25-1.7-1.05-2.5-2.5-2.75 1.45-.25 2.25-1.05 2.5-2.75Z"/>',
    bulb: '<path d="M9 18h6m-5 3h4"/><path d="M8.5 15.5C7 14.4 6 12.5 6 10.5a6 6 0 1 1 12 0c0 2-1 3.9-2.5 5-.7.5-1 1.1-1 2h-5c0-.9-.3-1.5-1-2Z"/>',
    task: '<rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="m8 9 1.5 1.5L12 8m2 1h3m-9 6 1.5 1.5L12 14m2 1h3"/>',
    database: '<ellipse cx="12" cy="5.5" rx="7.5" ry="3"/><path d="M4.5 5.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6m-15 6v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6"/>',
    conference: '<path d="M4 20v-2.5A3.5 3.5 0 0 1 7.5 14h3a3.5 3.5 0 0 1 3.5 3.5V20"/><circle cx="9" cy="7.5" r="3.5"/><path d="M16 8h5m-2.5-2.5V11M16 15h5"/>',
    text: '<path d="M5 5h14M12 5v14m-4 0h8"/>',
    zone: '<rect x="3.5" y="4" width="17" height="16" rx="2" stroke-dasharray="3 3"/>',
    rectangle: '<rect x="3.5" y="5" width="17" height="14" rx="2"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>',
    diamond: '<path d="m12 3 9 9-9 9-9-9Z"/>',
    upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 14v6h16v-6"/>',
    zoomout: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M7.5 10.5h6m2 5 5 5"/>',
    zoomin: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M7.5 10.5h6m-3-3v6m5 2 5 5"/>',
    fit: '<path d="M9 4H4v5m11-5h5v5M9 20H4v-5m11 5h5v-5"/>',
    question: '<circle cx="12" cy="12" r="9"/><path d="M9.7 9a2.45 2.45 0 0 1 4.7 1c0 1.8-2.4 2-2.4 3.6M12 17.3h.01"/>',
    flask: '<path d="M9 3h6m-5 0v5l-5.5 9.2A2.5 2.5 0 0 0 6.7 21h10.6a2.5 2.5 0 0 0 2.2-3.8L14 8V3M7.5 16h9"/>',
    chart: '<path d="M5 20V10m5 10V4m5 16v-7m5 7V7"/>',
    draw: '<path d="m14.5 4.5 3 3L9.5 15.5l-3.5.5.5-3.5Z"/><path d="M4 20.5c2-1.2 3.5-2.5 5.5-2.5s2.5 1.5 4.5 1.5 3.5-1.5 6-2"/>',
    noteplus: '<path d="M13 3.5H6v17h12V8.5Z"/><path d="M13 3.5v5h5M12 11.5v6m-3-3h6"/>',
    folderplus: '<path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5Z"/><path d="M12 10v6m-3-3h6"/>',
    chevron: '<path d="m9.5 6 6 6-6 6"/>',
    more: '<circle cx="5.5" cy="12" r="1.1"/><circle cx="12" cy="12" r="1.1"/><circle cx="18.5" cy="12" r="1.1"/>',
    collapse: '<path d="m7 20 5-5 5 5M7 4l5 5 5-5"/>',
  };
  return `<svg class="ui-icon ${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.file}</svg>`;
}

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

/** Children of an open folder; dropping anywhere on them files the item into that folder. */
function workspaceTreeChildren(node, children, depth, allowCanvas = true) {
  return `<div class="workspace-tree-children" ${workspaceDropAttributes(node)} style="--file-depth:${depth}">${workspaceFileTree(children, depth + 1, allowCanvas)}</div>`;
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
            : `<button class="workspace-file-label" data-workspace-toggle="${escapeHtml(node.path)}" title="${escapeHtml(node.label || node.name)}" aria-expanded="${expanded}"><span class="file-kind directory">${workspaceNodeIcon(node.paper_id ? "pdf" : node.kind)}</span><strong>${escapeHtml(node.label || node.name)}</strong><small>${node.paper_count ?? children.length}</small></button>`;
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

function workspaceProjects() {
  const root = findWorkspaceNode("notes/projects");
  if (!root) return "";
  const expanded = state.expandedWorkspacePaths.has(root.path);
  const children = root.children || [];
  return `<section class="workspace-root-section workspace-projects-root separated" data-workspace-root="${escapeHtml(root.path)}"><div class="notes-contexts-head workspace-root-head"><button data-workspace-toggle="${escapeHtml(root.path)}" aria-label="${expanded ? "Collapse" : "Expand"} Projects" aria-expanded="${expanded}"><span>${treeChevron(true)}</span><strong>Projects</strong><small>${children.length}</small></button><span class="workspace-create-actions"><button class="tree-row-tool" data-action="new-project" title="New project" aria-label="New project">${interfaceIcon("plus")}</button></span></div>${expanded ? `<div class="workspace-file-tree">${workspaceFileTree(children)}</div>` : ""}</section>`;
}

const COLLECTION_TREE_LIMIT = 200;
const COLLECTION_ICONS = { articles: "pdf", tasks: "task", conferences: "conference", datasets: "database" };

/** Every collection with its records; records open in a workspace tab. */
function workspaceCollections() {
  const databases = collectionDatabaseDefinitions();
  if (!databases.length) return "";
  const root = "collections";
  const expanded = state.expandedWorkspacePaths.has(root);
  const open = state.primaryResource?.type === "collection-record" ? state.primaryResource.content : null;
  const rows = databases
    .map((database) => {
      const path = `${root}/${database.id}`;
      const items = collectionItems(database.id);
      // Articles follow the library: folders, then each article with its PDF and notes.
      const library = database.id === "articles" ? findWorkspaceNode("notes/library") : null;
      const folderOpen = state.expandedWorkspacePaths.has(path);
      const label = escapeHtml(database.name || database.id);
      const icon = COLLECTION_ICONS[database.id] || "database";
      const records = folderOpen && library
        ? workspaceFileTree(library.children, 1)
        : folderOpen
        ? items
            .slice(0, COLLECTION_TREE_LIMIT)
            .map((item) => {
              const payload = escapeHtml(collectionDragPayload(item.type, item.id, item.databaseId));
              const active = open && String(open.id) === String(item.id) && open.databaseId === item.databaseId;
              return `<div data-workspace-path="${escapeHtml(`${path}/${item.id}`)}" class="workspace-file-row file collection-tree-record ${active ? "primary-active" : ""}" draggable="true" data-collection-drag="${payload}" style="--file-depth:1"><span class="workspace-file-spacer"></span><button class="workspace-file-label" data-collection-open="${payload}" title="${escapeHtml(item.title)}"><span class="file-kind">${interfaceIcon(item.type === "task" ? "task" : item.type === "paper" ? "pdf" : "file")}</span><strong>${escapeHtml(item.title)}</strong></button></div>`;
            })
            .join("") +
          (items.length > COLLECTION_TREE_LIMIT
            ? `<div class="workspace-file-row file collection-tree-more" style="--file-depth:1"><span class="workspace-file-spacer"></span><button class="workspace-file-label" data-collection-nav="${escapeHtml(database.id)}"><span class="file-kind"></span><strong>Show all ${items.length} in ${label}</strong></button></div>`
            : "")
        : "";
      return `<div class="workspace-tree-branch"><div data-workspace-path="${escapeHtml(path)}" class="workspace-file-row directory with-actions" style="--file-depth:0"><button class="tree-toggle" data-workspace-toggle="${escapeHtml(path)}" aria-label="${folderOpen ? "Collapse" : "Expand"} ${label}" aria-expanded="${folderOpen}">${treeChevron(items.length)}</button><button class="workspace-file-label" data-workspace-toggle="${escapeHtml(path)}" title="${label}" aria-expanded="${folderOpen}"><span class="file-kind collection">${interfaceIcon(icon)}</span><strong>${label}</strong><small class="workspace-kind-label">${items.length}</small></button><span class="workspace-create-actions"><button class="tree-row-tool" data-collection-nav="${escapeHtml(database.id)}" title="Open collection page" aria-label="Open the ${label} page">${interfaceIcon("panels")}</button></span></div>${folderOpen && items.length ? `<div class="workspace-tree-children" style="--file-depth:0">${records}</div>` : ""}</div>`;
    })
    .join("");
  return `<section class="workspace-root-section workspace-collections-root separated" data-workspace-root="${root}"><div class="notes-contexts-head workspace-root-head"><button data-workspace-toggle="${root}" aria-label="${expanded ? "Collapse" : "Expand"} Collections" aria-expanded="${expanded}"><span>${treeChevron(true)}</span><strong>Collections</strong></button></div>${expanded ? `<div class="workspace-file-tree">${rows}</div>` : ""}</section>`;
}

function workspaceExplorer(projectId = null) {
  if (projectId) {
    const findProjectRoot = (nodes) => {
      for (const node of nodes || []) {
        if (
          Number(node.creation_context?.project_id || node.project_id || 0) === Number(projectId) &&
          ["directory", "project"].includes(node.kind)
        ) return node;
        const child = findProjectRoot(node.children || []);
        if (child) return child;
      }
      return null;
    };
    const root = findProjectRoot(state.workspaceTree);
    if (!root) return `<div class="workspace-project-empty">No project files yet.</div>`;
    const children = [...(root.children || [])];
    const canvasPath = state.projects.find(project => project.id === Number(projectId))?.canvas_path;
    const canvasNode = canvasPath ? findWorkspaceNode(canvasPath) : null;
    if (canvasNode && !children.some(node => node.path === canvasPath)) children.unshift(canvasNode);
    return `<section class="workspace-root-section workspace-project-root" data-workspace-root="${escapeHtml(root.path)}" ${workspaceDropAttributes(root)}><div class="notes-contexts-head workspace-root-head" ${workspaceDropAttributes(root)}><div class="workspace-project-title"><span class="project-file-dot" style="--folder-color:${escapeHtml(workspaceColor(root.color || "#087e86"))}"></span><strong>${escapeHtml(root.label || root.name)}</strong><small>${children.length}</small></div>${workspaceCreateButtons(root)}</div><div class="workspace-file-tree">${workspaceFileTree(children)}</div></section>`;
  }
  const findGeneralRoot = (nodes) => {
    for (const node of nodes || []) {
      if (node.path === "notes/general" || node.path === "notes/daily") return node;
      const child = findGeneralRoot(node.children || []);
      if (child) return child;
    }
    return null;
  };
  const general = findGeneralRoot(state.workspaceTree);
  if (general) {
    const expanded = state.expandedWorkspacePaths.has(general.path);
    const children = visibleNoteTreeNodes(general.children);
    return `<section class="workspace-root-section workspace-general-root" data-workspace-root="${escapeHtml(general.path)}" ${workspaceDropAttributes(general)}><div class="notes-contexts-head workspace-root-head" ${workspaceDropAttributes(general)}><button data-workspace-toggle="${escapeHtml(general.path)}" aria-label="${expanded ? "Collapse" : "Expand"} General" aria-expanded="${expanded}"><span>${treeChevron(children.length)}</span><strong>General</strong><small>${children.length}</small></button>${workspaceCreateButtons(general)}</div>${expanded ? `<div class="workspace-file-tree">${workspaceFileTree(children, 0, false)}</div>` : ""}</section>${workspaceProjects()}${workspaceCollections()}`;
  }
  const renderRoots = (roots) => visibleNoteTreeNodes(roots)
    .map((root, index) => {
      const expanded = state.expandedWorkspacePaths.has(root.path);
      const children = root.children || [];
      return `<section class="workspace-root-section ${index ? "separated" : ""}" data-workspace-root="${escapeHtml(root.path)}" ${workspaceDropAttributes(root)}><div class="notes-contexts-head workspace-root-head" ${workspaceDropAttributes(root)}><button data-workspace-toggle="${escapeHtml(root.path)}" aria-label="${expanded ? "Collapse" : "Expand"} ${escapeHtml(root.label || root.name)}" aria-expanded="${expanded}"><span>${treeChevron(children.length)}</span><strong>${escapeHtml(root.label || root.name)}</strong><small>${children.length}</small></button>${workspaceCreateButtons(root)}</div>${expanded ? `<div class="workspace-file-tree">${workspaceFileTree(children)}</div>` : ""}</section>`;
    })
    .join("");
  const documents = renderRoots(
    (state.workspaceTree || []).filter((root) => root.path !== "trash"),
  );
  const trash = renderRoots(
    (state.workspaceTree || []).filter((root) => root.path === "trash"),
  );
  return `${documents}${trash}`;
}

function fileExplorerNavigation(projectId = null) {
  return `<div class="files-explorer-roots">${workspaceExplorer(projectId)}</div>`;
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

function notesWorkspaceContexts() {
  return fileExplorerNavigation();
}

/** Explorer toolbar: every document type, created in the folder that has the tree focus. */
function notesExplorerToolbar() {
  const button = (action, icon, label) =>
    `<button type="button" data-tree-create="${action}" title="${label}" aria-label="${label}">${interfaceIcon(icon)}</button>`;
  return `<div class="notes-explorer-toolbar" role="toolbar" aria-label="New documents">${button("new-note", "noteplus", "New note")}${button("new-drawing", "draw", "New Draw diagram")}${button("new-canvas", "canvas", "New canvas")}${button("new-folder", "folderplus", "New folder")}<span class="notes-explorer-toolbar-spacer"></span><button type="button" data-tree-collapse-all title="Collapse all" aria-label="Collapse all folders">${interfaceIcon("collapse")}</button></div>`;
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
export function treeCreateTarget(): HTMLElement | null {
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

function decorateTreeFocus() {
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

let explorerBound = false;
function bindNotesExplorerOnce() {
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

export function activeNoteProjectId(projectId = null) {
  if (projectId) return Number(projectId);
  if (state.noteScope.startsWith("project:"))
    return Number(state.noteScope.split(":")[1]);
  return null;
}

export function activeNoteFolderId(projectId = null) {
  if (["all", "root"].includes(String(state.noteFolderId))) return null;
  const folderId = Number(state.noteFolderId);
  const effectiveProjectId = activeNoteProjectId(projectId);
  const folder = state.noteFolders.find((item) => item.id === folderId);
  return folder && folder.project_id === effectiveProjectId ? folderId : null;
}

export function activeNoteLocationLabel(projectId = null) {
  if (!projectId && state.noteScope.startsWith("paper:")) {
    const paperId = Number(state.noteScope.split(":")[1]);
    return (
      state.papers.find((item) => item.id === paperId)?.title || "Article note"
    );
  }
  const effectiveProjectId = activeNoteProjectId(projectId);
  const project = state.projects.find((item) => item.id === effectiveProjectId);
  if (state.noteFolderId === "readings")
    return `${project?.name || "Project"} / Reading notes`;
  const folder = state.noteFolders.find(
    (item) => item.id === activeNoteFolderId(projectId),
  );
  const root = project?.name || "General notes";
  return folder ? `${root} / ${folder.name}` : root;
}

export function markdownFormattingToolbarMarkup(
  _actionAttribute = "data-md-action",
  before = "",
  after = "",
) {
  return before || after ? `<div class="note-document-actions">${before}${after}</div>` : '';
}

function notePaneChrome(note, pane = "primary") {
  const workspace = Boolean(note.workspacePath);
  const secondary = pane === "secondary";
  // Keep save and document-status hooks for the editor integration without
  // repeating them visibly in the condensed toolbar.
  const hiddenStatus = workspace
    ? `<span class="note-autosave-state workspace-markdown-save-state" hidden>Saved</span>`
    : `<span class="note-autosave-state" id="${secondary ? "secondary-note-save-state" : "note-autosave-state"}" hidden>Saved automatically</span>`;
  return `${hiddenStatus}<span class="markdown-document-stats" aria-live="polite" hidden></span>`;
}

function noteTemplatePicker() {
  const templates = state.noteTemplates
    .filter(template => !template.archived)
    .map(
      (template) =>
        `<article class="note-template-option"><div><strong>${interfaceIcon(canvasTemplateIcon(template))} ${escapeHtml(template.name)}</strong><small>${escapeHtml(template.title_template)}</small></div><span><button type="button" data-apply-note-template="${template.id}" data-template-mode="replace" title="Replace title and content">Apply</button><button type="button" data-apply-note-template="${template.id}" data-template-mode="insert" title="Insert at cursor">Insert</button></span></article>`,
    )
    .join("");
  return `<div class="note-template-picker hidden" role="dialog" aria-label="Apply template"><header><div><strong>Note types</strong><small>Replace the note or insert a template at the cursor.</small></div><button type="button" data-close-note-template aria-label="Close">×</button></header><div class="note-template-options">${templates || `<p>No note type available.</p>`}</div></div>`;
}

function primaryNoteEditor(note, projectId = null) {
  if (!note)
    return `<div class="note-empty" data-pane-drop="primary"><span>✎</span><h3>No note in this folder</h3><p>The new note will be created in the selected location.</p><button class="button button-primary" data-action="new-note" ${projectId ? `data-project-id="${projectId}"` : ""}>＋ New note here</button></div>`;
  const assetBase = noteAssetBase(note);
  const blocks = markdownBlockEditorMarkup(note.content, {
    sourceId: "note-content",
    sourceClass: "note-content",
    editorId: "note-block-editor",
    assetBase,
    ariaLabel: `Markdown source — ${note.title}`,
  });
  return `<div class="note-editor note-pane" data-primary-note-id="${note.id}" data-pane-drop="primary">${notePaneChrome(note, "primary")}${noteTemplatePicker()}<div class="note-link-picker hidden" id="note-link-picker" role="dialog" aria-label="Link a note"><div class="note-link-picker-head"><span>Link a note</span><button type="button" id="note-link-close" aria-label="Close">×</button></div><input id="note-link-search" type="search" autocomplete="off" placeholder="Search notes…" aria-label="Search notes"><div class="note-link-results" id="note-link-results"></div></div><div class="markdown-block-shell">${blocks}</div></div>`;
}

/** Drawing notes open their editor directly in the tab; the host is filled once it is in the page. */
function drawingNotePane(note, pane = "primary") {
  watchDrawingHosts();
  return `<section class="drawing-note-pane drawing-inline-host note-pane" data-${pane}-note-id="${note.id}" data-pane-drop="${pane}" data-drawing-host="${note.id}" aria-label="${escapeHtml(note.title)}"></section>`;
}

let drawingHostWatcher: MutationObserver | null = null;
function mountDrawingHosts() {
  document.querySelectorAll<HTMLElement>("[data-drawing-host]:not([data-drawing-mounted])").forEach(host => {
    const note = state.notes.find(item => Number(item.id) === Number(host.dataset.drawingHost));
    if (!note) return;
    host.dataset.drawingMounted = "true";
    openNoteDrawing(note, host);
  });
}
function watchDrawingHosts() {
  queueMicrotask(mountDrawingHosts);
  if (drawingHostWatcher) return;
  drawingHostWatcher = new MutationObserver(() => {
    if (document.querySelector("[data-drawing-host]:not([data-drawing-mounted])")) mountDrawingHosts();
  });
  drawingHostWatcher.observe(document.body, { childList: true, subtree: true });
}

export function openNoteDrawing(note: Note, host?: HTMLElement) {
  if (!isDrawingNote(note)) return;
  let draft: { title: string; drawing: Record<string, any>; drawing_preview: string } | null = null;
  try {
    openDrawingEditor(note.title || "Drawing", note.drawing as any, (title, drawing, drawing_preview) => {
      draft = { title, drawing, drawing_preview };
      Object.assign(note, draft);
      const current = state.notes.find(item => Number(item.id) === Number(note.id));
      if (current && current !== note) Object.assign(current, draft);
    }, async () => {
      if (!draft) return;
      const saved = await api<Note>(`/notes/${note.id}`, { method: "PATCH", body: JSON.stringify(draft) });
      Object.assign(note, saved);
      const current = state.notes.find(item => Number(item.id) === Number(note.id));
      if (current && current !== note) Object.assign(current, saved);
      await refreshWorkspaceTreeOnly();
    }, host);
  } catch (error) { toast(error.message, "error"); }
}

function relationalNoteMarkup(content: string, path: string) {
  const rendered = renderMarkdown(content).replace(/&amp;((?:#\d+|lt|gt|amp);)/g, '&$1');
  const document = new DOMParser().parseFromString(rendered, 'text/html');
  document.querySelectorAll('table').forEach(table => {
    if (table.closest('.markdown-table-wrap')) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'markdown-table-wrap';
    table.replaceWith(wrapper); wrapper.append(table);
  });
  document.querySelectorAll<HTMLElement>('.markdown-table-wrap').forEach((wrapper, index) => {
    wrapper.classList.add('review-data-table');
    const controls = document.createElement('div');
    controls.className = 'review-table-tools';
    controls.innerHTML = `<input type="search" data-review-search aria-label="Search table ${index + 1}" placeholder="Search this table…"><span>${wrapper.querySelectorAll('tbody tr').length} lignes</span>`;
    wrapper.prepend(controls);
    wrapper.querySelectorAll('th').forEach((header, column) => {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.reviewSort = String(column);
      button.textContent = header.textContent;
      header.textContent = ''; header.append(button); header.setAttribute('aria-sort', 'none');
    });
  });
  document.querySelectorAll('a').forEach(link => {
    const href = link.getAttribute('href') || '';
    if (href.startsWith('#resource/')) {
      link.setAttribute('data-action', 'open-project-resource');
      link.setAttribute('data-resource-target', decodeURIComponent(href.slice(10)));
      link.removeAttribute('target');
      return;
    }
    if (href.startsWith('#collection/')) {
      link.setAttribute('data-collection-nav', decodeURIComponent(href.slice(12)));
      link.removeAttribute('target');
      return;
    }
    if (!href.startsWith('./') && !href.startsWith('../')) return;
    const target = decodeURIComponent(new URL(href, `https://workspace.local/${path}`).pathname.slice(1));
    const node = findWorkspaceNode(target);
    if (!node) return;
    link.removeAttribute('target');
    link.setAttribute('href', '#');
    link.setAttribute(node.kind === 'directory' ? 'data-review-folder' : node.note_id ? 'data-note' : 'data-open-workspace-resource', String(node.note_id || target));
  });
  // Keep the generated content and link behavior intact while grouping each topic.
  let section: HTMLElement | null = null;
  for (const child of [...document.body.children]) {
    if (child.tagName === 'H2') {
      section = document.createElement('section');
      section.className = 'review-section';
      document.body.insertBefore(section, child);
    }
    if (section) section.append(child);
  }
  return document.body.innerHTML;
}

export async function refreshRelationalNotes() {
  const panes = [...document.querySelectorAll<HTMLElement>('[data-relational-note-path]')];
  await Promise.all(panes.map(async pane => {
    const path = pane.dataset.relationalNotePath;
    const revision = String(Number(pane.dataset.refreshRevision || 0) + 1);
    pane.dataset.refreshRevision = revision;
    try {
      const response = await fetch(`/api/workspace/file?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('Unable to refresh relational note');
      const content = await response.text();
      if (!pane.isConnected || pane.dataset.refreshRevision !== revision) return;
      pane.querySelector('.relational-note-content').innerHTML = relationalNoteMarkup(content, path);
      for (const resource of [state.primaryResource, state.secondaryResource, ...state.workspaceTabs.primary.map(tab => tab.resource), ...state.workspaceTabs.secondary.map(tab => tab.resource)]) {
        if (resource?.path === path) resource.content = content;
      }
    } catch (error) { toast(error.message, 'error'); }
  }));
}

function workspaceResourcePane(resource, pane = "secondary") {
  if (resource?.cloudDeleted) return '<section class="note-pane"><p role="status">This document was deleted remotely.</p></section>';
  if (resource?.type === "collection-record") return collectionRecordMarkup(resource, pane);
  const node = findWorkspaceNode(resource?.path) || resource;
  if (!node?.type && !node?.kind) return "";
  const kind = node.kind || node.type;
  const title = node.label || node.title || node.name || "Document";
  const path = node.path || resource.path;
  const url = node.url || resource.url || "";
  const paperId = Number(node.paper_id || node.paperId || resource.paperId || 0);
  const markdownContent = String(resource.content || "");
  if (kind === "canvas") return canvasEditorMarkup(resource, pane);
  if (kind === "markdown" && (node.generated || resource.generated)) {
    return `<section class="secondary-resource-pane note-pane relational-note-pane" data-${pane}-path="${escapeHtml(path)}" data-pane-drop="${pane}" data-relational-note-path="${escapeHtml(path)}"><header><strong>${escapeHtml(title)}</strong><small>Automatically updated · Read-only</small>${node.project_id ? `<button class="button" data-action="edit-project" data-project-id="${node.project_id}">Project settings</button><button class="button" data-action="add-project-resource" data-project-id="${node.project_id}">Link resource</button><a class="button" href="/api/projects/${node.project_id}/export" download>Export</a>` : ""}</header><article class="relational-note-content">${relationalNoteMarkup(markdownContent, path)}</article></section>`;
  }
  if (kind === "markdown") {
    const descriptor = { title, workspacePath: path, url };
    const blocks = markdownBlockEditorMarkup(markdownContent, {
      sourceClass: "note-content workspace-markdown-content",
      assetBase: "",
      ariaLabel: `Markdown source — ${title}`,
    });
    return `<section class="secondary-resource-pane workspace-markdown-pane note-pane note-editor" data-${pane}-path="${escapeHtml(path)}" data-pane-drop="${pane}" data-workspace-markdown-path="${escapeHtml(path)}">${notePaneChrome(descriptor, pane)}<div class="markdown-block-shell workspace-markdown-block-shell">${blocks}</div></section>`;
  }
  const content =
    kind === "image"
      ? `<div class="secondary-image-view"><img src="${escapeHtml(url)}" alt="${escapeHtml(title)}"></div>`
      : kind === "video" || kind === "audio"
        ? `<${kind} src="${escapeHtml(url)}" controls preload="metadata" aria-label="${escapeHtml(title)}"></${kind}>`
      : kind === "pdf" && paperId
        ? pdfCaptureWorkspaceMarkup(paperId, true, url)
      : `<iframe class="secondary-document-view" src="${escapeHtml(url)}${kind === "pdf" ? "#view=FitH" : ""}" title="${escapeHtml(title)}"></iframe>`;
  return `<section class="secondary-resource-pane resource-kind-${escapeHtml(kind)}" data-${pane}-path="${escapeHtml(path)}" data-pane-drop="${pane}">${content}</section>`;
}

function secondaryResourcePane() {
  const resource = state.secondaryResource;
  if (!resource) return "";
  if (resource.type === "note") {
    const note = state.notes.find(
      (item) => item.id === Number(resource.noteId),
    );
    if (!note) return "";
    if (isDrawingNote(note)) return drawingNotePane(note, "secondary");
    const blocks = markdownBlockEditorMarkup(note.content, {
      sourceId: "secondary-note-content",
      sourceClass: "note-content",
      editorId: "secondary-note-block-editor",
      assetBase: noteAssetBase(note),
      ariaLabel: `Markdown source — ${note.title}`,
    });
    return `<section class="secondary-resource-pane secondary-note-pane note-pane" data-secondary-note-id="${note.id}" data-pane-drop="secondary">${notePaneChrome(note, "secondary")}${noteTemplatePicker()}<div class="note-link-picker secondary-note-link-picker hidden" id="secondary-note-link-picker" role="dialog" aria-label="Link a note from the second editor"><div class="note-link-picker-head"><span>Link a note</span><button type="button" id="secondary-note-link-close" aria-label="Close">×</button></div><input id="secondary-note-link-search" type="search" autocomplete="off" placeholder="Search notes…"><div class="note-link-results" id="secondary-note-link-results"></div></div><div class="markdown-block-shell">${blocks}</div></section>`;
  }
  return workspaceResourcePane(resource, "secondary");
}

export function workspaceNoteTab(note) {
  return note
    ? { id: `note:${note.id}`, type: "note", noteId: note.id }
    : null;
}

export async function reloadNoteForOpen(noteId: number) {
  await flushCurrentNoteAutosave();
  await flushSecondaryNoteAutosave();
  if (document.querySelector('.note-autosave-state[data-state="error"]')) {
    toast('Save your changes before reloading a note.', 'error');
    return null;
  }
  try {
    const note = await api(`/notes/${noteId}`, {cache: 'no-store'});
    state.notes = [...state.notes.filter(item => item.id !== noteId), note];
    return note;
  } catch (error) {
    toast(`Unable to reload the note: ${(error as Error).message}`, 'error');
    return null;
  }
}

export function workspaceResourceTab(resource) {
  return resource
    ? { id: `resource:${resource.path}`, type: "resource", resource }
    : null;
}

export function workspaceEmptyTab(pane = "primary") {
  return {
    id: `empty:${pane}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 6)}`,
    type: "empty",
  };
}

function ensureWorkspacePaneTab(pane) {
  if (state.workspaceTabs[pane].length) return;
  ensureWorkspaceTab(pane, workspaceEmptyTab(pane));
}

export function ensureWorkspaceTab(pane, tab) {
  if (!tab) return;
  const tabs = state.workspaceTabs[pane];
  const existing = tabs.find((item) => item.id === tab.id);
  if (existing) Object.assign(existing, tab);
  else tabs.push(tab);
  state.workspaceActiveTabs[pane] = tab.id;
}

function workspaceTabLabel(tab) {
  if (tab.type === "empty") return "New tab";
  if (tab.type === "note")
    return state.notes.find((item) => item.id === Number(tab.noteId))?.title || "Note";
  const node = findWorkspaceNode(tab.resource?.path);
  return node?.label || node?.name || tab.resource?.title || tab.resource?.path?.split("/").pop() || "Document";
}

function workspacePaneWithTabs(content, pane) {
  const noteId = pane === 'primary' ? state.currentNoteId : state.secondaryResource?.noteId;
  const resource = pane === 'primary' ? state.primaryResource : state.secondaryResource;
  const signature = JSON.stringify({
    noteContent: noteId ? state.notes.find(note => note.id === Number(noteId))?.content : undefined,
    drawing: undefined,
    record: resource?.type === 'collection-record' ? findCollectionItem(resource.content)?.source : undefined,
    active: state.workspaceActiveTabs[pane],
    split: Boolean(state.secondaryResource),
    renderVersion: (pane === "primary" ? state.primaryResource : state.secondaryResource)?.renderVersion || 0,
    tabs: state.workspaceTabs[pane].map((tab) => [tab.id, workspaceTabLabel(tab)]),
  });
  // Pane tabs are drawn in the titlebar, above their pane (see WindowHeader).
  return `<div class="workspace-pane-stack" data-workspace-pane="${pane}" data-workspace-signature="${escapeHtml(signature)}">${content}</div>`;
}

function workspaceTabById(pane, tabId) {
  return state.workspaceTabs[pane].find((item) => item.id === tabId);
}

export function applyWorkspaceTab(pane, tab) {
  if (!tab) return;
  state.workspaceActiveTabs[pane] = tab.id;
  if (tab.type === "empty") {
    if (pane === "primary") {
      state.currentNoteId = null;
      state.primaryResource = null;
    } else state.secondaryResource = null;
  } else if (tab.type === "note") {
    const note = state.notes.find((item) => item.id === Number(tab.noteId));
    if (!note) return;
    if (pane === "primary") {
      state.currentNoteId = note.id;
      state.primaryResource = null;
      state.noteScope = note.paper_id
        ? `paper:${note.paper_id}`
        : note.project_id
          ? `project:${note.project_id}`
          : "general";
      state.noteFolderId = note.folder_id || "all";
    } else state.secondaryResource = { type: "note", noteId: note.id, mode: "edit" };
    rememberWorkspaceSession({ type: "note", noteId: note.id });
  } else if (pane === "primary") {
    state.currentNoteId = null;
    state.primaryResource = tab.resource;
  }
  else state.secondaryResource = tab.resource;
  if (tab.type === "resource") {
    const paperId = Number(tab.resource?.paperId || tab.resource?.paper_id || 0);
    if (paperId)
      rememberWorkspaceSession({
        type: "paper",
        paperId,
        page: state.readingProgress[String(paperId)] || 1,
      });
    else
      rememberWorkspaceSession({
        type: "resource",
        path: tab.resource?.path,
        title: tab.resource?.title,
        kind: tab.resource?.type,
      });
  }
  state.activeNotePane = pane;
}

export function replaceActiveWorkspaceTab(pane, tab, newTab = false) {
  if (!tab) return;
  if (newTab) {
    ensureWorkspaceTab(pane, tab);
    return applyWorkspaceTab(pane, tab);
  }
  const tabs = state.workspaceTabs[pane];
  const alreadyOpen = tabs.find((item) => item.id === tab.id);
  if (alreadyOpen) return applyWorkspaceTab(pane, alreadyOpen);
  const activeIndex = tabs.findIndex(
    (item) => item.id === state.workspaceActiveTabs[pane],
  );
  if (activeIndex >= 0) tabs.splice(activeIndex, 1, tab);
  else tabs.push(tab);
  applyWorkspaceTab(pane, tab);
}

export function createWorkspaceTab(pane = "primary") {
  const tab = workspaceEmptyTab(pane);
  state.workspaceTabs[pane].push(tab);
  applyWorkspaceTab(pane, tab);
  rerenderNotesContext();
}

export async function activateWorkspaceTab(pane, tabId) {
  await flushCurrentNoteAutosave();
  await flushSecondaryNoteAutosave();
  await flushWorkspaceMarkdownSaves();
  await flushCanvasSaves();
  const tab = workspaceTabById(pane, tabId);
  if (tab?.type === 'note' && !await reloadNoteForOpen(Number(tab.noteId))) return;
  applyWorkspaceTab(pane, tab);
  rerenderNotesContext();
}

export async function closeWorkspaceTab(pane, tabId) {
  await flushCurrentNoteAutosave();
  await flushSecondaryNoteAutosave();
  await flushWorkspaceMarkdownSaves();
  await flushCanvasSaves();
  const tabs = state.workspaceTabs[pane];
  const index = tabs.findIndex((item) => item.id === tabId);
  if (index < 0) return;
  const nextTabs = tabs.filter((_, position) => position !== index);
  const fallback = nextTabs[Math.min(index, nextTabs.length - 1)] || null;
  if (state.workspaceActiveTabs[pane] === tabId && fallback?.type === "note" && !await reloadNoteForOpen(Number(fallback.noteId))) return;
  tabs.splice(index, 1);
  if (state.workspaceActiveTabs[pane] !== tabId) return rerenderNotesContext();
  state.workspaceActiveTabs[pane] = fallback?.id || null;
  if (fallback) applyWorkspaceTab(pane, fallback);
  else if (pane === "secondary") {
    state.secondaryResource = null;
    state.secondaryFirst = false;
    state.activeNotePane = "primary";
  } else {
    if (!promoteSecondaryWorkspacePane()) {
      const empty = workspaceEmptyTab("primary");
      tabs.push(empty);
      applyWorkspaceTab("primary", empty);
    }
  }
  rerenderNotesContext();
}

function promoteSecondaryWorkspacePane() {
  if (!state.workspaceTabs.secondary.length) return false;
  state.workspaceTabs.primary = state.workspaceTabs.secondary;
  state.workspaceActiveTabs.primary =
    state.workspaceActiveTabs.secondary || state.workspaceTabs.primary[0]?.id || null;
  state.workspaceTabs.secondary = [];
  state.workspaceActiveTabs.secondary = null;
  state.primaryResource = null;
  state.secondaryResource = null;
  state.secondaryFirst = false;
  const active = workspaceTabById("primary", state.workspaceActiveTabs.primary);
  if (active) applyWorkspaceTab("primary", active);
  state.activeNotePane = "primary";
  return true;
}

export async function mergeWorkspacePanes(sourcePane: string, targetPane: string) {
  if (!["primary", "secondary"].includes(sourcePane) ||
      !["primary", "secondary"].includes(targetPane) || sourcePane === targetPane) return;
  await flushCurrentNoteAutosave();
  await flushSecondaryNoteAutosave();
  await flushWorkspaceMarkdownSaves();
  await flushCanvasSaves();
  await flushCollectionSaves();
  const active = workspaceTabById(sourcePane, state.workspaceActiveTabs[sourcePane]);
  const tabs = [...state.workspaceTabs[targetPane]];
  for (const tab of state.workspaceTabs[sourcePane]) {
    if (!tabs.some(item => item.id === tab.id)) tabs.push(tab);
  }
  const selected = active || tabs.find(tab => tab.id === state.workspaceActiveTabs[targetPane]) || tabs[0];
  state.workspaceTabs.primary = tabs;
  state.workspaceTabs.secondary = [];
  state.workspaceActiveTabs.secondary = null;
  state.secondaryResource = null;
  state.secondaryFirst = false;
  if (selected) applyWorkspaceTab("primary", selected);
  state.activeNotePane = "primary";
  rerenderNotesContext();
}

/** Move one tab to a position in a pane: reorders within a pane, or moves it to the other one (opening it if needed). */
export async function moveWorkspaceTab(sourcePane: string, tabId: string, targetPane: string, index = -1) {
  if (!["primary", "secondary"].includes(sourcePane) || !["primary", "secondary"].includes(targetPane)) return;
  await flushCurrentNoteAutosave();
  await flushSecondaryNoteAutosave();
  await flushWorkspaceMarkdownSaves();
  await flushCanvasSaves();
  const source = state.workspaceTabs[sourcePane];
  const from = source.findIndex((item) => item.id === tabId);
  if (from < 0) return;
  const target = state.workspaceTabs[targetPane];
  const [tab] = source.splice(from, 1);
  if (sourcePane === targetPane) {
    // The index was measured before removal, so later positions shift by one.
    source.splice(index < 0 ? source.length : Math.min(index > from ? index - 1 : index, source.length), 0, tab);
    return rerenderNotesContext();
  }
  const existing = target.find((item) => item.id === tab.id);
  if (!existing) target.splice(index < 0 ? target.length : Math.min(index, target.length), 0, tab);
  const moved = existing || tab;
  if (!source.length && sourcePane === "primary") {
    // The secondary pane becomes the only pane.
    promoteSecondaryWorkspacePane();
    applyWorkspaceTab("primary", workspaceTabById("primary", moved.id));
    return rerenderNotesContext();
  }
  if (!source.length) {
    state.workspaceActiveTabs.secondary = null;
    state.secondaryResource = null;
    state.secondaryFirst = false;
  } else if (state.workspaceActiveTabs[sourcePane] === tab.id) applyWorkspaceTab(sourcePane, source[Math.min(from, source.length - 1)]);
  applyWorkspaceTab(targetPane, moved);
  rerenderNotesContext();
}

export function splitActiveWorkspaceTab() {
  const active = state.workspaceActiveTabs.primary;
  const source = workspaceTabById("primary", active);
  if (!source || source.type === "empty") return;
  const copy = source.type === "resource"
    ? { ...source, resource: source.resource }
    : { ...source };
  copy.id = `${copy.id}:split:${Date.now().toString(36)}`;
  ensureWorkspaceTab("secondary", copy);
  applyWorkspaceTab("secondary", copy);
  rerenderNotesContext();
}

function emptyWorkspacePane(pane = "primary") {
  return `<section class="workspace-empty-pane" data-pane-drop="${pane}"><div><span>${interfaceIcon("note")}</span><h3>Open or create a note</h3><p>Select a note in the tree, or create a new note or folder.</p><div class="workspace-empty-actions"><button class="button button-primary" data-action="new-note">＋ New note</button></div></div></section>`;
}

export async function workspaceResourcePayload(node) {
  const resource: WorkspaceResource = {
    type: node.kind,
    path: node.path,
    title: node.label || node.name,
    url: node.url,
    paperId: Number(node.paper_id || 0) || null,
    generated: Boolean(node.generated),
  };
  if (node.kind === "markdown") {
    const response = await fetch(node.url, { cache: "no-store" });
    if (!response.ok) throw new Error("Unable to read this Markdown file");
    resource.content = await response.text();
  }
  if (node.kind === "canvas") {
    const response = await fetch(node.url, { cache: "no-store" });
    if (!response.ok) throw new Error("Unable to read this canvas");
    resource.content = await response.json();
  }
  return resource;
}

/** Reload cached file payloads too: refreshing the tree alone leaves them stale. */
export async function refreshOpenCloudResources(canApply: () => boolean) {
  const resources = [...new Set([
    state.primaryResource, state.secondaryResource,
    ...state.workspaceTabs.primary.map(tab => tab.resource),
    ...state.workspaceTabs.secondary.map(tab => tab.resource),
  ].filter(Boolean))];
  const updates = await Promise.all(resources.map(async resource => {
    if (!['markdown', 'canvas'].includes(resource.type)) return null;
    const node = findWorkspaceNode(resource.path);
    if (!node) return {resource, payload: {cloudDeleted: true}};
    const fresh = await workspaceResourcePayload(node);
    return {resource, payload: {...fresh, cloudDeleted: false}};
  }));
  if (!canApply()) return;
  for (const update of updates) {
    if (!update) continue;
    const {resource, payload} = update;
    // Canvas cards also display linked notes/records. Their content can change
    // without changing the .canvas file: rebuild the open canvas after every
    // received revision so its cards and inspector use the freshly loaded data.
    if (resource.type === 'canvas' || Object.entries(payload).some(([key, value]) => JSON.stringify(resource[key]) !== JSON.stringify(value))) {
      Object.assign(resource, payload, {renderVersion: (resource.renderVersion || 0) + 1});
    }
  }
  const openNoteIds = [...document.querySelectorAll<HTMLElement>('[data-primary-note-id], [data-secondary-note-id]')]
    .map(pane => Number(pane.dataset.primaryNoteId || pane.dataset.secondaryNoteId));
  if (openNoteIds.some(id => !state.notes.some(note => note.id === id)))
    toast('An open note was deleted remotely.', 'error');
}

async function persistWorkspaceMarkdown(path, editor, indicator) {
  if (!path || !editor) return;
  if (indicator) { indicator.textContent = "Saving…"; indicator.dataset.state = 'saving'; }
  try {
    await api("/workspace/file", {
      method: "PUT",
      body: JSON.stringify({ path, content: editor.value }),
    });
    [state.primaryResource, state.secondaryResource].forEach((resource) => {
      if (resource?.path === path) resource.content = editor.value;
    });
    if (indicator) { indicator.textContent = "Saved"; indicator.dataset.state = 'saved'; }
  } catch (error) {
    if (indicator) { indicator.textContent = "Save failed"; indicator.dataset.state = 'error'; }
    toast(error.message, "error");
  }
}

function updateMarkdownDocumentStats(editor) {
  const target = editor
    ?.closest(".note-pane")
    ?.querySelector(".markdown-document-stats");
  if (!editor || !target) return;
  const words = editor.value.trim()
    ? editor.value.trim().split(/\s+/).length
    : 0;
  const minutes = Math.max(1, Math.ceil(words / 220));
  target.textContent = `${words} word${words === 1 ? "" : "s"} · ${minutes} min`;
}

export function bindMarkdownWritingExperience(editor) {
  if (!editor) return;
  updateMarkdownDocumentStats(editor);
  editor.addEventListener("input", () => updateMarkdownDocumentStats(editor));
  editor.addEventListener("keydown", (event) => {
    const command = event.metaKey || event.ctrlKey;
    if (command && ["b", "i", "k"].includes(event.key.toLowerCase())) {
      event.preventDefault();
      applyMarkdownToEditor(
        editor,
        { b: "bold", i: "italic", k: "link" }[event.key.toLowerCase()],
      );
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      if (event.shiftKey) {
        const lineStart = editor.value.lastIndexOf("\n", start - 1) + 1;
        const removable =
          editor.value.slice(lineStart, lineStart + 2).match(/^(  |\t)/)?.[0] ||
          "";
        if (removable)
          editor.setRangeText(
            "",
            lineStart,
            lineStart + removable.length,
            "end",
          );
      } else {
        editor.setRangeText("  ", start, end, "end");
      }
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.metaKey ||
      event.ctrlKey ||
      editor.selectionStart !== editor.selectionEnd
    )
      return;
    const cursor = editor.selectionStart;
    const lineStart = editor.value.lastIndexOf("\n", cursor - 1) + 1;
    const line = editor.value.slice(lineStart, cursor);
    const list = line.match(/^(\s*)([-*+] |\d+[.)] |[-*] \[[ xX]\] )(.*)$/);
    if (!list) return;
    event.preventDefault();
    if (!list[3]) {
      editor.setRangeText("", lineStart, cursor, "end");
    } else {
      const marker = /^\d/.test(list[2])
        ? `${Number.parseInt(list[2], 10) + 1}. `
        : /\[[ xX]\]/.test(list[2])
          ? "- [ ] "
          : list[2];
      editor.setRangeText(`\n${list[1]}${marker}`, cursor, cursor, "end");
    }
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function bindWorkspaceMarkdownEditors(root) {
  root
    ?.querySelectorAll("[data-workspace-markdown-path]")
    .forEach((container) => {
      if (container.closest('[data-workspace-bound="true"]')) return;
      const path = container.dataset.workspaceMarkdownPath;
      const editor = container.querySelector(".workspace-markdown-content");
      const blockEditor = container.querySelector(".markdown-block-editor");
      const indicator = container.querySelector(
        ".workspace-markdown-save-state",
      );
      bindMarkdownBlockEditor(blockEditor, editor);
      bindMarkdownWritingExperience(editor);
      const queueSave = () => {
        const pending = workspaceMarkdownTimers.get(path);
        if (pending) clearTimeout(pending.timer);
        const save = () => persistWorkspaceMarkdown(path, editor, indicator);
        const timer = setTimeout(async () => {
          workspaceMarkdownTimers.delete(path);
          await save();
        }, 650);
        workspaceMarkdownTimers.set(path, { timer, save });
      };
      editor?.addEventListener("input", () => {
        if (indicator) indicator.textContent = "Unsaved changes…";
        queueSave();
      });
      blockEditor?.addEventListener("focusout", async (event) => {
        if (event.relatedTarget && blockEditor.contains(event.relatedTarget))
          return;
        const pending = workspaceMarkdownTimers.get(path);
        if (!pending) return;
        clearTimeout(pending.timer);
        workspaceMarkdownTimers.delete(path);
        await pending.save();
      });
      container
        .querySelectorAll("[data-workspace-md-action]")
        .forEach((button) =>
          button.addEventListener("click", () => {
            applyMarkdownToEditor(
              currentMarkdownBlockInput(blockEditor, true),
              button.dataset.workspaceMdAction,
            );
          }),
        );
    });
}

export async function flushWorkspaceMarkdownSaves() {
  await flushCollectionSaves();
  const pending = [...workspaceMarkdownTimers.values()];
  workspaceMarkdownTimers.clear();
  await Promise.all(
    pending.map((item) => {
      clearTimeout(item.timer);
      return item.save();
    }),
  );
}

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
  const recentNotes = [...contextNotes].filter(item => !item.trashed_at).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''))).slice(0, 6);
  const recents = '<details class="notes-recents"><summary>Recently modified</summary><div class="notes-recents-list">' + (recentNotes.length ? recentNotes.map(item => '<button data-note="' + item.id + '" data-note-tree-scope="' + (item.paper_id ? 'paper:' + item.paper_id : item.project_id ? 'project:' + item.project_id : 'general') + '" data-note-tree-folder="' + (item.folder_id || '') + '" title="' + escapeHtml(item.title) + '"><span class="recent-note-icon">' + interfaceIcon(item.drawing ? 'draw' : 'note') + '</span><span><strong>' + escapeHtml(item.title) + '</strong><small>' + escapeHtml(formatDate(item.updated_at)) + '</small></span></button>').join('') : '<p>Your latest notes will appear here.</p>') + '</div></details>';
  return `<section class="notes-layout" data-notes-project="${projectId || ""}" style="--notes-sidebar-width:${state.noteSidebarWidth}px"><aside class="notes-sidebar">${notesExplorerToolbar()}<div class="notes-tree" id="notes-tree">${notesWorkspaceContexts()}</div><div class="note-search-results hidden" id="note-items" aria-live="polite"></div>${recents}</aside><button class="notes-sidebar-resizer" type="button" role="separator" aria-label="Resize document sidebar" aria-orientation="vertical" aria-valuemin="230" aria-valuemax="520" aria-valuenow="${state.noteSidebarWidth}"><span></span></button>${editorWorkspace}</section>`;
}

export function renderNotes() {
  prepareEditor();
  const previousPanes = new Map(
    [...main.querySelectorAll("#main-notes-area .workspace-pane-stack")].map(
      (pane) => [(pane as HTMLElement).dataset.workspacePane, pane],
    ),
  );
  main.classList.remove("overview-mode");
  main.classList.add("notes-mode");
  const projectId = activeNoteProjectId();
  main.innerHTML = `<div id="main-notes-area">${renderNotesWorkspace(projectId)}</div>`;
  const root = main.querySelector("#main-notes-area");
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
  bindNotesWorkspace(projectId);
  void refreshRelationalNotes();
}

/** Redraws the explorer from the loaded tree: expanding a folder or starting a rename needs no server round trip. */
export function rerenderWorkspaceTree() {
  const tree = document.querySelector("#notes-tree");
  if (!tree || state.view !== "notes") return false;
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
  if (rerenderWorkspaceTree()) await refreshRelationalNotes();
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

function bindWorkspaceTreeEditors(root) {
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

function transferredNoteFile(files) {
  return [...(files || [])].find((item) => item?.size > 0) || null;
}

function markActiveNotePane(pane, root: Document | Element = document) {
  state.activeNotePane = pane === "secondary" ? "secondary" : "primary";
  root.querySelectorAll("[data-pane-drop]").forEach((item) => {
    item.classList.toggle(
      "active-note-pane",
      (item as HTMLElement).dataset.paneDrop === state.activeNotePane,
    );
  });
}

async function uploadFileIntoNote(
  noteId,
  editor,
  preview,
  file,
  cursor,
  assetBase,
  context = "primary",
) {
  if (!noteId || !editor || !file) return;
  if (context === "secondary") await flushSecondaryNoteAutosave();
  else if (context === "reader") await flushReaderAutosave();
  else await flushCurrentNoteAutosave();
  const form = new FormData();
  form.append(
    "cursor",
    String(
      Math.max(
        0,
        Math.min(editor.value.length, cursor ?? editor.selectionStart),
      ),
    ),
  );
  form.append("alt", file.name?.replace(/\.[^.]+$/, "") || "Image");
  form.append("file", file);
  try {
    const result = await api(`/notes/${noteId}/assets`, {
      method: "POST",
      body: form,
    });
    editor.value = result.content;
    editor.setSelectionRange(result.insertion_end, result.insertion_end);
    const blockEditor = editor
      .closest(".note-pane, .reader-note-pane, .project-note-modal")
      ?.querySelector(".markdown-block-editor");
    if (blockEditor) {
      const focusIndex = result.content
        .slice(0, result.insertion_end)
        .split("\n").length - 1;
      setMarkdownBlockEditorContent(
        blockEditor,
        editor,
        result.content,
        assetBase,
        focusIndex,
      );
    }
    const cached = state.notes.find((item) => item.id === Number(noteId));
    if (cached) Object.assign(cached, result.note);
    if (preview && !blockEditor)
      preview.innerHTML = renderMarkdown(result.content, assetBase);
    const assetLabel = result.kind === "image" ? "Image" : "File";
    if (context === "secondary")
      document.querySelector("#secondary-note-save-state").textContent =
        `${assetLabel} inserted · saved`;
    else if (context === "reader")
      document.querySelector("#reader-save-state").textContent =
        `${assetLabel} inserted · saved`;
    else setNoteAutosaveState(`${assetLabel} inserted · saved`, "saved");
    refreshWorkspaceTreeOnly().catch(() => {});
    if (!blockEditor) editor.focus();
    toast(`${assetLabel} added to the note`);
  } catch (error) {
    toast(error.message, "error");
  }
}

// Serialize writes per note, including when it is open in both panes.
const noteWrites = new Map<number, Promise<any>>();
function writeNoteContent(noteId: number, content: string) {
  const previous = noteWrites.get(noteId) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const cached = state.notes.find(n => n.id === noteId);
    const saved = await api(`/notes/${noteId}`, {
      method: 'PATCH', body: JSON.stringify({ content, expected_hash: cached?.content_hash }),
    });
    if (cached) cached.content_hash = saved.content_hash;
    return saved;
  });
  noteWrites.set(noteId, pending);
  const cleanup = () => { if (noteWrites.get(noteId) === pending) noteWrites.delete(noteId); };
  pending.then(cleanup, cleanup);
  return pending;
}

async function persistSecondaryNoteContent(noteId, content) {
  const indicator = document.querySelector("#secondary-note-save-state");
  if (indicator) { indicator.textContent = "Saving…"; (indicator as HTMLElement).dataset.state = "saving"; }
  try {
    const updated = await writeNoteContent(noteId, content);
    const cached = state.notes.find((item) => item.id === noteId);
    if (cached) Object.assign(cached, updated);
    if (indicator) { indicator.textContent = "Saved automatically"; (indicator as HTMLElement).dataset.state = "saved"; }
    return updated;
  } catch (error) {
    if (indicator) { indicator.textContent = "Save failed"; (indicator as HTMLElement).dataset.state = "error"; }
    toast(error.message, "error");
    return null;
  }
}

function queueSecondaryNoteAutosave() {
  const editor = document.querySelector("#secondary-note-content");
  const noteId = Number(
    (document.querySelector("[data-secondary-note-id]") as HTMLElement)?.dataset
      .secondaryNoteId || 0,
  );
  if (!editor || !noteId) return;
  clearTimeout(editorSession.secondaryNoteAutosaveTimer);
  const indicator = document.querySelector("#secondary-note-save-state");
  if (indicator) { indicator.textContent = "Unsaved changes…"; (indicator as HTMLElement).dataset.state = "pending"; }
  editorSession.secondaryNoteAutosaveTimer = setTimeout(() => {
    editorSession.secondaryNoteAutosaveTimer = null;
    persistSecondaryNoteContent(noteId, (editor as HTMLInputElement).value);
  }, 650);
}

export async function flushSecondaryNoteAutosave() {
  const editor = document.querySelector("#secondary-note-content");
  const noteId = Number(
    (document.querySelector("[data-secondary-note-id]") as HTMLElement)?.dataset
      .secondaryNoteId || 0,
  );
  if (!editor || !noteId) return null;
  if (!editorSession.secondaryNoteAutosaveTimer) return noteWrites.get(noteId)?.catch(() => null) || null;
  clearTimeout(editorSession.secondaryNoteAutosaveTimer);
  editorSession.secondaryNoteAutosaveTimer = null;
  return persistSecondaryNoteContent(noteId, (editor as HTMLInputElement).value);
}

function bindSecondaryResource(root) {
  const editor = root?.querySelector("#secondary-note-content");
  const blockEditor = root?.querySelector("#secondary-note-block-editor");
  const note = state.notes.find(
    (item) =>
      item.id ===
      Number(
        root?.querySelector("[data-secondary-note-id]")?.dataset
          .secondaryNoteId || 0,
      ),
  );
  bindMarkdownBlockEditor(blockEditor, editor);
  bindMarkdownWritingExperience(editor);
  bindNoteTitleInputs(root);
  blockEditor?.addEventListener("focusin", () =>
    markActiveNotePane("secondary", root),
  );
  editor?.addEventListener("input", () => {
    queueSecondaryNoteAutosave();
  });
  blockEditor?.addEventListener("input", (event) => {
    const input = event.target.closest(".markdown-block-input");
    if (!input) return;
    const cursor = input.selectionStart;
    const match = input.value.slice(0, cursor).match(/\[\[([^\]\n]*)$/);
    if (
      match &&
      root
        .querySelector("#secondary-note-link-picker")
        ?.classList.contains("hidden")
    ) {
      openSecondaryNoteLinkPicker(cursor - match[0].length, cursor, match[1]);
    }
  });
  blockEditor?.addEventListener("focusout", (event) => {
    if (!event.relatedTarget || !blockEditor.contains(event.relatedTarget))
      flushSecondaryNoteAutosave();
  });
  root?.querySelectorAll("[data-secondary-md-action]").forEach((button) =>
    button.addEventListener("click", () => {
      applyMarkdownToEditor(
        currentMarkdownBlockInput(blockEditor, true),
        button.dataset.secondaryMdAction,
      );
    }),
  );

  const renderSecondaryNoteLinkResults = () => {
    const input = root?.querySelector("#secondary-note-link-search");
    const results = root?.querySelector("#secondary-note-link-results");
    if (!input || !results || !note) return;
    const normalized = input.value.trim().toLocaleLowerCase();
    const notes = state.notes
      .filter((item) => item.id !== note.id)
      .filter(
        (item) =>
          !normalized ||
          `${item.title} ${noteContextLabel(item)}`
            .toLocaleLowerCase()
            .includes(normalized),
      )
      .sort((left, right) =>
        left.title.localeCompare(right.title, undefined, { sensitivity: "base" }),
      )
      .slice(0, 12);
    results.innerHTML = notes.length
      ? notes
          .map(
            (item) =>
              `<button type="button" class="note-link-result" data-secondary-insert-note-link="${item.id}"><span>${item.paper_id ? "▤" : "✎"}</span><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(noteContextLabel(item))}</small></div></button>`,
          )
          .join("")
      : `<div class="note-link-empty">No notes found.</div>`;
  };
  const openSecondaryNoteLinkPicker = (
    start = null,
    end = null,
    query = "",
  ) => {
    const picker = root?.querySelector("#secondary-note-link-picker");
    const input = root?.querySelector("#secondary-note-link-search");
    const activeEditor = currentMarkdownBlockInput(blockEditor, true);
    if (!activeEditor || !picker || !input || !note) return;
    const insertionStart = start ?? activeEditor.selectionStart;
    editorSession.secondaryNoteLinkRange = {
      noteId: note.id,
      blockIndex: Number(
        activeEditor.closest<HTMLElement>("[data-markdown-block]")?.dataset.markdownBlock ||
          0,
      ),
      start: insertionStart,
      end: end ?? insertionStart,
    };
    picker.classList.remove("hidden");
    input.value = query;
    renderSecondaryNoteLinkResults();
    input.focus();
    input.select();
  };
  const closeSecondaryNoteLinkPicker = (refocusEditor = false) => {
    root?.querySelector("#secondary-note-link-picker")?.classList.add("hidden");
    const activeEditor = currentMarkdownBlockInput(blockEditor);
    editorSession.secondaryNoteLinkRange = null;
    if (refocusEditor) activeEditor?.focus();
  };
  const insertSecondaryNoteLink = (noteId) => {
    const linked = state.notes.find((item) => item.id === Number(noteId));
    const activeEditor = blockEditor?.querySelector(
      `[data-markdown-block="${editorSession.secondaryNoteLinkRange?.blockIndex}"] .markdown-block-input`,
    );
    if (
      !activeEditor ||
      !note ||
      !linked ||
      !editorSession.secondaryNoteLinkRange ||
      editorSession.secondaryNoteLinkRange.noteId !== note.id
    )
      return closeSecondaryNoteLinkPicker();
    const label = linked.title.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
    activeEditor.setRangeText(
      `[${label}](#note-${linked.id})`,
      editorSession.secondaryNoteLinkRange.start,
      editorSession.secondaryNoteLinkRange.end,
      "end",
    );
    closeSecondaryNoteLinkPicker();
    activeEditor.focus();
    activeEditor.dispatchEvent(new Event("input", { bubbles: true }));
  };
  root
    ?.querySelector("[data-secondary-note-link]")
    ?.addEventListener("click", () => openSecondaryNoteLinkPicker());
  root
    ?.querySelector("#secondary-note-link-close")
    ?.addEventListener("click", () => closeSecondaryNoteLinkPicker(true));
  root
    ?.querySelector("#secondary-note-link-search")
    ?.addEventListener("input", renderSecondaryNoteLinkResults);
  root
    ?.querySelector("#secondary-note-link-search")
    ?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSecondaryNoteLinkPicker(true);
      }
      if (event.key === "Enter") {
        const first = root.querySelector("[data-secondary-insert-note-link]");
        if (first) {
          event.preventDefault();
          first.click();
        }
      }
    });
  root
    ?.querySelector("#secondary-note-link-results")
    ?.addEventListener("click", (event) => {
      const target = event.target.closest("[data-secondary-insert-note-link]");
      if (target)
        insertSecondaryNoteLink(Number(target.dataset.secondaryInsertNoteLink));
    });
  let imageCursor = 0;
  const imageInput = root?.querySelector("#secondary-note-image-input");
  root
    ?.querySelector("[data-secondary-note-image]")
    ?.addEventListener("click", () => {
      imageCursor = markdownBlockSourceOffset(blockEditor);
      imageInput?.click();
    });
  imageInput?.addEventListener("change", () => {
    const file = imageInput.files?.[0];
    if (file && note)
      uploadFileIntoNote(
        note.id,
        editor,
        null,
        file,
        imageCursor,
        noteAssetBase(note),
        "secondary",
      );
    imageInput.value = "";
  });
  blockEditor?.addEventListener("paste", (event) => {
    const file = transferredNoteFile(event.clipboardData?.files);
    if (!file || !note) return;
    event.preventDefault();
    uploadFileIntoNote(
      note.id,
      editor,
      null,
      file,
      markdownBlockSourceOffset(blockEditor, event.target),
      noteAssetBase(note),
      "secondary",
    );
  });
  blockEditor?.addEventListener("dragover", (event) => {
    if (transferredNoteFile(event.dataTransfer?.files)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      blockEditor.classList.add("is-file-drop");
    }
  });
  blockEditor?.addEventListener("dragleave", (event) => {
    if (!blockEditor.contains(event.relatedTarget))
      blockEditor.classList.remove("is-file-drop");
  });
  blockEditor?.addEventListener("drop", (event) => {
    const file = transferredNoteFile(event.dataTransfer?.files);
    if (!file || !note) return;
    event.preventDefault();
    blockEditor.classList.remove("is-file-drop");
    uploadFileIntoNote(
      note.id,
      editor,
      null,
      file,
      markdownBlockSourceOffset(
        blockEditor,
        event.target.closest(".markdown-block")?.querySelector(
          ".markdown-block-input",
        ),
      ),
      noteAssetBase(note),
      "secondary",
    );
  });
}

/** Filter the notes explorer from the titlebar search field. */
function applyNoteSearch(value: string) {
  const root = document.querySelector("#main-notes-area");
  const tree = root?.querySelector("#notes-tree");
  const results = root?.querySelector("#note-items");
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
function bindNoteSearchOnce() {
  if (noteSearchBound) return;
  noteSearchBound = true;
  const update = (event: Event) => {
    const input = event.target as HTMLInputElement;
    if (input?.id === "note-filter") applyNoteSearch(input.value);
  };
  document.addEventListener("input", update);
  document.addEventListener("search", update, true);
}

function bindNotesWorkspace(projectId = null) {
  const root =
    document.querySelector(
      projectId ? "#project-notes-area" : "#main-notes-area",
    ) || document.querySelector("#main-notes-area");
  const freshPrimary = root?.querySelector(
    '.workspace-pane-stack[data-workspace-pane="primary"]:not([data-workspace-bound="true"])',
  );
  const freshSecondary = root?.querySelector(
    '.workspace-pane-stack[data-workspace-pane="secondary"]:not([data-workspace-bound="true"])',
  );
  [freshPrimary, freshSecondary].forEach(pane => pane?.addEventListener('input', event => {
    const input = event.target as HTMLInputElement;
    if (!input.hasAttribute('data-review-search')) return;
    const wrapper = input.closest('.review-data-table');
    const rows = [...wrapper.querySelectorAll<HTMLTableRowElement>('tbody tr')];
    rows.forEach(row => { row.hidden = !row.textContent.toLocaleLowerCase().includes(input.value.toLocaleLowerCase()); });
    wrapper.querySelector('.review-table-tools span').textContent = `${rows.filter(row => !row.hidden).length} / ${rows.length} lignes`;
  }));
  [freshPrimary, freshSecondary].forEach(pane => pane?.addEventListener('click', event => {
    const sort = (event.target as HTMLElement).closest<HTMLElement>('[data-review-sort]');
    if (sort) {
      const table = sort.closest('table');
      const descending = sort.parentElement.getAttribute('aria-sort') === 'ascending';
      table.querySelectorAll('th').forEach(header => header.setAttribute('aria-sort', 'none'));
      sort.parentElement.setAttribute('aria-sort', descending ? 'descending' : 'ascending');
      const column = Number(sort.dataset.reviewSort);
      [...table.tBodies[0].rows].sort((a, b) => (a.cells[column]?.textContent || '').localeCompare(b.cells[column]?.textContent || '', undefined, { numeric: true }) * (descending ? -1 : 1)).forEach(row => table.tBodies[0].append(row));
      return;
    }
    const link = (event.target as HTMLElement).closest<HTMLElement>('.relational-note-pane a');
    if (!link) return;
    if (link.dataset.note || link.dataset.openWorkspaceResource || link.dataset.collectionNav || link.dataset.action || link.dataset.reviewFolder) event.preventDefault();
    if (link.dataset.reviewFolder) {
      const path = link.dataset.reviewFolder;
      expandWorkspacePathParents(path);
      state.expandedWorkspacePaths.add(path);
      void refreshWorkspaceTreeOnly().then(() => {
        const row = [...document.querySelectorAll<HTMLElement>('[data-workspace-toggle]')].find(item => item.dataset.workspaceToggle === path);
        row?.scrollIntoView({ block: 'nearest' });
        row?.focus();
      });
    }
  }));
  const editor = freshPrimary?.querySelector("#note-content");
  const blockEditor = freshPrimary?.querySelector("#note-block-editor");
  const noteFilter = document.querySelector<HTMLInputElement>("#note-filter");
  const noteTree = root?.querySelector("#notes-tree");
  if (noteTree) {
    noteTree.scrollTop = state.noteTreeScrollTop;
    requestAnimationFrame(() => {
      if (noteTree.isConnected) noteTree.scrollTop = state.noteTreeScrollTop;
    });
    noteTree.addEventListener(
      "scroll",
      () => {
        state.noteTreeScrollTop = noteTree.scrollTop;
      },
      { passive: true },
    );
  }
  bindCollectionEditors(root);
  bindWorkspaceMarkdownEditors(root);
  bindCanvasEditors(root);
  bindWorkspacePdfExtractors(root);
  bindMarkdownBlockEditor(blockEditor, editor);
  bindMarkdownWritingExperience(editor);
  bindNoteTitleInputs(freshPrimary);
  bindNoteTemplatePickers(root);
  bindWorkspaceTreeEditors(noteTree);
  blockEditor?.addEventListener("focusin", () =>
    markActiveNotePane("primary", root),
  );
  // The search field lives in the titlebar and survives tree rerenders: reapply its query.
  bindNoteSearchOnce();
  bindNotesExplorerOnce();
  decorateTreeSelection();
  decorateTreeFocus();
  applyNoteSearch(noteFilter?.value || "");
  editor?.addEventListener("input", () => {
    queueCurrentNoteAutosave();
  });
  blockEditor?.addEventListener("input", (event) => {
    const input = (event.target as HTMLElement).closest(".markdown-block-input");
    if (!input) return;
    const cursor = (input as HTMLInputElement).selectionStart;
    const match = (input as HTMLInputElement).value.slice(0, cursor).match(/\[\[([^\]\n]*)$/);
    if (
      match &&
      freshPrimary?.querySelector("#note-link-picker")?.classList.contains("hidden")
    ) {
      openNoteLinkPicker(cursor - match[0].length, cursor, match[1]);
    }
  });
  blockEditor?.addEventListener("focusout", (event) => {
    if (!(event as FocusEvent).relatedTarget || !blockEditor.contains((event as FocusEvent).relatedTarget as Node))
      flushCurrentNoteAutosave();
  });
  freshPrimary
    ?.querySelector("[data-note-link]")
    ?.addEventListener("click", () => openNoteLinkPicker());
  freshPrimary
    ?.querySelector("#note-link-close")
    ?.addEventListener("click", () => closeNoteLinkPicker());
  freshPrimary
    ?.querySelector("#note-link-search")
    ?.addEventListener("input", renderNoteLinkResults);
  freshPrimary
    ?.querySelector("#note-link-search")
    ?.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeNoteLinkPicker(true);
      }
      if ((event as KeyboardEvent).key === "Enter") {
          const firstResult = freshPrimary.querySelector("[data-insert-note-link]");
        if (firstResult) {
          event.preventDefault();
          (firstResult as HTMLElement).click();
        }
      }
    });
  freshPrimary
    ?.querySelector("#note-link-results")
    ?.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement).closest("[data-insert-note-link]");
      if (target) insertNoteLink(Number((target as HTMLElement).dataset.insertNoteLink));
    });
  freshPrimary
    ?.querySelectorAll("[data-md-action]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        applyMarkdownAction((button as HTMLElement).dataset.mdAction),
      ),
    );
  let imageCursor = 0;
  const imageInput = freshPrimary?.querySelector("#note-image-input");
  freshPrimary?.querySelector("[data-note-image]")?.addEventListener("click", () => {
    imageCursor = markdownBlockSourceOffset(blockEditor);
    (imageInput as HTMLElement)?.click();
  });
  imageInput?.addEventListener("change", () => {
    const file = (imageInput as HTMLInputElement).files?.[0];
    const note = state.notes.find((item) => item.id === state.currentNoteId);
    if (file && note)
      uploadFileIntoNote(
        note.id,
        editor,
        null,
        file,
        imageCursor,
        noteAssetBase(note),
      );
    (imageInput as HTMLInputElement).value = "";
  });
  blockEditor?.addEventListener("paste", (event) => {
    const file = transferredNoteFile((event as ClipboardEvent).clipboardData?.files);
    const note = state.notes.find((item) => item.id === state.currentNoteId);
    if (!file || !note) return;
    event.preventDefault();
    uploadFileIntoNote(
      note.id,
      editor,
      null,
      file,
      markdownBlockSourceOffset(blockEditor, event.target),
      noteAssetBase(note),
    );
  });
  blockEditor?.addEventListener("dragover", (event) => {
    if (transferredNoteFile((event as DragEvent).dataTransfer?.files)) {
      event.preventDefault();
      (event as DragEvent).dataTransfer.dropEffect = "copy";
      blockEditor.classList.add("is-file-drop");
    }
  });
  blockEditor?.addEventListener("dragleave", (event) => {
    if (!blockEditor.contains((event as FocusEvent).relatedTarget as Node))
      blockEditor.classList.remove("is-file-drop");
  });
  blockEditor?.addEventListener("drop", (event) => {
    const file = transferredNoteFile((event as DragEvent).dataTransfer?.files);
    const note = state.notes.find((item) => item.id === state.currentNoteId);
    if (!file || !note) return;
    event.preventDefault();
    blockEditor.classList.remove("is-file-drop");
    uploadFileIntoNote(
      note.id,
      editor,
      null,
      file,
      markdownBlockSourceOffset(
        blockEditor,
        (event.target as HTMLElement).closest(".markdown-block")?.querySelector(
          ".markdown-block-input",
        ),
      ),
      noteAssetBase(note),
    );
  });
  if (freshSecondary) bindSecondaryResource(freshSecondary);
  bindNotesResizers(root);
  root
    ?.querySelectorAll('.workspace-pane-stack:not([data-workspace-bound="true"]) [data-pane-drop]')
    .forEach((pane) =>
      pane.addEventListener("pointerdown", () =>
        markActiveNotePane((pane as HTMLElement).dataset.paneDrop, root),
      ),
    );
  markActiveNotePane(state.activeNotePane, root);
  root
    ?.querySelectorAll('.workspace-pane-stack:not([data-workspace-bound="true"])')
    .forEach((pane) => {
      (pane as HTMLElement).dataset.workspaceBound = "true";
    });
}

function bindNotesResizers(root) {
  const layout = root?.querySelector(".notes-layout");
  const sidebarHandle = root?.querySelector(".notes-sidebar-resizer");
  const workbench = root?.querySelector(".note-editor .markdown-workbench");
  const splitHandle = root?.querySelector(".note-editor .note-split-resizer");
  const secondaryWorkbench = root?.querySelector(
    ".secondary-markdown-workbench",
  );
  const secondarySplitHandle = root?.querySelector(
    ".secondary-note-split-resizer",
  );
  const workspace = root?.querySelector(".notes-main-workspace.with-secondary");
  const workspaceHandle = root?.querySelector(".note-workspace-resizer");

  const bindHandle = (handle, move, reset, keyboard) => {
    if (!handle || handle.dataset.resizeBound === "true") return;
    handle.dataset.resizeBound = "true";
    const stop = () => {
      document.body.classList.remove("resizing-notes");
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
    };
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      document.body.classList.add("resizing-notes");
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", stop);
    });
    handle.addEventListener("dblclick", reset);
    handle.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      keyboard(event.key === "ArrowRight" ? 1 : -1);
    });
  };

  const setSidebarWidth = (width) => {
    if (!layout || !sidebarHandle) return;
    const maxWidth = Math.min(520, Math.max(230, layout.clientWidth - 380));
    state.noteSidebarWidth = Math.round(
      Math.max(230, Math.min(maxWidth, width)),
    );
    layout.style.setProperty(
      "--notes-sidebar-width",
      `${state.noteSidebarWidth}px`,
    );
    sidebarHandle.setAttribute("aria-valuenow", String(state.noteSidebarWidth));
  };
  bindHandle(
    sidebarHandle,
    (event) =>
      setSidebarWidth(event.clientX - layout.getBoundingClientRect().left),
    () => setSidebarWidth(340),
    (direction) => setSidebarWidth(state.noteSidebarWidth + direction * 20),
  );

  const setSplitPercent = (percent) => {
    if (!workbench || !splitHandle) return;
    state.noteSplitPercent = Math.round(Math.max(25, Math.min(75, percent)));
    workbench.style.setProperty(
      "--note-editor-left",
      `${state.noteSplitPercent}%`,
    );
    splitHandle.setAttribute("aria-valuenow", String(state.noteSplitPercent));
  };
  bindHandle(
    splitHandle,
    (event) => {
      const bounds = workbench.getBoundingClientRect();
      setSplitPercent(((event.clientX - bounds.left) / bounds.width) * 100);
    },
    () => setSplitPercent(50),
    (direction) => setSplitPercent(state.noteSplitPercent + direction * 2),
  );

  const setSecondarySplitPercent = (percent) => {
    if (!secondaryWorkbench || !secondarySplitHandle) return;
    state.secondaryNoteSplitPercent = Math.round(
      Math.max(25, Math.min(75, percent)),
    );
    secondaryWorkbench.style.setProperty(
      "--note-editor-left",
      `${state.secondaryNoteSplitPercent}%`,
    );
    secondarySplitHandle.setAttribute(
      "aria-valuenow",
      String(state.secondaryNoteSplitPercent),
    );
  };
  bindHandle(
    secondarySplitHandle,
    (event) => {
      const bounds = secondaryWorkbench.getBoundingClientRect();
      setSecondarySplitPercent(
        ((event.clientX - bounds.left) / bounds.width) * 100,
      );
    },
    () => setSecondarySplitPercent(50),
    (direction) =>
      setSecondarySplitPercent(state.secondaryNoteSplitPercent + direction * 2),
  );

  const setWorkspaceSplit = (percent) => {
    if (!workspace || !workspaceHandle) return;
    state.noteWorkspaceSplitPercent = Math.round(
      Math.max(25, Math.min(75, percent)),
    );
    workspace.style.setProperty(
      "--note-workspace-left",
      `${state.noteWorkspaceSplitPercent}%`,
    );
    workspaceHandle.setAttribute(
      "aria-valuenow",
      String(state.noteWorkspaceSplitPercent),
    );
  };
  bindHandle(
    workspaceHandle,
    (event) => {
      const bounds = workspace.getBoundingClientRect();
      setWorkspaceSplit(((event.clientX - bounds.left) / bounds.width) * 100);
    },
    () => setWorkspaceSplit(50),
    (direction) =>
      setWorkspaceSplit(state.noteWorkspaceSplitPercent + direction * 2),
  );
}

export async function rerenderNotesContext(_projectId = null) {
  const currentTree = document.querySelector("#notes-tree");
  if (currentTree) state.noteTreeScrollTop = currentTree.scrollTop;
  await flushWorkspaceMarkdownSaves();
  renderNotes();
}

function noteLinkCandidates(query = "") {
  const normalized = query.trim().toLocaleLowerCase();
  return state.notes
    .filter((note) => note.id !== state.currentNoteId)
    .filter(
      (note) =>
        !normalized ||
        `${note.title} ${noteContextLabel(note)}`
          .toLocaleLowerCase()
          .includes(normalized),
    )
    .sort((left, right) =>
      left.title.localeCompare(right.title, undefined, { sensitivity: "base" }),
    )
    .slice(0, 12);
}

function renderNoteLinkResults() {
  const input = document.querySelector("#note-link-search");
  const results = document.querySelector("#note-link-results");
  if (!input || !results) return;
  const notes = noteLinkCandidates((input as HTMLInputElement).value);
  results.innerHTML = notes.length
    ? notes
        .map(
          (note) =>
            `<button type="button" class="note-link-result" data-insert-note-link="${note.id}"><span>${note.paper_id ? "▤" : "✎"}</span><div><strong>${escapeHtml(note.title)}</strong><small>${escapeHtml(noteContextLabel(note))}</small></div></button>`,
        )
        .join("")
    : `<div class="note-link-empty">No notes found.</div>`;
}

function openNoteLinkPicker(start = null, end = null, query = "") {
  const blockEditor = document.querySelector("#note-block-editor");
  const editor = currentMarkdownBlockInput(blockEditor, true);
  const picker = document.querySelector("#note-link-picker");
  const input = document.querySelector("#note-link-search");
  if (!editor || !picker || !input) return;
  const insertionStart = start ?? editor.selectionStart;
  editorSession.noteLinkRange = {
    noteId: state.currentNoteId,
    blockIndex: Number(
      editor.closest<HTMLElement>("[data-markdown-block]")?.dataset.markdownBlock || 0,
    ),
    start: insertionStart,
    end: end ?? insertionStart,
  };
  picker.classList.remove("hidden");
  (input as HTMLInputElement).value = query;
  renderNoteLinkResults();
  (input as HTMLElement).focus();
  (input as HTMLInputElement).select();
}

function closeNoteLinkPicker(refocusEditor = false) {
  document.querySelector("#note-link-picker")?.classList.add("hidden");
  const editor = currentMarkdownBlockInput(
    document.querySelector("#note-block-editor"),
  );
  editorSession.noteLinkRange = null;
  if (refocusEditor) editor?.focus();
}

function insertNoteLink(noteId) {
  const blockEditor = document.querySelector("#note-block-editor");
  const editor = blockEditor?.querySelector(
    `[data-markdown-block="${editorSession.noteLinkRange?.blockIndex}"] .markdown-block-input`,
  );
  const note = state.notes.find((item) => item.id === Number(noteId));
  if (
    !editor ||
    !note ||
    !editorSession.noteLinkRange ||
    editorSession.noteLinkRange.noteId !== state.currentNoteId
  )
    return closeNoteLinkPicker();
  const label = note.title.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
  const markdown = `[${label}](#note-${note.id})`;
  (editor as HTMLInputElement).setRangeText(markdown, editorSession.noteLinkRange.start, editorSession.noteLinkRange.end, "end");
  closeNoteLinkPicker();
  (editor as HTMLElement).focus();
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

export function applyMarkdownToEditor(editor, action, preview = null, assetBase = "") {
  if (!editor) return;
  if (editor.kavotCommand) { editor.kavotCommand(action); return; }
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const selected = editor.value.slice(start, end);
  const wrappers = {
    bold: ["**", "**"],
    italic: ["*", "*"],
    strike: ["~~", "~~"],
    code: ["`", "`"],
    link: ["[", "](https://)"],
  };
  let replacement;
  let cursorStart;
  let cursorEnd;
  if (wrappers[action]) {
    const [before, after] = wrappers[action];
    replacement = `${before}${selected || "texte"}${after}`;
    cursorStart = start + before.length;
    cursorEnd = cursorStart + (selected || "texte").length;
  } else {
    const prefixes = {
      heading: "## ",
      list: "- ",
      task: "- [ ] ",
      quote: "> ",
    };
    const prefix = prefixes[action] || "";
    replacement = (selected || "texte")
      .split("\n")
      .map((line) => `${prefix}${line}`)
      .join("\n");
    cursorStart = start + prefix.length;
    cursorEnd = start + replacement.length;
  }
  editor.setRangeText(replacement, start, end, "end");
  editor.setSelectionRange(cursorStart, cursorEnd);
  editor.focus();
  if (preview) preview.innerHTML = renderMarkdown(editor.value, assetBase);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function applyMarkdownAction(action) {
  applyMarkdownToEditor(
    currentMarkdownBlockInput(
      document.querySelector("#note-block-editor"),
      true,
    ),
    action,
  );
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

function setNoteAutosaveState(message, stateName = "") {
  const indicator = document.querySelector("#note-autosave-state");
  if (!indicator) return;
  indicator.textContent = message;
  (indicator as HTMLElement).dataset.state = stateName;
}

async function persistNoteContent(noteId, content, version, notify = false) {
  try {
    setNoteAutosaveState("Saving…", "saving");
    const updated = await writeNoteContent(noteId, content);
    const cached = state.notes.find((item) => item.id === noteId);
    if (cached) Object.assign(cached, updated);
    if (version === editorSession.noteAutosaveVersion && state.currentNoteId === noteId)
      setNoteAutosaveState("Saved automatically", "saved");
    if (notify) toast("Note saved");
    return updated;
  } catch (error) {
    setNoteAutosaveState("Save failed", "error");
    toast(error.message, "error");
    return null;
  }
}

export async function persistNoteTitle(noteId, input) {
  const title = input?.value.trim();
  const note = state.notes.find((item) => item.id === Number(noteId));
  if (!input || !note || !title) {
    if (input && note) input.value = note.title;
    return null;
  }
  if (title === note.title) return note;
  const indicator = input
    .closest(".note-pane")
    ?.querySelector(".note-autosave-state");
  if (indicator) {
    indicator.textContent = "Renommage…";
    indicator.dataset.state = "saving";
  }
  try {
    const updated = await api(`/notes/${noteId}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    });
    Object.assign(note, updated);
    document
      .querySelectorAll(`[data-note-title-input="${noteId}"]`)
      .forEach((item) => {
        if (item !== input) (item as HTMLInputElement).value = updated.title;
      });
    if (indicator) {
      indicator.textContent = "Saved automatically";
      indicator.dataset.state = "saved";
    }
    refreshWorkspaceTreeOnly().catch(() => {});
    return updated;
  } catch (error) {
    input.value = note.title;
    if (indicator) {
      indicator.textContent = "Rename failed";
      indicator.dataset.state = "error";
    }
    toast(error.message, "error");
    return null;
  }
}

function bindNoteTitleInputs(root) {
  root?.querySelectorAll("[data-note-title-input]").forEach((input) => {
    const noteId = Number(input.dataset.noteTitleInput);
    const flush = () => {
      const timer = noteTitleTimers.get(noteId);
      if (timer) clearTimeout(timer);
      noteTitleTimers.delete(noteId);
      return persistNoteTitle(noteId, input);
    };
    input.addEventListener("input", () => {
      const pending = noteTitleTimers.get(noteId);
      if (pending) clearTimeout(pending);
      noteTitleTimers.set(noteId, setTimeout(flush, 650));
    });
    input.addEventListener("blur", flush);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        const current = state.notes.find((item) => item.id === noteId);
        if (current) input.value = current.title;
        input.blur();
      }
    });
    if (state.focusNoteTitleId === noteId) {
      state.focusNoteTitleId = null;
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    }
  });
}

function bindNoteTemplatePickers(root) {
  root?.querySelectorAll(".note-pane").forEach((pane) => {
    if (pane.closest('[data-workspace-bound="true"]')) return;
    const noteId = Number(
      pane.dataset.primaryNoteId || pane.dataset.secondaryNoteId || 0,
    );
    if (!noteId) return;
    const picker = pane.querySelector(".note-template-picker");
    const editor = pane.querySelector("textarea.note-content");
    const blockEditor = pane.querySelector(".markdown-block-editor");
    pane
      .querySelector("[data-note-template-toggle]")
      ?.addEventListener("click", () => picker?.classList.toggle("hidden"));
    pane
      .querySelector("[data-close-note-template]")
      ?.addEventListener("click", () => picker?.classList.add("hidden"));
    pane.querySelectorAll("[data-apply-note-template]").forEach((button) =>
      button.addEventListener("click", async () => {
        const secondary = Boolean(pane.dataset.secondaryNoteId);
        if (secondary) await flushSecondaryNoteAutosave();
        else await flushCurrentNoteAutosave();
        button.disabled = true;
        try {
          const updated = await api(
            `/notes/${noteId}/template/${button.dataset.applyNoteTemplate}`,
            {
              method: "POST",
              body: JSON.stringify({
                mode: button.dataset.templateMode,
                cursor: markdownBlockSourceOffset(blockEditor),
              }),
            },
          );
          const cached = state.notes.find((item) => item.id === noteId);
          if (cached) Object.assign(cached, updated);
          setMarkdownBlockEditorContent(
            blockEditor,
            editor,
            updated.content,
            noteAssetBase(updated),
            0,
          );
          pane
            .querySelectorAll(`[data-note-title-input="${noteId}"]`)
            .forEach((input) => {
              input.value = updated.title;
            });
          updateMarkdownDocumentStats(editor);
          picker?.classList.add("hidden");
          const indicator = pane.querySelector(".note-autosave-state");
          if (indicator) {
            indicator.textContent = "Template applied · saved";
            indicator.dataset.state = "saved";
          }
          refreshWorkspaceTreeOnly().catch(() => {});
          currentMarkdownBlockInput(blockEditor)?.focus();
          toast(
            button.dataset.templateMode === "insert"
              ? "Template inserted into note"
              : "Template applied to note",
          );
        } catch (error) {
          toast(error.message, "error");
        } finally {
          button.disabled = false;
        }
      }),
    );
  });
}

function queueCurrentNoteAutosave() {
  const editor = document.querySelector("#note-content");
  if (!editor || !state.currentNoteId) return;
  clearTimeout(editorSession.noteAutosaveTimer);
  editorSession.noteAutosaveVersion += 1;
  const version = editorSession.noteAutosaveVersion;
  const noteId = state.currentNoteId;
  setNoteAutosaveState("Unsaved changes…", "pending");
  editorSession.noteAutosaveTimer = setTimeout(() => {
    editorSession.noteAutosaveTimer = null;
    persistNoteContent(noteId, (editor as HTMLInputElement).value, version);
  }, 650);
}

export async function flushCurrentNoteAutosave(notify = false) {
  const editor = document.querySelector("#note-content");
  if (!editor || !state.currentNoteId) return null;
  if (!editorSession.noteAutosaveTimer && !notify) return noteWrites.get(state.currentNoteId)?.catch(() => null) || null;
  clearTimeout(editorSession.noteAutosaveTimer);
  editorSession.noteAutosaveTimer = null;
  editorSession.noteAutosaveVersion += 1;
  return persistNoteContent(
    state.currentNoteId,
    (editor as HTMLInputElement).value,
    editorSession.noteAutosaveVersion,
    notify,
  );
}

export async function saveCurrentNote() {
  return flushCurrentNoteAutosave(true);
}
