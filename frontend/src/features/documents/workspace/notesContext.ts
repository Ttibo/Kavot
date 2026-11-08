import { escapeHtml, state } from '../../../app/state';

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

export function notesForContext(projectId = null) {
  if (!projectId) {
    if (state.noteScope.startsWith("project:"))
      return notesForContext(Number(state.noteScope.split(":")[1]));
    return state.notes.filter((note) => noteMatchesScope(note));
  }
  return state.notes.filter(
    (note) => note.project_id === Number(projectId) && !note.paper_id,
  );
}

export function foldersForContext(projectId = null) {
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

export function filterNotesByFolder(notes, folders, projectId = null) {
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
