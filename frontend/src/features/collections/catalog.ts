import { openCollectionInNotes } from './noteEditor';
import { state } from '../../app/state';
import { navigate, toast } from '../../app/navigation';
import { paperPdfUploadModal, previewPaperPdfModal } from '../library/documents';
import { newTaskModal } from '../tasks/dialogs';

/** The items of the workspace a note, a canvas or a script can point to: notes, articles and tasks.
 * (The name "collection" stays in the drag payloads and links already stored in notes and canvases.) */

function collectionDatabaseDefinitions() {
  return (state.databases || []).filter((database) => database.id !== "notes");
}

export function collectionItems(databaseId) {
  if (databaseId === "notes")
    return state.notes.filter(note => !note.trashed_at).map(note => ({
      id: note.id, type: "note", databaseId, title: note.title,
      detail: note.content || "", meta: note.template_name || "Note", source: note,
    }));
  if (databaseId === "articles")
    return state.papers.map((paper) => ({
      id: paper.id,
      type: "paper",
      databaseId,
      title: paper.title,
      detail: (paper.authors || []).join(", ") || paper.publication || "Article",
      meta: paper.status || "to read",
      source: paper,
    }));
  if (databaseId === "tasks")
    return state.tasks.map((task) => ({
      id: task.id,
      type: "task",
      databaseId,
      title: task.title,
      detail: task.project_name || task.description || "General task",
      meta: task.status || "todo",
      source: task,
    }));
  return [];
}

export function collectionDragPayload(type, id, databaseId = "") {
  return `collection:${encodeURIComponent(JSON.stringify({ type, id, databaseId }))}`;
}

export function parseCollectionDragPayload(value) {
  if (!String(value || "").startsWith("collection:")) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(String(value).slice(11)));
    if (!parsed?.type || parsed.id == null) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

export function collectionItemCanvasPayload(item, _representation = "note") {
  if (!item) return null;
  if (item.type === "note") return {
    type: "note", noteId: item.id, templateId: item.source.template_id,
    title: item.title, color: item.source.template_color,
  };
  if (item.type === "paper") {
    const paper = item.source;
    return {
      type: paper.file_path ? "pdf" : "paper",
      paperId: Number(paper.id),
      collectionType: "paper",
      recordId: Number(paper.id),
      title: paper.title,
      detail: (paper.authors || []).join(", ") || paper.publication || "Article",
      url: paper.file_path ? `/api/papers/${paper.id}/file` : paper.url || "",
    };
  }
  const source = item.source || {};
  return {
    type: item.type,
    collectionType: item.type,
    databaseId: item.databaseId,
    recordId: item.id,
    title: item.title,
    detail: item.detail,
    status: source.status || "",
    projectIds: source.project_ids || (source.project_id ? [source.project_id] : []),
    url: source.url || "",
  };
}

export function findCollectionItem(reference) {
  if (!reference) return null;
  const databaseId = reference.databaseId || {
    note: "notes",
    paper: "articles",
    task: "tasks",
  }[reference.type];
  return collectionItems(databaseId).find(
    (item) => item.type === reference.type && String(item.id) === String(reference.id),
  ) || null;
}

/** Opens an item: as a tab of the editor from the notes, otherwise in its own dialog (a task) or its PDF (an article). */
export function openCollectionItem(reference) {
  if (state.view === "notes") return openCollectionInNotes(reference);
  const item = findCollectionItem(reference);
  if (!item) return toast("Item not found", "error");
  if (item.type === "paper")
    return item.source.file_path
      ? previewPaperPdfModal(Number(item.id))
      : paperPdfUploadModal(Number(item.id));
  if (item.type === "task") return newTaskModal(null, null, Number(item.id));
  return openCollectionInNotes(reference);
}

/** Opens the page of a kind of item (older "#collection/<id>" links). */
export async function openCollectionDatabase(databaseId, options: { newTab?: boolean; beside?: boolean } = {}) {
  if (databaseId === "notes") return navigate("notes");
  const database = collectionDatabaseDefinitions().find(
    (item) => item.id === databaseId,
  );
  if (!database) return toast("Not found", "error");
  const view = { articles: "papers", tasks: "tasks" }[databaseId] || "notes";
  return navigate(view, options);
}


