// Explorer-style multi-selection in the notes tree: Ctrl/Cmd toggles a row,
// Shift selects the range from the last clicked row. Rows are tracked by their
// workspace path so the selection survives tree rerenders.

const ROW = "#notes-tree .workspace-file-row[data-workspace-path]";
// Only rows the app can move or trash; library references and protected items are excluded.
const SELECTABLE = "[data-note-drag]:not([data-reference-drag]), [data-workspace-drag]:not([data-reference-drag]), [data-folder-drag]";

const selected = new Set<string>();
let anchor: string | null = null;

const rowPath = (row: Element) => (row as HTMLElement).dataset.workspacePath || "";
const selectableRows = () =>
  [...document.querySelectorAll<HTMLElement>(ROW)].filter((row) => row.matches(SELECTABLE));

/** Selected paths, without items already covered by a selected parent folder. */
export function selectedTreePaths(): string[] {
  const paths = [...selected];
  return paths.filter((path) => !paths.some((other) => other !== path && path.startsWith(`${other}/`)));
}

export function isTreeRowSelected(row: Element | null) {
  return Boolean(row && selected.size > 1 && selected.has(rowPath(row)));
}

export function clearTreeSelection() {
  if (!selected.size) return;
  selected.clear();
  decorateTreeSelection();
}

/** Reapply the highlight after the tree is rendered again; drop rows that no longer exist. */
export function decorateTreeSelection() {
  const rows = [...document.querySelectorAll<HTMLElement>(ROW)];
  if (rows.length) {
    const present = new Set(rows.map(rowPath));
    selected.forEach((path) => { if (!present.has(path)) selected.delete(path); });
  }
  const multiple = selected.size > 1;
  rows.forEach((row) => row.classList.toggle("multi-selected", multiple && selected.has(rowPath(row))));
}

export function initializeTreeSelection() {
  // Shift-click must not start a text selection across the tree.
  document.addEventListener("mousedown", (event) => {
    if (event.shiftKey && (event.target as HTMLElement).closest?.(ROW)) event.preventDefault();
  });
  // Capture phase: a modified click selects instead of opening or expanding the row.
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const row = target.closest?.<HTMLElement>(ROW);
    if (!row || target.closest("input, .workspace-item-actions, .workspace-create-actions, .workspace-open-side")) return;
    const path = rowPath(row);
    const toggle = event.ctrlKey || event.metaKey;
    if (!toggle && !event.shiftKey) {
      selected.clear();
      if (row.matches(SELECTABLE)) selected.add(path);
      anchor = path;
      decorateTreeSelection();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (!row.matches(SELECTABLE)) return;
    // The open document counts as already selected, like the focused file in an explorer.
    if (!selected.size) {
      const active = selectableRows().find((item) => item.classList.contains("primary-active"));
      if (active) { selected.add(rowPath(active)); anchor ??= rowPath(active); }
    }
    if (event.shiftKey && anchor) {
      const rows = selectableRows().map(rowPath);
      const from = rows.indexOf(anchor);
      const to = rows.indexOf(path);
      if (from >= 0 && to >= 0) {
        if (!toggle) selected.clear();
        rows.slice(Math.min(from, to), Math.max(from, to) + 1).forEach((item) => selected.add(item));
      }
    } else if (selected.has(path)) {
      selected.delete(path);
      anchor = path;
    } else {
      selected.add(path);
      anchor = path;
    }
    decorateTreeSelection();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && selected.size > 1 && (event.target as HTMLElement).closest?.(".notes-sidebar"))
      clearTreeSelection();
  });
}
