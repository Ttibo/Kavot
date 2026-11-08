/** The workspace data a note script reads through `kavot.items()`: notes, articles and tasks. */
import { state } from "../../../app/state";
import { collectionItems } from "../../collections/catalog";
import { plainText } from "./shared";

/** Internal or bulky fields a script does not need. */
const hiddenFields = new Set([
  "id", "content", "content_hash", "content_format", "document_uid", "note_id", "note_path", "note_trashed", "drawing",
  "drawing_preview", "project_id", "column_id", "folder_id", "template_id", "paper_id", "resource_id", "file_path",
  "source_image_path", "linked_note_ids", "project_ids", "position", "template_color",
  "template_icon", "zotero_key", "zotero_folder_ids", "abstract", "notes", "body", "system_kind", "legacy_id", "revision",
  "trashed_at", "article_pdf_links_version",
]);

/** Readable fields of an item, with names resolved for ids (column, project, folder). */
export function itemFields(item): Record<string, unknown> {
  const source = item.source || {};
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (hiddenFields.has(key)) continue;
    const scalar = value == null || ["string", "number", "boolean"].includes(typeof value);
    const scalarList = Array.isArray(value) && value.every(v => v == null || typeof v !== "object");
    if (scalar || scalarList) fields[key] = value;
  }
  if (item.type === "task") {
    fields.column = state.taskColumns.find(c => c.id === source.column_id)?.name || "";
    fields.project = state.projects.find(p => p.id === source.project_id)?.name || source.project_name || "";
  }
  if (Array.isArray(source.project_ids) && source.project_ids.length)
    fields.project = source.project_ids.map(id => state.projects.find(p => p.id === id)?.name).filter(Boolean).join(", ");
  if (item.type === "note") fields.folder = state.noteFolders?.find(f => f.id === source.folder_id)?.name || "";
  fields["@detail"] = plainText(item.detail).slice(0, 220);
  fields["@meta"] = item.meta ?? "";
  return fields;
}

/** Items of a kind ("notes", "articles", "tasks"), without the trashed or archived ones. */
export function activeItems(kind: string) {
  try {
    return collectionItems(kind).filter(item => !item.source?.trashed_at && !item.source?.archived_at);
  } catch {
    return [];
  }
}
