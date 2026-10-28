/** Collection view model: fields, configuration, filtering, sorting and kanban moves (no DOM). */
import { state } from "../../../app/state";
import { api } from "../../../services/api";
import { refreshState } from "../../../app/navigation";
import { collectionItems } from "../../collections/catalog";
import { fold, plainText } from "./shared";

export type Layout = "table" | "list" | "gallery" | "kanban";
export type FilterOp = "contains" | "equals" | "not" | "empty" | "notEmpty" | "gt" | "lt";
export type ViewFilter = { field: string; op: FilterOp; value: string };
export type ViewConfig = {
  title: string;
  fields: string[];
  filters: ViewFilter[];
  /** Hand-picked items (see itemRef); when set, the view shows only these, in this order unless sorted. */
  items: string[];
  match: "all" | "any";
  sort: { field: string; dir: "asc" | "desc" } | null;
  groupBy: string;
  cover: string;
  limit: number;
  search: boolean;
  wrap: boolean;
};
export type CollectionAttrs = { collection: string; layout: Layout; config: ViewConfig };
export type ViewRow = { item: any; title: string; fields: Record<string, unknown> };

export const layouts: [Layout, string][] = [["table", "Table"], ["list", "List"], ["gallery", "Gallery"], ["kanban", "Kanban"]];
export const operators: [FilterOp, string][] = [
  ["contains", "contains"], ["equals", "is"], ["not", "is not"], ["empty", "is empty"], ["notEmpty", "is not empty"],
  ["gt", "greater than / after"], ["lt", "less than / before"],
];

const fieldLabels: Record<string, string> = {
  "@detail": "Preview", "@meta": "Status", title: "Title", name: "Name", status: "Status", priority: "Priority", column: "Column",
  project: "Project", due_date: "Due", start_date: "Start", labels: "Labels", authors: "Authors", year: "Year",
  publication: "Publication", url: "Link", starts_at: "Starts", ends_at: "Ends", location: "Location", acronym: "Acronym",
  edition: "Edition", access_status: "Access", license: "License", description: "Description", updated_at: "Updated",
  created_at: "Created", tags: "Tags", doi: "DOI", venue: "Venue", template_name: "Template", folder: "Folder", rating: "Rating",
  archived_at: "Archived",
};
/** Internal or bulky fields never offered as view columns. */
const hiddenFields = new Set([
  "id", "content", "content_hash", "content_format", "document_uid", "note_id", "note_path", "note_trashed", "drawing",
  "drawing_preview", "project_id", "column_id", "folder_id", "template_id", "paper_id", "resource_id", "file_path",
  "source_image_path", "linked_note_ids", "project_ids", "dataset_ids", "conference_ids", "position", "template_color",
  "template_icon", "zotero_key", "zotero_folder_ids", "abstract", "notes", "body", "system_kind", "legacy_id", "revision",
  "trashed_at", "article_pdf_links_version",
]);
const preferredFields: Record<string, string[]> = {
  tasks: ["column", "priority", "due_date", "project"],
  articles: ["authors", "year", "status"],
  notes: ["@detail", "updated_at"],
  conferences: ["status", "starts_at", "location"],
  datasets: ["access_status", "version", "license"],
};
const preferredGroup: Record<string, string> = { tasks: "column", articles: "status", conferences: "status", datasets: "access_status", notes: "folder" };

export const fieldLabel = (key: string) =>
  fieldLabels[key] || key.replace(/^@/, "").replace(/[_-]+/g, " ").replace(/^\w/, c => c.toUpperCase());

/** Stable reference of an item inside its collection. */
export const itemRef = (item) => `${item.type}:${item.id}`;

export const asText = (value: unknown) => Array.isArray(value) ? value.join(", ") : value == null ? "" : String(value);

const asNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && String(value).trim() !== "" ? number : null;
};

/** Displayable fields of a collection item, with names resolved for ids (column, project, folder). */
export function itemFields(item): Record<string, unknown> {
  const source = item.type === "record" ? item.source?.values || {} : item.source || {};
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

export function activeItems(collection: string) {
  try {
    return collectionItems(collection).filter(item => !item.source?.trashed_at && !item.source?.archived_at);
  } catch {
    return [];
  }
}

export function availableFields(collection: string) {
  const keys = new Set<string>();
  for (const item of activeItems(collection).slice(0, 200)) Object.keys(itemFields(item)).forEach(key => keys.add(key));
  const derivedFirst = (a: string, b: string) => (a.startsWith("@") ? -1 : 0) - (b.startsWith("@") ? -1 : 0);
  return [...keys]
    .filter(key => !["title", "name"].includes(key) || collection === "notes")
    .sort((a, b) => derivedFirst(a, b) || fieldLabel(a).localeCompare(fieldLabel(b)));
}

export function defaultConfig(collection: string): ViewConfig {
  const fields = availableFields(collection);
  const preferred = (preferredFields[collection] || []).filter(key => fields.includes(key));
  const chosen = preferred.length ? preferred : fields.filter(key => !key.startsWith("@")).slice(0, 3);
  let groupBy = fields.includes(preferredGroup[collection]) ? preferredGroup[collection] : "";
  if (!groupBy) {
    // Otherwise group by the first field with a handful of distinct values.
    const items = activeItems(collection);
    groupBy = fields.find(key => {
      const values = new Set(items.map(item => String(itemFields(item)[key] ?? "")));
      return !key.startsWith("@") && values.size > 1 && values.size <= 8;
    }) || "";
  }
  return {
    title: "", fields: chosen.length ? chosen : ["@detail"], filters: [], items: [], match: "all", sort: null,
    groupBy, cover: "", limit: 50, search: true, wrap: false,
  };
}

export function parseConfig(value: string | null, collection: string): ViewConfig {
  const base = defaultConfig(collection);
  try {
    const parsed = JSON.parse(value || "{}");
    return {
      ...base,
      ...parsed,
      fields: Array.isArray(parsed.fields) ? parsed.fields.map(String).slice(0, 20) : base.fields,
      filters: Array.isArray(parsed.filters) ? parsed.filters.filter(f => f && typeof f.field === "string").slice(0, 20) : [],
      items: Array.isArray(parsed.items) ? parsed.items.map(String).slice(0, 500) : [],
      limit: Math.min(Math.max(Number(parsed.limit) || base.limit, 1), 500),
    };
  } catch {
    return base;
  }
}

export function serializeCollection(attrs: CollectionAttrs) {
  return { collection: attrs.collection, layout: attrs.layout, config: JSON.stringify(attrs.config) };
}

function matches(row: ViewRow, filter: ViewFilter) {
  const raw = filter.field === "title" ? row.title : row.fields[filter.field];
  const text = fold(asText(raw));
  const value = fold(filter.value || "");
  const listHas = () => Array.isArray(raw) && raw.some(entry => fold(String(entry)) === value);
  switch (filter.op) {
    case "contains": return text.includes(value);
    case "equals": return Array.isArray(raw) ? listHas() : text === value;
    case "not": return Array.isArray(raw) ? !listHas() : text !== value;
    case "empty": return !text;
    case "notEmpty": return !!text;
    case "gt":
    case "lt": {
      const a = asNumber(raw), b = asNumber(filter.value);
      const comparison = a != null && b != null ? a - b : text.localeCompare(value);
      return text !== "" && (filter.op === "gt" ? comparison > 0 : comparison < 0);
    }
  }
  return true;
}

function compareValues(x: unknown, y: unknown) {
  const nx = asNumber(x), ny = asNumber(y);
  return nx != null && ny != null ? nx - ny : asText(x).localeCompare(asText(y), undefined, { numeric: true, sensitivity: "base" });
}

/** Items of the view after filters, quick search and sort. */
export function viewItems(attrs: CollectionAttrs, query = ""): ViewRow[] {
  const { config } = attrs;
  const terms = fold(query.trim()).split(/\s+/).filter(Boolean);
  let rows: ViewRow[] = activeItems(attrs.collection).map(item => ({ item, title: String(item.title ?? ""), fields: itemFields(item) }));
  if (config.items.length) {
    const order = new Map(config.items.map((ref, index) => [ref, index]));
    rows = rows.filter(row => order.has(itemRef(row.item))).sort((a, b) => order.get(itemRef(a.item))! - order.get(itemRef(b.item))!);
  }
  if (config.filters.length) {
    rows = rows.filter(row => config.match === "any"
      ? config.filters.some(filter => matches(row, filter))
      : config.filters.every(filter => matches(row, filter)));
  }
  if (terms.length) {
    rows = rows.filter(row => {
      const haystack = fold(`${row.title} ${Object.values(row.fields).map(asText).join(" ")}`);
      return terms.every(term => haystack.includes(term));
    });
  }
  if (config.sort?.field) {
    const { field, dir } = config.sort;
    const valueOf = (row: ViewRow) => field === "title" ? row.title : row.fields[field];
    rows.sort((a, b) => {
      const x = valueOf(a), y = valueOf(b);
      // Empty values always go last, whatever the direction.
      if (!asText(x) !== !asText(y)) return asText(x) ? -1 : 1;
      const comparison = compareValues(x, y);
      return dir === "desc" ? -comparison : comparison;
    });
  }
  return rows;
}

/** Ordered kanban lanes: task columns first (in board order), then values as they appear, empty last. */
export function groupValues(attrs: CollectionAttrs, rows: ViewRow[]) {
  const key = attrs.config.groupBy;
  const ordered: string[] = [];
  if (attrs.collection === "tasks" && key === "column")
    ordered.push(...[...state.taskColumns].sort((a, b) => a.position - b.position).map(c => c.name));
  const seen = new Set(ordered);
  for (const row of rows) {
    const raw = row.fields[key];
    const values = Array.isArray(raw) ? (raw.length ? raw.map(String) : [""]) : [asText(raw)];
    for (const value of values) if (!seen.has(value)) { seen.add(value); ordered.push(value); }
  }
  return ordered.sort((a, b) => (a === "" ? 1 : 0) - (b === "" ? 1 : 0));
}

export function rowInLane(row: ViewRow, key: string, lane: string) {
  const raw = row.fields[key];
  if (Array.isArray(raw)) return raw.length ? raw.map(String).includes(lane) : lane === "";
  return asText(raw) === lane;
}

/** Persist a kanban move when the collection supports editing that field. */
export async function moveCard(reference: { type: string; id: unknown; databaseId: string }, field: string, value: string) {
  const item = collectionItems(reference.databaseId).find(i => i.type === reference.type && String(i.id) === String(reference.id));
  if (!item) throw new Error("Item not found.");
  const readOnly = new Error("This field cannot be changed from the kanban.");
  if (field.startsWith("@")) throw readOnly;
  if (item.type === "task") {
    if (!["column", "priority", "status"].includes(field)) throw readOnly;
    const body = field === "column" ? { column_id: state.taskColumns.find(c => c.name === value)?.id } : { [field]: value || null };
    if (field === "column" && !body.column_id) throw new Error("Unknown column.");
    await api(`/tasks/${item.id}`, { method: "PATCH", body: JSON.stringify(body) });
    return refreshState(["tasks"]);
  }
  if (item.type === "paper" && field === "status") {
    await api(`/papers/${item.id}`, { method: "PATCH", body: JSON.stringify({ status: value }) });
    return refreshState(["papers"]);
  }
  if ((item.type === "conference" && field === "status") || (item.type === "dataset" && field === "access_status")) {
    await api(`/${reference.databaseId}/${item.id}`, { method: "PATCH", body: JSON.stringify({ ...item.source, [field]: value }) });
    return refreshState([reference.databaseId as "conferences" | "datasets"]);
  }
  if (item.type === "record") {
    const current = item.source.values?.[field];
    const next = Array.isArray(current) ? (value ? [value] : [])
      : typeof current === "number" ? Number(value)
      : typeof current === "boolean" ? value === "true"
      : value;
    await api(`/databases/${reference.databaseId}/records/${item.id}`, {
      method: "PATCH", body: JSON.stringify({ values: { ...item.source.values, [field]: next } }),
    });
    return refreshState(["databases"]);
  }
  throw readOnly;
}
