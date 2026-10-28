import { flushCollectionSaves, openCollectionInNotes } from './noteEditor';
import { escapeHtml, state, truncate } from '../../app/state';
import { formatLibraryDate } from '../library/filters';
import { openModal } from '../../components/dialogs/controller';
import { navigate, toast } from '../../app/navigation';
import { paperPdfUploadModal, previewPaperPdfModal } from '../library/documents';
import { newTaskModal } from '../tasks/dialogs';
import { publish, showView } from '../../app/viewBridge';

/** Readable text of a note that may be stored as HTML, for previews. */
function plainText(value: unknown) {
  const text = String(value ?? "");
  if (!/<[a-z][\s\S]*>/i.test(text)) return text;
  return new DOMParser().parseFromString(text, "text/html").body.textContent?.replace(/\s+/g, " ").trim() || "";
}

export function collectionDatabaseDefinitions() {
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
  if (databaseId === "conferences")
    return state.conferences.map((conference) => ({
      id: conference.id,
      type: "conference",
      databaseId,
      title: conference.acronym || conference.name,
      detail: conference.name,
      meta: conference.starts_at || conference.status || "watching",
      source: conference,
    }));
  if (databaseId === "datasets")
    return state.datasets.map((dataset) => ({
      id: dataset.id,
      type: "dataset",
      databaseId,
      title: dataset.name,
      detail: dataset.description || dataset.url || "Dataset",
      meta: dataset.access_status || "available",
      source: dataset,
    }));
  return (state.databaseRecords?.[databaseId] || []).map((record) => {
    const values = record.values || {};
    return {
      id: record.id,
      type: "record",
      databaseId,
      title: values.title || values.name || values.subject || `Record ${String(record.id).slice(0, 8)}`,
      detail: plainText(values.content || values.description || values.body || values.from) || "Local record",
      meta: record.updated_at ? formatLibraryDate(record.updated_at) : "local",
      source: record,
    };
  });
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

export function collectionItemCanvasPayload(item, representation = "note") {
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
    status: source.status || source.access_status || "",
    projectIds: source.project_ids || (source.project_id ? [source.project_id] : []),
    url: source.url || source.values?.url || "",
  };
}

export function findCollectionItem(reference) {
  if (!reference) return null;
  const databaseId = reference.databaseId || {
    note: "notes",
    paper: "articles",
    task: "tasks",
    conference: "conferences",
    dataset: "datasets",
  }[reference.type];
  return collectionItems(databaseId).find(
    (item) => item.type === reference.type && String(item.id) === String(reference.id),
  ) || null;
}

function showGenericCollectionRecord(item) {
  const values = item?.source?.values || {};
  const fields = Object.entries(values)
    .map(([key, value]) => `<div class="collection-record-field"><small>${escapeHtml(key)}</small><p>${escapeHtml(Array.isArray(value) ? value.join(", ") : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value ?? ""))}</p></div>`)
    .join("");
  openModal(`<header class="modal-header"><h2>${escapeHtml(item?.title || "Record")}</h2><p>${escapeHtml(item?.databaseId || "Collection")}</p></header><div class="modal-body collection-record-detail">${fields || "<p>This record is empty.</p>"}<div class="form-actions"><button class="button" data-close-modal>Close</button></div></div>`, true);
}

const PAGE_VIEWS: Record<string, string> = { conference: "conferences", dataset: "datasets", record: "database" };

/** Opens an item in the side panel of its collection page, beside the list. */
export async function openCollectionPanel(reference) {
  const databaseId = reference.databaseId || { conference: "conferences", dataset: "datasets" }[reference.type];
  const next = { type: reference.type, id: reference.id, databaseId };
  if (!findCollectionItem(next)) return toast("Item not found", "error");
  await flushCollectionSaves();
  state.collectionPanel = next;
  publish();
}

export function openCollectionItem(reference) {
  // On the page of its collection, an item opens in the side panel; elsewhere it opens as a note.
  const page = PAGE_VIEWS[reference.type];
  if (page && state.view === page && (page !== "database" || state.collectionId === reference.databaseId)) return openCollectionPanel(reference);
  const custom = state.databases.some(database => database.id === reference.databaseId && database.storage?.driver === 'json-files');
  if (custom || state.view === "notes" || ["conference", "dataset"].includes(reference.type)) return openCollectionInNotes(reference);
  const item = findCollectionItem(reference);
  if (!item) return toast("Collection item not found", "error");
  if (item.type === "paper")
    return item.source.file_path
      ? previewPaperPdfModal(Number(item.id))
      : paperPdfUploadModal(Number(item.id));
  if (item.type === "task") return newTaskModal(null, null, Number(item.id));
  return showGenericCollectionRecord(item);
}

export function collectionItemRow(item, compact = false) {
  const payload = collectionDragPayload(item.type, item.id, item.databaseId);
  return `<div class="collection-item-row ${compact ? "compact" : ""}" draggable="true" data-collection-drag="${escapeHtml(payload)}"><span class="collection-item-grip" title="Drag to a project canvas">⠿</span><button data-collection-open="${escapeHtml(payload)}"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(truncate(item.detail || "", compact ? 52 : 130))}</small></button><i>${escapeHtml(item.meta || "")}</i>${compact ? "" : `<button data-workspace-row-menu aria-label="Actions de ${escapeHtml(item.title)}">•••</button>`}</div>`;
}

export async function openCollectionDatabase(databaseId) {
  if (databaseId === "notes") return navigate("notes");
  const database = collectionDatabaseDefinitions().find(
    (item) => item.id === databaseId,
  );
  if (!database) return toast("Database not found", "error");
  state.collectionId = databaseId;
  if (databaseId === "articles") return navigate("papers");
  if (databaseId === "tasks") return navigate("tasks");
  if (databaseId === "conferences") return navigate("conferences");
  if (databaseId === "datasets") return navigate("datasets");
  return navigate("database");
}

export function renderSidebarCollections() { publish(); }

export function renderDatabaseCollection() { showView("database"); }
