/**
 * Tiptap nodes and extensions specific to Kavot notes: stable block ids,
 * side-by-side columns, collapsible sections, math, media, resizable images
 * and tables that keep their presentation attributes.
 */
import { Extension, Node, mergeAttributes } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { TableView } from "@tiptap/extension-table";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import { documentHtml } from "./html";

const blockTypes = [
  "paragraph",
  "heading",
  "image",
  "table",
  "tableRow",
  "tableCell",
  "tableHeader",
  "taskList",
  "taskItem",
  "listItem",
  "horizontalRule",
  "blockquote",
  "codeBlock",
  "bulletList",
  "orderedList",
  "columns",
  "column",
  "figure",
  "caption",
  "section",
  "aside",
  "details",
  "summary",
  "math",
  "media",
  "scriptBlock",
  "collectionView",
];
/** Table node view that keeps presentation attributes in sync after edits. */
export class StyledTableView extends TableView {
  constructor(node: any, cellMinWidth: number, view?: any, attributes?: Record<string, any>) {
    super(node, cellMinWidth, view, attributes);
    this.sync(node);
  }
  update(node: any) {
    if (!super.update(node)) return false;
    this.sync(node);
    return true;
  }
  sync(node: any) {
    if (node.attrs.tableStyle) this.table.dataset.style = node.attrs.tableStyle;
    else delete this.table.dataset.style;
  }
}
export const Identifiers = Extension.create({
  name: "blockIdentifiers",
  addGlobalAttributes() {
    return [
      {
        types: blockTypes,
        attributes: {
          id: {
            default: null,
            parseHTML: (element) => element.id || null,
            renderHTML: (attrs) => (attrs.id ? { id: attrs.id } : {}),
          },
        },
      },
      {
        types: ["paragraph", "heading", "section", "aside", "figure", "caption", "blockquote"],
        attributes: {
          blockStyle: {
            default: null,
            parseHTML: element => element.getAttribute("style"),
            renderHTML: attrs => attrs.blockStyle ? { style: attrs.blockStyle } : {},
          },
        },
      },
    ];
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (_transactions, _old, state) => {
          const seen = new Set<string>();
          const tr = state.tr;
          state.doc.descendants((node, pos) => {
            if (!blockTypes.includes(node.type.name)) return;
            if (!node.attrs.id || seen.has(node.attrs.id))
              tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                id: `b-${crypto.randomUUID()}`,
              });
            seen.add(node.attrs.id);
          });
          return tr.docChanged ? tr : null;
        },
      }),
    ];
  },
});
export const MAX_COLUMNS = 4;
const MIN_WIDTH = 12;
export type SplitAction = "equal" | "add" | "unsplit" | "delete" | "removeColumn";

/** Widths in percent of each column of a split (equal shares when none is set). */
function columnWidths(node: any): number[] {
  const count = node.childCount;
  const widths: number[] = [];
  node.forEach((column: any) => widths.push(parseFloat(column.attrs.width) || 0));
  if (widths.some(width => !width)) return Array(count).fill(100 / count);
  const total = widths.reduce((sum, width) => sum + width, 0);
  return widths.map(width => (width / total) * 100);
}

function setWidths(editor: any, pos: number, widths: (number | null)[]) {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  const tr = editor.state.tr;
  let offset = pos + 1;
  node.forEach((column: any, _: number, index: number) => {
    const width = widths[index];
    tr.setNodeMarkup(offset, undefined, { ...column.attrs, width: width === null ? null : `${Math.round(width * 10) / 10}%` });
    offset += column.nodeSize;
  });
  editor.view.dispatch(tr);
}

/** The split around the selection: its position and the index of the column holding the cursor. */
export function splitAt(editor: any): { pos: number; index: number } | null {
  const $from = editor.state.selection.$from;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name === "columns") return { pos: $from.before(depth), index: $from.index(depth) };
  }
  const node = editor.state.selection.node;
  return node?.type.name === "columns" ? { pos: editor.state.selection.from, index: 0 } : null;
}

/** Change a split: equal widths, one more column, back to plain blocks, or gone. */
export function splitAction(editor: any, pos: number, action: SplitAction, index = 0) {
  const node = editor.state.doc.nodeAt(pos);
  if (!node || node.type.name !== "columns" || !editor.isEditable) return;
  const range = { from: pos, to: pos + node.nodeSize };
  const blocks = (columns: any[]) => columns.flatMap(column => column.content.content.map((child: any) => child.toJSON()));
  const columns: any[] = [];
  node.forEach((column: any) => columns.push(column));
  if (action === "equal") setWidths(editor, pos, columns.map(() => null));
  else if (action === "add" && node.childCount < MAX_COLUMNS) {
    const end = pos + node.nodeSize - 1;
    editor.chain().focus().insertContentAt(end, { type: "column", content: [{ type: "paragraph" }] }).run();
    setWidths(editor, pos, Array(node.childCount + 1).fill(null));
    editor.commands.setTextSelection(Math.min(end + 2, editor.state.doc.content.size));
  } else if (action === "unsplit") editor.chain().focus().insertContentAt(range, blocks(columns)).run();
  else if (action === "delete") editor.chain().focus().deleteRange(range).run();
  else if (action === "removeColumn") {
    const kept = columns.filter((_, position) => position !== index);
    if (kept.length < 2) editor.chain().focus().insertContentAt(range, blocks(kept)).run();
    else editor.chain().focus().insertContentAt(range, { type: "columns", content: kept.map(column => ({ ...column.toJSON(), attrs: { ...column.attrs, width: null } })) }).run();
  }
}

export const Columns = Node.create({
  name: "columns",
  group: "block",
  content: `column{2,${MAX_COLUMNS}}`,
  isolating: true,
  draggable: true,
  parseHTML: () => [{ tag: 'div[data-type="columns"]' }],
  renderHTML: ({ HTMLAttributes }) => [
    "div",
    mergeAttributes(HTMLAttributes, { "data-type": "columns" }),
    0,
  ],
  /** In the editor: drag handles between columns, and a small bar to change the split. */
  addNodeView() {
    return ({ node: initial, getPos, editor }) => {
      let node = initial;
      const dom = document.createElement("div");
      dom.className = "rich-columns";
      const content = document.createElement("div");
      content.dataset.type = "columns";
      if (node.attrs.id) content.id = node.attrs.id;
      const bar = document.createElement("div");
      bar.className = "rich-columns-bar";
      bar.contentEditable = "false";
      const button = (action: SplitAction, label: string, text: string) =>
        `<button type="button" data-split="${action}" title="${label}" aria-label="${label}">${text}</button>`;
      const renderBar = () => {
        bar.innerHTML = button("equal", "Equal widths", "⇹") + (node.childCount < MAX_COLUMNS ? button("add", "Add a column", "+") : "")
          + button("unsplit", "Unsplit: keep the content, one block under the other", "▤") + button("delete", "Delete the split and its content", "×");
      };
      renderBar();
      const handles = document.createElement("div");
      handles.className = "rich-columns-handles";
      handles.contentEditable = "false";
      dom.append(bar, content, handles);
      const columnElements = () => [...content.children].filter(child => (child as HTMLElement).dataset.type === "column") as HTMLElement[];
      const place = () => {
        const columnsDom = columnElements();
        // Keep the existing handles (one may hold the pointer during a drag); only add, remove and move them.
        while (handles.children.length > columnsDom.length - 1) handles.lastElementChild!.remove();
        while (handles.children.length < columnsDom.length - 1) {
          const handle = document.createElement("div");
          handle.className = "rich-column-handle";
          handle.title = "Drag to resize · Double-click for equal widths";
          handles.append(handle);
        }
        [...handles.children].forEach((handle, index) => {
          const column = columnsDom[index], next = columnsDom[index + 1];
          (handle as HTMLElement).dataset.index = String(index);
          (handle as HTMLElement).style.left = `${(column.offsetLeft + column.offsetWidth + next.offsetLeft) / 2 - 5}px`;
        });
      };
      const observer = new ResizeObserver(() => place());
      observer.observe(content);
      requestAnimationFrame(place);
      bar.addEventListener("mousedown", event => event.preventDefault());
      bar.addEventListener("click", event => {
        const action = (event.target as HTMLElement).closest<HTMLElement>("[data-split]")?.dataset.split as SplitAction | undefined;
        const pos = typeof getPos === "function" ? getPos() : null;
        if (action && typeof pos === "number") splitAction(editor, pos, action);
      });
      let drag: { index: number; widths: number[]; box: DOMRect; label: HTMLElement } | null = null;
      handles.addEventListener("pointerdown", event => {
        const handle = (event.target as HTMLElement).closest<HTMLElement>(".rich-column-handle");
        if (!handle || !editor.isEditable || event.button !== 0) return;
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        const label = document.createElement("span");
        label.className = "rich-column-size";
        handle.append(label);
        drag = { index: Number(handle.dataset.index), widths: columnWidths(node), box: content.getBoundingClientRect(), label };
        dom.classList.add("is-resizing");
      });
      handles.addEventListener("pointermove", event => {
        if (!drag) return;
        const { index, widths, box } = drag;
        const before = widths.slice(0, index).reduce((sum, width) => sum + width, 0);
        const pair = widths[index] + widths[index + 1];
        const position = ((event.clientX - box.left) / box.width) * 100 - before;
        const first = Math.max(MIN_WIDTH, Math.min(pair - MIN_WIDTH, position));
        widths[index] = first; widths[index + 1] = pair - first;
        // Preview through variables on the split itself: ProseMirror would undo direct edits of the columns.
        widths.forEach((width, position) => content.style.setProperty(`--rich-column-${position + 1}`, `${width}%`));
        drag.label.textContent = `${Math.round(first)} / ${Math.round(pair - first)}`;
        place();
      });
      const finish = () => {
        if (!drag) return;
        const { widths, label } = drag;
        drag = null;
        label.remove();
        dom.classList.remove("is-resizing");
        widths.forEach((_, position) => content.style.removeProperty(`--rich-column-${position + 1}`));
        const pos = typeof getPos === "function" ? getPos() : null;
        if (typeof pos === "number") setWidths(editor, pos, widths);
      };
      handles.addEventListener("pointerup", finish);
      handles.addEventListener("pointercancel", finish);
      handles.addEventListener("lostpointercapture", finish);
      handles.addEventListener("dblclick", event => {
        if (!(event.target as HTMLElement).closest(".rich-column-handle")) return;
        const pos = typeof getPos === "function" ? getPos() : null;
        if (typeof pos === "number") splitAction(editor, pos, "equal");
      });
      return {
        dom,
        contentDOM: content,
        update(updated) {
          if (updated.type.name !== "columns") return false;
          node = updated;
          renderBar();
          requestAnimationFrame(place);
          return true;
        },
        ignoreMutation: (mutation) => !content.contains(mutation.target) || mutation.target === content && mutation.type === "attributes",
        stopEvent: (event) => bar.contains(event.target as globalThis.Node) || handles.contains(event.target as globalThis.Node),
        destroy: () => observer.disconnect(),
      };
    };
  },
});
export const Column = Node.create({
  name: "column",
  content: "block+",
  isolating: true,
  addAttributes: () => ({
    width: {
      default: null,
      parseHTML: (el) => el.style.flexBasis || null,
      renderHTML: (attrs) =>
        attrs.width ? { style: `flex-basis:${attrs.width}` } : {},
    },
  }),
  parseHTML: () => [{ tag: 'div[data-type="column"]' }],
  renderHTML: ({ HTMLAttributes }) => [
    "div",
    mergeAttributes(HTMLAttributes, { "data-type": "column" }),
    0,
  ],
});
export const structural = (name: string, tag: string, content: string) =>
  Node.create({
    name,
    group: "block",
    content,
    draggable: true,
    addAttributes: () => tag === "details" ? { open: { default: true, parseHTML: el => el.hasAttribute("open"), renderHTML: attrs => attrs.open ? { open: "" } : {} } } : {},
    parseHTML: () => [{ tag }],
    renderHTML: ({ HTMLAttributes }) => [tag, HTMLAttributes, 0],
  });
export const CollapsibleSection = structural("details", "details", "summary block+").extend({
  addNodeView() {
    return ({node, editor, getPos}) => {
      const dom = document.createElement('section');
      dom.className = 'rich-details-node';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.contentEditable = 'false';
      toggle.className = 'rich-details-toggle';
      const contentDOM = document.createElement('div');
      contentDOM.className = 'rich-details-content';
      dom.append(toggle, contentDOM);
      function render() {
        dom.dataset.open = String(!!node.attrs.open);
        if (node.attrs.id) dom.id = node.attrs.id;
        toggle.textContent = node.attrs.open ? '▾' : '▸';
        toggle.setAttribute('aria-label', node.attrs.open ? 'Collapse the section' : 'Expand the section');
        toggle.setAttribute('aria-expanded', String(!!node.attrs.open));
      }
      toggle.addEventListener('mousedown', event => event.preventDefault());
      toggle.addEventListener('click', () => {
        const pos = getPos();
        if (typeof pos === 'number' && editor.isEditable) {
          const tr = editor.state.tr.setNodeMarkup(pos, undefined, {...node.attrs, open: !node.attrs.open});
          const titleEnd = pos + (node.firstChild?.nodeSize || 2);
          if (node.attrs.open && tr.selection.from > titleEnd && tr.selection.from < pos + node.nodeSize) {
            tr.setSelection(TextSelection.near(tr.doc.resolve(titleEnd)));
          }
          editor.view.dispatch(tr);
        }
      });
      render();
      return {dom, contentDOM, update(updated) { if (updated.type.name !== 'details') return false; node = updated; render(); return true; }, stopEvent: event => toggle.contains(event.target as globalThis.Node)};
    };
  },
});
export const MathNode = Node.create({
  name: "math",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes: () => ({
    latex: {
      default: "",
      parseHTML: (el) => el.dataset.latex,
      renderHTML: (attrs) => ({ "data-latex": attrs.latex }),
    },
    markup: {
      default: "",
      parseHTML: (el) => el.innerHTML,
      renderHTML: () => ({}),
    },
    display: {
      default: "false",
      parseHTML: (el) => el.dataset.display,
      renderHTML: (attrs) => ({ "data-display": attrs.display }),
    },
  }),
  parseHTML: () => [{ tag: 'span[data-type="math"]' }],
  renderHTML({ node, HTMLAttributes }) {
    const span = document.createElement("span");
    Object.entries(
      mergeAttributes(HTMLAttributes, { "data-type": "math" }),
    ).forEach(([k, v]) => span.setAttribute(k, String(v)));
    span.innerHTML = documentHtml(node.attrs.markup) || node.attrs.latex;
    return span;
  },
});
export const Media = Node.create({
  name: "media",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes: () => ({
    markup: {
      default: "",
      parseHTML: (el) => el.outerHTML,
      renderHTML: () => ({}),
    },
  }),
  parseHTML: () => [{ tag: "audio" }, { tag: "video" }],
  renderHTML({ node }) {
    const div = document.createElement("div");
    div.innerHTML = documentHtml(node.attrs.markup);
    return div.firstElementChild as HTMLElement;
  },
});
export const RichImage = Image.extend({
  draggable: true,
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: "100%",
        parseHTML: (el) => el.style.width || el.getAttribute("width") || "100%",
        renderHTML: (attrs) => ({
          style: `width:${/^\d+$/.test(String(attrs.width)) ? attrs.width + "px" : attrs.width};height:auto`,
        }),
      },
    };
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement("figure");
      dom.className = "rich-image-node";
      (dom as any).kavotImagePosition = getPos;
      const img = document.createElement("img");
      img.src = node.attrs.src;
      img.alt = node.attrs.alt || "";
      img.draggable = true;
      img.style.width = /^\d+$/.test(String(node.attrs.width))
        ? node.attrs.width + "px"
        : node.attrs.width;
      const handle = document.createElement("button");
      handle.className = "rich-image-resize";
      handle.type = "button";
      handle.setAttribute("aria-label", "Resize the image");
      handle.textContent = "↘";
      handle.style.left = img.style.width;
      handle.style.right = "auto";
      handle.style.transform = "translateX(-100%)";
      dom.append(img, handle);
      handle.addEventListener("pointerdown", (event) => {
        if (!editor.isEditable) return;
        event.preventDefault();
        event.stopPropagation();
        const start = event.clientX,
          width = img.getBoundingClientRect().width;
        handle.setPointerCapture(event.pointerId);
        const move = (next: PointerEvent) => {
          img.style.width =
            Math.max(
              40,
              Math.min(
                dom.parentElement?.clientWidth || 1200,
                width + next.clientX - start,
              ),
            ) + "px";
          handle.style.left = img.style.width;
        };
        const finish = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", finish);
          const pos = getPos();
          if (typeof pos === "number" && editor.isEditable)
            editor.view.dispatch(
              editor.state.tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                width: img.style.width,
              }),
            );
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", finish, { once: true });
      });
      return {
        dom,
        update: (updated) => {
          if (updated.type.name !== "image") return false;
          node = updated;
          img.src = node.attrs.src;
          img.alt = node.attrs.alt || "";
          img.style.width = /^\d+$/.test(String(node.attrs.width))
            ? node.attrs.width + "px"
            : node.attrs.width;
          handle.style.left = img.style.width;
          return true;
        },
      };
    };
  },
});
