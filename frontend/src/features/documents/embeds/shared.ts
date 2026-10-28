/** Helpers shared by the script and collection blocks. */
import type { Editor } from "@tiptap/core";
import { state } from "../../../app/state";

const icons: Record<string, string> = {
  script: "m8 6-6 6 6 6M16 6l6 6-6 6M13 4l-2 16",
  collection: "M4 5h16v4H4zM4 11h16v4H4zM4 17h16v2H4z",
  table: "M3 4h18v16H3zM3 10h18M3 15h18M9 4v16M15 4v16",
  list: "M4 6h1M4 12h1M4 18h1M9 6h11M9 12h11M9 18h11",
  gallery: "M3 4h8v7H3zM13 4h8v7h-8zM3 13h8v7H3zM13 13h8v7h-8z",
  kanban: "M3 4h5v16H3zM10 4h5v10h-5zM17 4h4v13h-4z",
  settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1",
  run: "M7 4v16l13-8z",
  edit: "m14 4 6 6M4 20l1-6L16 3l5 5L10 19z",
  save: "M5 3h11l3 3v15H5zM8 3v6h8V3M8 14h8v7H8z",
  close: "M6 6l12 12M18 6 6 18",
  up: "m6 14 6-6 6 6",
  down: "m6 10 6 6 6-6",
  plus: "M12 5v14M5 12h14",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
};

export const embedIcon = (name: string, size = 14) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8"`
  + ` stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icons[name] || icons.script}"/></svg>`;

/** Strip HTML and collapse whitespace. */
export const plainText = (value: unknown) =>
  String(value ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/** Lowercase without accents, for forgiving search. */
export const fold = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase();

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** A modal <dialog> appended to the page and removed when closed. */
export function dialogShell(className: string, label: string) {
  const dialog = document.createElement("dialog");
  dialog.className = `kv-dialog ${className}`;
  dialog.setAttribute("aria-label", label);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("cancel", () => dialog.close());
  return dialog;
}

/** Delete the node a node view renders. */
export function deleteNode(editor: Editor, getPos: () => number | undefined) {
  const pos = getPos();
  const node = typeof pos === "number" ? editor.state.doc.nodeAt(pos) : null;
  if (typeof pos === "number" && node && editor.isEditable) editor.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run();
}

const builtInCollections: Record<string, string> = { notes: "Notes", articles: "Articles", tasks: "Tasks", conferences: "Conferences", datasets: "Datasets" };

export function collectionList() {
  const ids = [...new Set([...Object.keys(builtInCollections), ...state.databases.map(db => db.id)])];
  return ids.map(id => ({ id, name: state.databases.find(db => db.id === id)?.name || builtInCollections[id] || id }));
}

export const collectionName = (id: string) => collectionList().find(c => c.id === id)?.name || id;
