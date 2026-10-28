/** Collection views: rendering in four layouts, the editor node and the settings dialog. */
import { Node, mergeAttributes } from "@tiptap/core";
import { escapeHtml } from "../../../app/state";
import { toast } from "../../../app/navigation";
import { subscribe } from "../../../app/viewBridge";
import { openCollectionItem } from "../../collections/catalog";
import {
  activeItems, asText, availableFields, defaultConfig, fieldLabel, groupValues, itemFields, itemRef, layouts, moveCard, operators,
  parseConfig, rowInLane, serializeCollection, viewItems,
  type CollectionAttrs, type FilterOp, type Layout, type ViewRow,
} from "./collectionData";
import { collectionList, collectionName, deleteNode, dialogShell, embedIcon, fold, plainText, plural } from "./shared";

/* ---------------------------------------------------------------- Values */

const hue = (value: string) => [...value].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value);
const pillFields = new Set(["status", "priority", "column", "access_status", "@meta", "labels", "tags", "kind", "type"]);
const EMPTY = '<span class="kv-empty-value">—</span>';
const pill = (text: string) => `<span class="kv-pill" style="--pill-hue:${hue(text)}">${escapeHtml(text)}</span>`;
const isBlank = (value: unknown) => value == null || value === "" || (Array.isArray(value) && !value.length);

function formatValue(key: string, value: unknown) {
  if (isBlank(value)) return EMPTY;
  if (typeof value === "boolean") return value ? '<span class="kv-check" aria-label="Yes">✓</span>' : '<span class="kv-empty-value" aria-label="No">—</span>';
  if (Array.isArray(value)) return value.map(entry => pill(String(entry))).join(" ");
  const text = String(value);
  if (isDate(text)) {
    const date = new Date(text.length === 10 ? `${text}T12:00:00` : text);
    if (!Number.isNaN(date.getTime()))
      return `<time datetime="${escapeHtml(text)}">${date.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" })}</time>`;
  }
  if (pillFields.has(key) && text.length <= 40) return pill(text);
  if (/^https?:\/\//i.test(text)) return `<span class="kv-link">${escapeHtml(text.replace(/^https?:\/\/(www\.)?/i, "").slice(0, 60))}</span>`;
  return escapeHtml(text.length > 240 ? `${text.slice(0, 240)}…` : text);
}

/* --------------------------------------------------------------- Layouts */

const itemKey = (item) => JSON.stringify({ type: item.type, id: item.id, databaseId: item.databaseId });
const openAttribute = (row: ViewRow) => `data-open-item="${escapeHtml(itemKey(row.item))}"`;
const titleOf = (row: ViewRow) => escapeHtml(row.title || "Untitled");
const valueOf = (row: ViewRow, field: string) => field === "title" ? row.title : row.fields[field];

function propertyList(row: ViewRow, fields: string[]) {
  const entries = fields
    .filter(field => !isBlank(valueOf(row, field)))
    .map(field => `<div><dt>${escapeHtml(fieldLabel(field))}</dt><dd>${formatValue(field, valueOf(row, field))}</dd></div>`);
  return fields.length ? `<dl class="kv-props">${entries.join("")}</dl>` : "";
}

function tableLayout(rows: ViewRow[], fields: string[], wrap: boolean) {
  const head = `<tr><th scope="col">Title</th>${fields.map(field => `<th scope="col">${escapeHtml(fieldLabel(field))}</th>`).join("")}</tr>`;
  const body = rows.map(row => `<tr>
      <th scope="row"><button type="button" class="kv-title" ${openAttribute(row)}>${titleOf(row)}</button></th>
      ${fields.map(field => `<td>${formatValue(field, valueOf(row, field))}</td>`).join("")}
    </tr>`).join("");
  return `<div class="kv-table-wrap"><table class="kv-table${wrap ? " kv-wrap" : ""}"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

function listLayout(rows: ViewRow[], fields: string[]) {
  const inline = (row: ViewRow) => fields
    .filter(field => !isBlank(row.fields[field]))
    .map(field => `<span title="${escapeHtml(fieldLabel(field))}">${formatValue(field, row.fields[field])}</span>`).join("");
  return `<ul class="kv-list">${rows.map(row => `<li><button type="button" class="kv-list-row" ${openAttribute(row)}>
      <strong>${titleOf(row)}</strong><span class="kv-inline-props">${inline(row)}</span>
    </button></li>`).join("")}</ul>`;
}

function galleryLayout(rows: ViewRow[], fields: string[], coverField: string) {
  return `<div class="kv-gallery">${rows.map(row => {
    const cover = coverField ? asText(row.fields[coverField]) : "";
    const image = /^(https?:|data:image\/|\/api\/)/i.test(cover)
      ? `<img src="${escapeHtml(cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : `<span class="kv-cover-initial">${escapeHtml((row.title || "?").trim().charAt(0).toUpperCase())}</span>`;
    return `<button type="button" class="kv-card" ${openAttribute(row)}>
      <span class="kv-cover" style="--pill-hue:${hue(row.title)}">${image}</span><strong>${titleOf(row)}</strong>${propertyList(row, fields)}
    </button>`;
  }).join("")}</div>`;
}

function kanbanLayout(attrs: CollectionAttrs, rows: ViewRow[], fields: string[]) {
  const key = attrs.config.groupBy;
  // The lane already shows the grouping value, so cards leave it out.
  const cardFields = fields.filter(field => field !== key);
  return `<div class="kv-kanban">${groupValues(attrs, rows).map(lane => {
    const cards = rows.filter(row => rowInLane(row, key, lane));
    return `<section class="kv-lane" data-lane="${escapeHtml(lane)}" style="--pill-hue:${hue(lane || "∅")}">
      <header><span class="kv-lane-dot"></span><strong>${escapeHtml(lane || "No value")}</strong><small>${cards.length}</small></header>
      <div class="kv-lane-cards">${cards.map(row => `<button type="button" class="kv-card kv-kanban-card" draggable="true" data-card="${escapeHtml(itemKey(row.item))}" ${openAttribute(row)}>
        <strong>${titleOf(row)}</strong>${propertyList(row, cardFields)}
      </button>`).join("")}</div>
    </section>`;
  }).join("")}</div>`;
}

function renderBody(attrs: CollectionAttrs, query: string) {
  const { config, layout } = attrs;
  const all = viewItems(attrs, query);
  if (!all.length) {
    const message = activeItems(attrs.collection).length ? "No items match the filters." : "This collection is empty.";
    return { html: `<p class="kv-empty">${message}</p>`, count: 0 };
  }
  const rows = all.slice(0, config.limit);
  const fields = config.fields.filter(Boolean);
  let html: string;
  if (layout === "table") html = tableLayout(rows, fields, config.wrap);
  else if (layout === "list") html = listLayout(rows, fields);
  else if (layout === "gallery") html = galleryLayout(rows, fields, config.cover);
  else if (config.groupBy) html = kanbanLayout(attrs, rows, fields);
  else html = '<p class="kv-empty">Choose a grouping field in the view settings to show the kanban.</p>';
  const more = all.length > rows.length ? `<p class="kv-more">Showing ${rows.length} of ${all.length} items.</p>` : "";
  return { html: html + more, count: all.length };
}

/* ------------------------------------------------------------------ View */

type ViewOptions = { editable: () => boolean; onChange?: (attrs: CollectionAttrs) => void; onDelete?: () => void };

/** Render a live collection view into `dom`; it re-renders whenever app data changes. */
export function mountCollectionView(dom: HTMLElement, initial: CollectionAttrs, options: ViewOptions) {
  let attrs = initial;
  let query = "";
  dom.classList.add("kv-embed", "kv-collection");
  dom.innerHTML = `<header class="kv-embed-head">
      <span class="kv-embed-icon">${embedIcon("collection")}</span>
      <span class="kv-collection-title"><strong data-view-title></strong><small data-view-count></small></span>
      <span class="kv-embed-actions">
        <input type="search" class="kv-view-search" placeholder="Filter…" aria-label="Filter items" data-view-search>
        <span class="kv-layouts" role="group" aria-label="Layout">${layouts.map(([id, label]) => `<button type="button" data-layout-button="${id}" title="${label}" aria-label="${label}">${embedIcon(id)}</button>`).join("")}</span>
        <button type="button" data-view-settings title="View settings" aria-label="View settings">${embedIcon("settings")}</button>
        <button type="button" data-embed-delete title="Delete the view" aria-label="Delete the view">${embedIcon("trash")}</button>
      </span>
    </header>
    <div class="kv-embed-body" data-view-body></div>`;
  const body = dom.querySelector<HTMLElement>("[data-view-body]")!;
  const search = dom.querySelector<HTMLInputElement>("[data-view-search]")!;

  function render() {
    const result = renderBody(attrs, query);
    const name = collectionName(attrs.collection);
    dom.dataset.layout = attrs.layout;
    dom.querySelector("[data-view-title]")!.textContent = attrs.config.title || name;
    dom.querySelector("[data-view-count]")!.textContent = `${attrs.config.title ? `${name} · ` : ""}${plural(result.count, "item")}`;
    search.hidden = !attrs.config.search;
    dom.querySelector<HTMLElement>("[data-view-settings]")!.hidden = !options.editable() || !options.onChange;
    dom.querySelector<HTMLElement>("[data-embed-delete]")!.hidden = !options.editable() || !options.onDelete;
    dom.querySelectorAll<HTMLButtonElement>("[data-layout-button]")
      .forEach(button => button.setAttribute("aria-pressed", String(button.dataset.layoutButton === attrs.layout)));
    body.innerHTML = result.html;
  }

  search.addEventListener("input", () => { query = search.value; render(); });
  dom.addEventListener("click", event => {
    const target = event.target as HTMLElement;
    const layout = target.closest<HTMLElement>("[data-layout-button]")?.dataset.layoutButton as Layout | undefined;
    if (layout) {
      attrs = { ...attrs, layout };
      if (layout === "kanban" && !attrs.config.groupBy) attrs.config = { ...attrs.config, groupBy: defaultConfig(attrs.collection).groupBy };
      // Saved in the note when editing; a temporary switch in reading mode.
      if (options.editable() && options.onChange) options.onChange(attrs); else render();
      return;
    }
    if (target.closest("[data-embed-delete]")) return options.onDelete?.();
    if (target.closest("[data-view-settings]")) return void openCollectionConfig(attrs, next => options.onChange?.(next));
    const open = target.closest<HTMLElement>("[data-open-item]")?.dataset.openItem;
    if (open) {
      try { openCollectionItem(JSON.parse(open)); } catch (error) { toast((error as Error).message, "error"); }
    }
  });

  // Kanban drag and drop between lanes.
  let dragged = "";
  const clearDragState = () => dom.querySelectorAll(".kv-dragging,.kv-drop-target").forEach(el => el.classList.remove("kv-dragging", "kv-drop-target"));
  dom.addEventListener("dragstart", event => {
    const card = (event.target as HTMLElement).closest<HTMLElement>("[data-card]");
    if (!card) return;
    dragged = card.dataset.card!;
    event.dataTransfer!.setData("application/x-kv-kanban-card", dragged);
    event.dataTransfer!.effectAllowed = "move";
    card.classList.add("kv-dragging");
  });
  dom.addEventListener("dragend", () => { dragged = ""; clearDragState(); });
  dom.addEventListener("dragover", event => {
    const lane = (event.target as HTMLElement).closest<HTMLElement>("[data-lane]");
    if (!lane || !dragged) return;
    event.preventDefault();
    event.stopPropagation();
    dom.querySelectorAll(".kv-drop-target").forEach(el => el !== lane && el.classList.remove("kv-drop-target"));
    lane.classList.add("kv-drop-target");
  });
  dom.addEventListener("drop", async event => {
    const lane = (event.target as HTMLElement).closest<HTMLElement>("[data-lane]");
    if (!lane || !dragged) return;
    event.preventDefault();
    event.stopPropagation();
    const reference = JSON.parse(dragged);
    dragged = "";
    lane.classList.remove("kv-drop-target");
    try {
      await moveCard(reference, attrs.config.groupBy, lane.dataset.lane || "");
    } catch (error) {
      toast((error as Error).message, "error");
      render();
    }
  });

  const unsubscribe = subscribe(() => { if (dom.isConnected) render(); });
  render();
  return {
    update(next: CollectionAttrs) { attrs = next; render(); },
    destroy: unsubscribe,
  };
}

/** Stored as an empty <div data-type="collection-view"> with the view settings in data attributes. */
export const CollectionView = Node.create({
  name: "collectionView",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes: () => ({
    collection: { default: "tasks", parseHTML: el => el.getAttribute("data-collection") || "tasks", renderHTML: attrs => ({ "data-collection": attrs.collection }) },
    layout: { default: "table", parseHTML: el => el.getAttribute("data-layout") || "table", renderHTML: attrs => ({ "data-layout": attrs.layout }) },
    config: { default: "{}", parseHTML: el => el.getAttribute("data-config") || "{}", renderHTML: attrs => ({ "data-config": attrs.config }) },
  }),
  parseHTML: () => [{ tag: 'div[data-type="collection-view"]' }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "collection-view" })],
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement("div");
      dom.contentEditable = "false";
      (dom as any).kavotNodePosition = getPos; // lets the editor context menu select this block
      if (node.attrs.id) dom.id = node.attrs.id;
      const read = (n = node): CollectionAttrs => ({ collection: n.attrs.collection, layout: n.attrs.layout, config: parseConfig(n.attrs.config, n.attrs.collection) });
      const view = mountCollectionView(dom, read(), {
        editable: () => editor.isEditable,
        onDelete: () => deleteNode(editor, getPos),
        onChange: next => {
          const pos = getPos();
          if (typeof pos === "number" && editor.isEditable)
            editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...serializeCollection(next) }));
        },
      });
      return {
        dom,
        update(updated) {
          if (updated.type.name !== "collectionView") return false;
          node = updated;
          view.update(read(updated));
          return true;
        },
        stopEvent: event => !!(event.target as Element)?.closest?.(".kv-embed-head button, .kv-embed-head input, .kv-embed-body"),
        ignoreMutation: () => true,
        destroy: view.destroy,
      };
    };
  },
});

/* -------------------------------------------------------------- Settings */

const matchingCount = (count: number) => `${plural(count, "item")} ${count === 1 ? "matches" : "match"}`;
const option = (value: string, label: string, selected: boolean) =>
  `<option value="${escapeHtml(value)}" ${selected ? "selected" : ""}>${escapeHtml(label)}</option>`;

/** Collection view settings: source, layout, displayed fields, filters, sort and grouping. */
export function openCollectionConfig(initial: CollectionAttrs, onSave: (attrs: CollectionAttrs) => void, options: { title?: string; saveLabel?: string } = {}) {
  const title = options.title || "View settings";
  const dialog = dialogShell("kv-view-config", title);
  let draft: CollectionAttrs = structuredClone(initial);
  let itemQuery = "";

  /** Items of the collection matching the picker search, not yet picked. */
  function renderItemResults() {
    const results = dialog.querySelector<HTMLElement>("[data-item-results]");
    if (!results) return;
    const terms = fold(itemQuery.trim()).split(/\s+/).filter(Boolean);
    const picked = new Set(draft.config.items);
    const found = activeItems(draft.collection).filter(item => !picked.has(itemRef(item)) && terms.every(term =>
      fold(`${item.title ?? ""} ${plainText(item.detail)} ${item.meta ?? ""}`).includes(term)));
    results.innerHTML = found.slice(0, 8).map(item => {
      const detail = plainText(item.meta || item.detail).slice(0, 90);
      return `<button type="button" data-item-add="${escapeHtml(itemRef(item))}">${embedIcon("plus")}<span><strong>${escapeHtml(String(item.title || "Untitled"))}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}</span></button>`;
    }).join("") || `<p class="kv-empty">${terms.length ? "No items found." : "Every item is already picked."}</p>`;
  }

  function render() {
    const fields = availableFields(draft.collection);
    const config = draft.config;
    const fieldOptions = (selected: string, extra: [string, string][] = [], withTitle = true) =>
      [...extra, ...(withTitle ? [["title", "Title"]] : []), ...fields.map(field => [field, fieldLabel(field)])]
        .map(([value, label]) => option(value, label, value === selected)).join("");
    const shownFields = config.fields.map((field, index) => `<li>
        <span>${escapeHtml(fieldLabel(field))}</span>
        <button type="button" class="kv-icon-button" data-field-move="${index}:-1" aria-label="Move ${escapeHtml(fieldLabel(field))} up" ${index === 0 ? "disabled" : ""}>${embedIcon("up")}</button>
        <button type="button" class="kv-icon-button" data-field-move="${index}:1" aria-label="Move ${escapeHtml(fieldLabel(field))} down" ${index === config.fields.length - 1 ? "disabled" : ""}>${embedIcon("down")}</button>
        <button type="button" class="kv-icon-button" data-field-remove="${index}" aria-label="Remove ${escapeHtml(fieldLabel(field))}">${embedIcon("close")}</button>
      </li>`).join("");
    const suggestions = (field: string) => [...new Set(activeItems(draft.collection)
      .map(item => asText(field === "title" ? item.title : itemFields(item)[field])).filter(Boolean))].slice(0, 40);
    const titles = new Map(activeItems(draft.collection).map(item => [itemRef(item), String(item.title || "Untitled")]));
    const pickedItems = config.items.map((ref, index) => `<li>
        <span>${escapeHtml(titles.get(ref) || "Missing item")}</span>
        <button type="button" class="kv-icon-button" data-item-remove="${index}" aria-label="Remove ${escapeHtml(titles.get(ref) || "the item")}">${embedIcon("close")}</button>
      </li>`).join("");
    const filters = config.filters.map((filter, index) => `<div class="kv-filter" data-filter="${index}">
        <select data-filter-field aria-label="Filter field">${fieldOptions(filter.field)}</select>
        <select data-filter-op aria-label="Condition">${operators.map(([op, label]) => option(op, label, op === filter.op)).join("")}</select>
        <input data-filter-value aria-label="Filter value" value="${escapeHtml(filter.value)}" ${["empty", "notEmpty"].includes(filter.op) ? "hidden" : ""} list="kv-values-${index}">
        <datalist id="kv-values-${index}">${suggestions(filter.field).map(value => `<option value="${escapeHtml(value)}"></option>`).join("")}</datalist>
        <button type="button" class="kv-icon-button" data-filter-remove="${index}" aria-label="Remove the filter">${embedIcon("close")}</button>
      </div>`).join("");

    dialog.innerHTML = `<form method="dialog">
      <header class="kv-dialog-head"><h3>${escapeHtml(title)}</h3><button type="button" class="kv-icon-button" data-close aria-label="Close">${embedIcon("close", 16)}</button></header>
      <div class="kv-config-grid">
        <label>Collection<select data-config="collection">${collectionList().map(col => option(col.id, col.name, col.id === draft.collection)).join("")}</select></label>
        <label>View title<input data-config="title" value="${escapeHtml(config.title)}" placeholder="${escapeHtml(collectionName(draft.collection))}"></label>
      </div>
      <fieldset class="kv-layout-picker"><legend>Layout</legend>
        ${layouts.map(([id, label]) => `<label><input type="radio" name="layout" value="${id}" ${draft.layout === id ? "checked" : ""}><span>${embedIcon(id, 18)}${label}</span></label>`).join("")}
      </fieldset>
      <fieldset><legend>Displayed information</legend>
        <ol class="kv-field-list">${shownFields || '<li class="kv-empty">Only the title is shown.</li>'}</ol>
        <label class="kv-inline">Add<select data-field-add><option value="">Choose a field…</option>${fields.filter(field => !config.fields.includes(field)).map(field => option(field, fieldLabel(field), false)).join("")}</select></label>
      </fieldset>
      <fieldset><legend>Items</legend>
        <ol class="kv-field-list">${pickedItems || '<li class="kv-empty">All items of the collection are shown. Pick items to show only those.</li>'}</ol>
        <div class="kv-item-picker">
          <input type="search" data-item-search value="${escapeHtml(itemQuery)}" placeholder="Search an item to add…" aria-label="Search an item to add">
          <div class="kv-item-results" data-item-results></div>
        </div>
      </fieldset>
      <fieldset><legend>Filters</legend>
        ${config.filters.length > 1 ? `<label class="kv-inline">Show items that match<select data-config="match">${option("all", "all filters", config.match === "all")}${option("any", "at least one filter", config.match === "any")}</select></label>` : ""}
        <div class="kv-filters">${filters}</div>
        <button type="button" class="kv-add" data-filter-add>${embedIcon("plus")} Add a filter</button>
      </fieldset>
      <fieldset><legend>Sort and group</legend><div class="kv-config-grid">
        <label>Sort by<select data-config="sortField">${fieldOptions(config.sort?.field || "", [["", "Collection order"]])}</select></label>
        <label>Order<select data-config="sortDir">${option("asc", "Ascending", config.sort?.dir !== "desc")}${option("desc", "Descending", config.sort?.dir === "desc")}</select></label>
        <label>Group by (kanban)<select data-config="groupBy">${fieldOptions(config.groupBy, [["", "None"]], false)}</select></label>
        <label>Card image (gallery)<select data-config="cover"><option value="">Title initial</option>${fields.map(field => option(field, fieldLabel(field), field === config.cover)).join("")}</select></label>
        <label>Maximum items<input type="number" min="1" max="500" data-config="limit" value="${config.limit}"></label>
        <span class="kv-checks">
          <label class="kv-inline"><input type="checkbox" data-config="search" ${config.search ? "checked" : ""}> Search field</label>
          <label class="kv-inline"><input type="checkbox" data-config="wrap" ${config.wrap ? "checked" : ""}> Wrap text in the table</label>
        </span>
      </div></fieldset>
      <footer class="form-actions">
        <small role="status">${matchingCount(viewItems(draft).length)}</small>
        <span class="kv-spacer"></span>
        <button type="button" data-close>Cancel</button>
        <button type="submit" class="primary">${escapeHtml(options.saveLabel || "Save")}</button>
      </footer>
    </form>`;
    renderItemResults();
  }

  /** Apply one form change to the draft; structural changes re-render the dialog. */
  function sync(event: Event) {
    const target = event.target as HTMLInputElement;
    const config = draft.config;
    const key = target.dataset.config;
    if (key === "collection") {
      draft = { ...draft, collection: target.value, config: { ...defaultConfig(target.value), title: config.title } };
      return render();
    }
    if (key === "title") config.title = target.value;
    if (key === "match") config.match = target.value as "all" | "any";
    if (key === "sortField") config.sort = target.value ? { field: target.value, dir: config.sort?.dir || "asc" } : null;
    if (key === "sortDir" && config.sort) config.sort.dir = target.value as "asc" | "desc";
    if (key === "groupBy") config.groupBy = target.value;
    if (key === "cover") config.cover = target.value;
    if (key === "limit") config.limit = Math.min(Math.max(Number(target.value) || 50, 1), 500);
    if (key === "search") config.search = target.checked;
    if (key === "wrap") config.wrap = target.checked;
    if (target.name === "layout") {
      draft.layout = target.value as Layout;
      if (draft.layout === "kanban" && !config.groupBy) { config.groupBy = defaultConfig(draft.collection).groupBy; return render(); }
    }
    if (target.matches("[data-field-add]") && target.value) { config.fields.push(target.value); return render(); }
    const filterRow = target.closest<HTMLElement>("[data-filter]");
    if (filterRow) {
      const filter = config.filters[Number(filterRow.dataset.filter)];
      if (target.matches("[data-filter-field]")) { filter.field = target.value; return render(); }
      if (target.matches("[data-filter-op]")) { filter.op = target.value as FilterOp; return render(); }
      if (target.matches("[data-filter-value]")) filter.value = target.value;
    }
    const status = dialog.querySelector('[role="status"]');
    if (status) status.textContent = matchingCount(viewItems(draft).length);
  }

  // Text fields update as you type; selects, radios and checkboxes on change.
  dialog.addEventListener("input", event => {
    const target = event.target as HTMLInputElement;
    if (target.matches("[data-item-search]")) { itemQuery = target.value; return renderItemResults(); }
    if ((event.target as HTMLElement).matches('input:not([type="radio"]):not([type="checkbox"])')) sync(event);
  });
  dialog.addEventListener("change", event => {
    if (!(event.target as HTMLElement).matches('[data-item-search], input[type="text"], input:not([type]), input[type="number"]')) sync(event);
  });
  dialog.addEventListener("click", event => {
    const target = event.target as HTMLElement;
    const config = draft.config;
    if (target.closest("[data-close]")) return dialog.close();
    const addItem = target.closest<HTMLElement>("[data-item-add]")?.dataset.itemAdd;
    if (addItem) {
      config.items.push(addItem);
      render();
      return dialog.querySelector<HTMLInputElement>("[data-item-search]")?.focus();
    }
    const removeItem = target.closest<HTMLElement>("[data-item-remove]")?.dataset.itemRemove;
    if (removeItem != null) { config.items.splice(Number(removeItem), 1); return render(); }
    const move = target.closest<HTMLElement>("[data-field-move]")?.dataset.fieldMove;
    if (move) {
      const [index, offset] = move.split(":").map(Number);
      [config.fields[index], config.fields[index + offset]] = [config.fields[index + offset], config.fields[index]];
      return render();
    }
    const remove = target.closest<HTMLElement>("[data-field-remove]")?.dataset.fieldRemove;
    if (remove != null) { config.fields.splice(Number(remove), 1); return render(); }
    if (target.closest("[data-filter-add]")) {
      const field = config.groupBy || config.fields.find(name => !name.startsWith("@")) || "title";
      config.filters.push({ field, op: "equals", value: "" });
      return render();
    }
    const removeFilter = target.closest<HTMLElement>("[data-filter-remove]")?.dataset.filterRemove;
    if (removeFilter != null) { config.filters.splice(Number(removeFilter), 1); return render(); }
  });
  // Enter in the item search adds the first result instead of saving the view.
  dialog.addEventListener("keydown", event => {
    if (event.key !== "Enter" || !(event.target as HTMLElement).matches("[data-item-search]")) return;
    event.preventDefault();
    dialog.querySelector<HTMLElement>("[data-item-add]")?.click();
  });
  dialog.addEventListener("submit", event => {
    event.preventDefault();
    draft.config.filters = draft.config.filters.filter(filter => ["empty", "notEmpty"].includes(filter.op) || filter.value.trim());
    onSave(draft);
    dialog.close();
  });

  render();
  dialog.showModal();
  return dialog;
}
