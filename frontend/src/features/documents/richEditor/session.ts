import { setEditorBase } from '../editorBase';
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { TextStyleKit } from '@tiptap/extension-text-style';
import TextAlign from '@tiptap/extension-text-align';
import Highlight from '@tiptap/extension-highlight';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { DOMSerializer } from '@tiptap/pm/model';
import { documentHtml } from '../html';
import { onDisconnect } from '../domLifecycle';
import { CollapsibleSection, Column, Columns, Identifiers, MathNode, Media, MAX_COLUMNS, RichImage, splitAction, splitAt, StyledTableView, structural, type SplitAction } from './nodes';
import { ScriptBlock, hydrateEmbeds, openScriptLibrary } from '../embeds';
import { droppedLink, hasInternalTransfer, internalTransfer } from '../dropLinks';
import { escapeHtml, flushReaderAutosave, noteAssetBase, state } from '../../../app/state';
import { flushAgentSaves } from '../../../app/agentEvents';
import { api } from '../../../services/api';
import { toast } from '../../../app/navigation';
import { dividerStyles, tableStyles, editorIcon, fontFamilies, fontSizes, mod, commands } from './markup';

type Session = {
  editor: Editor;
  input: HTMLTextAreaElement;
  source: HTMLTextAreaElement;
  mode: string;
  setMode: (mode: string) => void;
};

const sessions = new Map<HTMLElement, Session>();

let readOnly = false;

function key(container: HTMLElement) {
  const pane = container.closest<HTMLElement>(
    "[data-primary-note-id],[data-secondary-note-id],[data-workspace-markdown-path]",
  );
  return (
    container.dataset.agentNoteId ||
    pane?.dataset.workspaceMarkdownPath ||
    pane?.dataset.primaryNoteId ||
    pane?.dataset.secondaryNoteId
  );
}

export function captureMarkdownPositions() {
  const saved = [...sessions].map(([root, s]) => ({
    key: key(root),
    pos: s.editor.state.selection.from,
    scroll: root.scrollTop,
  }));
  return () => {
    for (const [root, s] of sessions) {
      const previous = saved.find((p) => p.key === key(root));
      if (previous) {
        s.editor.commands.setTextSelection(
          Math.min(previous.pos, s.editor.state.doc.content.size),
        );
        root.scrollTop = previous.scroll;
      }
    }
  };
}

export function setMarkdownEditorsReadOnly(value: boolean) {
  readOnly = value;
  for (const [root, s] of sessions) {
    s.editor.setEditable(!value && s.mode === "live");
    root
      .querySelectorAll<HTMLInputElement>("input,select,button[data-command]")
      .forEach((el) => {
        el.disabled = value;
      });
  }
}

export function currentMarkdownBlockInput(
  container,
  activateFirst = false,
): HTMLTextAreaElement | null {
  const s = sessions.get(container);
  if (!s || s.mode === "reading") return null;
  if (activateFirst) s.editor.commands.focus();
  return s.input;
}

function offset(editor: Editor) {
  const div = document.createElement("div");
  const $pos = editor.state.selection.$from;
  const end = $pos.depth ? $pos.after(1) : 0;
  div.append(
    DOMSerializer.fromSchema(editor.schema).serializeFragment(
      editor.state.doc.cut(0, end).content,
    ),
  );
  return div.innerHTML.length;
}

export function markdownBlockSourceOffset(container, _input = null) {
  const s = sessions.get(container);
  return s ? offset(s.editor) : 0;
}

export function setMarkdownBlockEditorContent(
  container,
  source,
  content,
  assetBase = null,
  focusIndex = null,
  silent = false,
) {
  if (!container || !source) return;
  const s = sessions.get(container);
  if (assetBase != null) container.dataset.assetBase = assetBase;
  const html = documentHtml(content, container.dataset.assetBase);
  source.value = html;
  setEditorBase(source, content);
  if (s) {
    s.editor.commands.setContent(html, { emitUpdate: !silent });
    if (focusIndex != null) s.editor.commands.focus("end");
  }
}

export function bindMarkdownBlockEditor(
  element: Element,
  sourceElement: Element,
) {
  const root = element as HTMLElement,
    source = sourceElement as HTMLTextAreaElement;
  if (!root || !source || sessions.has(root)) return;
  const input = root.querySelector<HTMLTextAreaElement>(
      ".markdown-block-input",
    )!,
    reading = root.querySelector<HTMLElement>(".continuous-reading")!,
    host = root.querySelector<HTMLElement>(".continuous-editor-host")!;
  let syncing = false;
  // Serializing the whole document on every keystroke is costly: the source textarea follows
  // the editor lazily, when it is read or shortly after typing stops.
  const nativeValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!;
  let sourceStale = false;
  let sourceTimer: ReturnType<typeof setTimeout> | undefined;
  const syncSource = () => {
    clearTimeout(sourceTimer);
    if (!sourceStale) return;
    sourceStale = false;
    nativeValue.set!.call(source, editor.getHTML());
  };
  Object.defineProperty(source, "value", {
    configurable: true,
    get: () => { syncSource(); return nativeValue.get!.call(source); },
    set: (value) => { clearTimeout(sourceTimer); sourceStale = false; nativeValue.set!.call(source, value); },
  });
  const editor = new Editor({
    element: host,
    content: documentHtml(source.value, root.dataset.assetBase),
    editable: !readOnly,
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      RichImage,
      TableKit.configure({ table: { resizable: true, View: StyledTableView } }),
      TextStyleKit,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Highlight.configure({ multicolor: true }),
      TaskList,
      TaskItem.configure({ nested: true, HTMLAttributes: {"data-type": "taskItem"} }),
      Identifiers,
      Columns,
      Column,
      structural("figure", "figure", "block+"),
      structural("caption", "figcaption", "inline*"),
      structural("section", "section", "block+"),
      structural("aside", "aside", "block+"),
      structural("summary", "summary", "inline*"),
      CollapsibleSection,
      MathNode,
      Media,
      ScriptBlock,
      Extension.create({
        name: "tableWidth",
        addGlobalAttributes: () => [
          {
            types: ["table"],
            attributes: {
              width: {
                default: null,
                parseHTML: (el) => el.style.width,
                renderHTML: (attrs) =>
                  attrs.width ? { style: `width:${attrs.width}` } : {},
              },
              tableStyle: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-style") || null,
                renderHTML: (attrs) =>
                  attrs.tableStyle ? { "data-style": attrs.tableStyle } : {},
              },
            },
          },
          {
            types: ["horizontalRule"],
            attributes: {
              dividerStyle: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-style") || null,
                renderHTML: (attrs) =>
                  attrs.dividerStyle ? { "data-style": attrs.dividerStyle } : {},
              },
            },
          },
        ],
        addKeyboardShortcuts: () => ({
          "Mod-e": () => {
            session.setMode(session.mode === "reading" ? "live" : "reading");
            return true;
          },
        }),
      }),
    ],
    editorProps: {
      attributes: {
        class: "rich-content",
        "aria-label": "Rich editor",
        spellcheck: "true",
      },
      transformPastedHTML: (html) => documentHtml(html),
      handleClick: (view, pos, event) => {
        const cell = (event.target as HTMLElement).closest('td,th');
        if (cell && !event.shiftKey && !event.ctrlKey && !event.metaKey && view.state.selection.empty) {
          const start = view.posAtDOM(cell, 0);
          const end = start + (view.state.doc.nodeAt(start)?.nodeSize || 1);
          editor.commands.setTextSelection(Math.max(start + 1, Math.min(pos, end - 1)));
          return true;
        }
        const link = (event.target as HTMLElement).closest("a");
        if (link && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
          event.preventDefault();
          showLinkBubble(link);
          return true;
        }
        return false;
      },
      // "[[" looks for a note, an article or a task to link.
      handleTextInput: (view, from, _to, text) => {
        if (text !== "[" || from < 1 || view.state.doc.textBetween(from - 1, from) !== "[") return false;
        editor.chain().deleteRange({ from: from - 1, to: from }).run();
        void openReferenceDialog().catch(error => toast((error as Error).message, "error"));
        return true;
      },
    },
    onUpdate: () => {
      sourceStale = true;
      clearTimeout(sourceTimer);
      sourceTimer = setTimeout(syncSource, 400);
      if (syncing) return;
      // The same document open in another pane follows this one.
      const shared = key(root);
      const peers = shared ? [...sessions].filter(([otherRoot]) => otherRoot !== root && key(otherRoot) === shared) : [];
      if (peers.length) {
        const html = source.value;
        for (const [, other] of peers)
          if (other.source.value !== html) {
            other.editor.commands.setContent(html, { emitUpdate: false });
            other.source.value = html;
          }
      }
      source.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
  });
  const session: Session = {
    editor,
    source,
    input,
    mode: "live",
    setMode(mode) {
      session.mode = mode;
      root.dataset.editorMode = mode;
      editor.setEditable(mode === "live" && !readOnly);
      host.hidden = mode !== "live";
      host.querySelector<HTMLElement>(".rich-block-handle")?.setAttribute("hidden", "");
      reading.hidden = mode !== "reading";
      root.querySelectorAll<HTMLInputElement>(".rich-page-header :is(input, select, textarea, button)").forEach(control => { control.disabled = mode === "reading" || readOnly; });
      if (mode === "reading") {
        reading.innerHTML = documentHtml(editor.getHTML());
        reading.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(box => { box.disabled = true; });
        hydrateEmbeds(reading, () => state.notes.find(n => String(n.id) === key(root))?.title || "");
      }
    },
  };
  sessions.set(root, session);
  source.value = editor.getHTML();
  session.setMode("live");
  root.addEventListener('keydown', event => {
    if (!event.defaultPrevented && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'e') {
      event.preventDefault();
      session.setMode(session.mode === 'reading' ? 'live' : 'reading');
    }
  });
  function currentBlock() {
    const sel = editor.state.selection;
    let depth = sel.$from.depth ? 1 : 0;
    for (let d = 1; d < sel.$from.depth; d++)
      if (sel.$from.node(d).type.name === "column") depth = d + 1;
    const pos = depth ? sel.$from.before(depth) : sel.from;
    return { pos, node: editor.state.doc.nodeAt(pos), parent: depth ? sel.$from.node(depth - 1) : editor.state.doc, start: depth ? sel.$from.start(depth - 1) : 0 };
  }
  let linkRange = {from: 0, to: 0};
  const linkDialog = root.querySelector<HTMLDialogElement>('.rich-link')!;
  linkDialog.querySelector('[data-cancel-link]')!.addEventListener('click', () => linkDialog.close());
  root.querySelectorAll<HTMLButtonElement>('[data-dialog-cancel]').forEach(button => button.addEventListener('click', () => button.closest('dialog')?.close()));
  linkDialog.querySelector('[data-insert-link]')!.addEventListener('click', insertLink);
  linkDialog.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) { event.preventDefault(); insertLink(); }
  });
  function insertLink() {
    if (!editor.isEditable || readOnly) return;
    let href = linkDialog.querySelector<HTMLInputElement>('[name="href"]')!.value.trim();
    const text = linkDialog.querySelector<HTMLInputElement>('[name="text"]')!.value.trim() || href;
    if (!/^(https?:|mailto:|#|\/)/i.test(href) && /^[\w.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(href)) href = 'https://' + href;
    if (!/^(https?:\/\/|mailto:|#|\/)/i.test(href)) {
      const error = linkDialog.querySelector<HTMLElement>('[role="alert"]')!;
      error.textContent = 'Enter a web address, an internal link or an email address with mailto:.'; error.hidden = false; return;
    }
    const selected = editor.state.doc.textBetween(linkRange.from, linkRange.to);
    if (selected && selected === text) editor.chain().focus().setTextSelection(linkRange).setLink({href}).run();
    else editor.chain().focus().insertContentAt(linkRange, {type: 'text', text, marks: [{type: 'link', attrs: {href, target: '_blank', rel: 'noopener noreferrer'}}]}).run();
    linkDialog.close();
  }
  function command(name: string) {
    if (readOnly) return;
    if (name.startsWith("link:") && name !== "link") {
      const link = menuLink;
      if (!link) return;
      if (name === "link:copy") { void navigator.clipboard?.writeText(link.href).then(() => toast("Link address copied")); return; }
      if (name === "link:open" || name === "link:beside") {
        void import("../linkNavigation").then(({ followLink }) => followLink(link, name === "link:beside"));
        return;
      }
      if (!editor.isEditable) return;
      const position = editor.view.posAtDOM(link, 0);
      editor.chain().focus().setTextSelection(position).extendMarkRange("link").run();
      if (name === "link:remove") editor.chain().focus().unsetLink().run();
      else command("link");
      return;
    }
    if (name.startsWith("split:")) {
      const split = splitAt(editor);
      if (split) splitAction(editor, split.pos, name.slice(6) as SplitAction, split.index);
      return;
    }
    if (name.startsWith("mode:")) { session.setMode(name.slice(5)); if (name === "mode:live") editor.commands.focus(); return; }
    if (!editor.isEditable && !["properties", "template"].includes(name)) return;
    const c = editor.chain().focus();
    const [kind, value] = name.split(/:(.*)/s);
    if (kind === "heading") { Number(value) ? c.setHeading({ level: Number(value) as 1 | 2 | 3 }).run() : c.setParagraph().run(); return; }
    if (kind === "font") { c.setFontFamily(value).run(); return; }
    if (kind === "size") { c.setFontSize(`${value}px`).run(); return; }
    if (kind === "width") {
      const type = ["image", "table", "column"].find(item => editor.isActive(item));
      if (type) c.updateAttributes(type, { width: `${value}%` }).run();
      return;
    }
    if (name === "color" || name === "highlight") { root.querySelector<HTMLInputElement>(`[data-format="${name}"]`)!.click(); return; }
    if (name === "clearFormat") { c.unsetAllMarks().clearNodes().run(); return; }
    const actions = {
      bold: () => c.toggleBold().run(),
      italic: () => c.toggleItalic().run(),
      underline: () => c.toggleUnderline().run(),
      strike: () => c.toggleStrike().run(),
      code: () => c.toggleCode().run(),
      codeBlock: () => c.toggleCodeBlock().run(),
      list: () => c.toggleBulletList().run(),
      task: () => c.toggleTaskList().run(),
      ordered: () => c.toggleOrderedList().run(),
      quote: () => c.toggleBlockquote().run(),
      heading: () => c.toggleHeading({ level: 2 }).run(),
      left: () => c.setTextAlign("left").run(),
      center: () => c.setTextAlign("center").run(),
      right: () => c.setTextAlign("right").run(),
      undo: () => c.undo().run(),
      redo: () => c.redo().run(),
      table: () =>
        c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
      row: () => c.addRowAfter().run(),
      column: () => c.addColumnAfter().run(),
      deleteRow: () => c.deleteRow().run() || editor.chain().focus().deleteTable().run(),
      deleteColumn: () => c.deleteColumn().run() || editor.chain().focus().deleteTable().run(),
      merge: () => c.mergeCells().run(),
      split: () => c.splitCell().run(),
      headerRow: () => c.toggleHeaderRow().run(),
      headerColumn: () => c.toggleHeaderColumn().run(),
    };
    if (actions[name]) {
      actions[name]();
      return;
    }
    if (name === "divider") {
      c.setHorizontalRule().run();
      return;
    }
    if (name.startsWith("dividerStyle:")) {
      const sel = editor.state.selection;
      if (sel instanceof NodeSelection && sel.node.type.name === "horizontalRule")
        editor.chain().focus().command(({ tr }) => { tr.setNodeMarkup(sel.from, undefined, { ...sel.node.attrs, dividerStyle: name.slice(13) || null }); return true; }).setNodeSelection(sel.from).run();
      return;
    }
    if (name === "deleteBlock") {
      const sel = editor.state.selection;
      if (sel instanceof NodeSelection) { c.deleteSelection().run(); return; }
      const { pos, node } = currentBlock();
      if (node) c.deleteRange({ from: pos, to: pos + node.nodeSize }).run();
      return;
    }
    if (name.startsWith("tableStyle:")) {
      c.updateAttributes("table", { tableStyle: name.slice(11) || null }).run();
      return;
    }
    if (name === "script") {
      const at = editor.state.selection.to;
      openScriptLibrary(script => {
        if (!editor.isDestroyed && editor.isEditable)
          editor.chain().focus().insertContentAt(Math.min(at, editor.state.doc.content.size), { type: "scriptBlock", attrs: { name: script.name, height: script.height, html: script.html, css: script.css, js: script.js } }).run();
      });
      return;
    }
    if (name === "reference") {
      void openReferenceDialog().catch(error => toast((error as Error).message, 'error'));
      return;
    }
    if (name === "template") {
      const note = state.notes.find(n => String(n.id) === key(root));
      if (!note) { toast('Templates are available for saved notes.', 'info'); return; }
      const templates = state.noteTemplates.filter(template => !template.archived);
      const dialog = root.querySelector<HTMLDialogElement>('.rich-template')!;
      const choices = dialog.querySelector<HTMLSelectElement>('[name="template"]')!;
      choices.replaceChildren(...templates.map(template => new Option(template.name, String(template.id))));
      dialog.querySelector<HTMLSelectElement>('[name="mode"]')!.value = 'insert';
      dialog.querySelector<HTMLElement>('[role="status"]')!.textContent = '';
      dialog.querySelector<HTMLElement>('[data-template-empty]')!.hidden = templates.length > 0;
      dialog.querySelector<HTMLButtonElement>('[data-apply-template]')!.disabled = !templates.length;
      updateTemplatePreview();
      dialog.showModal(); return;
    }
    if (name === "properties") {
      const note = state.notes.find((n) => String(n.id) === key(root));
      if (!note) {
        toast(
          "Properties are available for saved notes.",
          "info",
        );
        return;
      }
      const dialog = root.querySelector<HTMLDialogElement>(".rich-properties")!;
      for (const [field, value] of Object.entries({
        tags: (note.properties?.tags || []).join(", "),
        status: note.properties?.status || "draft",
        width: note.presentation?.width || "comfortable",
        theme: note.presentation?.theme || "paper",
      }))
        (dialog.querySelector(`[name="${field}"]`) as HTMLInputElement).value =
          value;
      dialog.querySelector<HTMLElement>('[role="status"]')!.textContent = "";
      dialog.showModal();
      return;
    }
    if (name === "aside") {
      c.insertContent("<aside><p>Callout</p></aside>").run();
      return;
    }
    if (name === "details") {
      c.insertContent(
        "<details open><summary>Collapsible section</summary><p>Content</p></details>",
      ).run();
      return;
    }
    if (name === "link") {
      const href = editor.getAttributes('link').href || '';
      if (href) editor.commands.extendMarkRange('link');
      linkRange = {from: editor.state.selection.from, to: editor.state.selection.to};
      const dialog = root.querySelector<HTMLDialogElement>('.rich-link')!;
      dialog.querySelector<HTMLInputElement>('[name="text"]')!.value = editor.state.doc.textBetween(linkRange.from, linkRange.to);
      dialog.querySelector<HTMLInputElement>('[name="href"]')!.value = href;
      dialog.querySelector<HTMLElement>('[role="alert"]')!.hidden = true;
      dialog.showModal();
      dialog.querySelector<HTMLInputElement>(href || linkRange.from !== linkRange.to ? '[name="href"]' : '[name="text"]')!.focus();
      return;
    }
    if (name === "image")
      root.querySelector<HTMLInputElement>("[data-image-upload]")!.click();
    const {pos: top, node, parent, start} = currentBlock();
    if (!node) return;
    if (name === "columns") {
      const next = editor.state.doc.nodeAt(top + node.nodeSize);
      if (node.type.name === "columns") {
        c.insertContentAt(
          { from: top, to: top + node.nodeSize },
          node.content.content.flatMap((col) =>
            col.content.content.map((n) => n.toJSON()),
          ),
        ).run();
        return;
      }
      c.insertContentAt(
        { from: top, to: top + node.nodeSize + (next?.nodeSize || 0) },
        {
          type: "columns",
          content: [
            { type: "column", content: [node.toJSON()] },
            {
              type: "column",
              content: next ? [next.toJSON()] : [{ type: "paragraph" }],
            },
          ],
        },
      ).run();
    }
    if (name === "up" || name === "down") {
      const blocks: { pos: number; node: any }[] = [];
      parent.forEach((n, p) => blocks.push({ pos: start + p, node: n }));
      const index = blocks.findIndex((b) => b.pos === top),
        target = blocks[index + (name === "up" ? -1 : 1)];
      if (!target) return;
      const from = Math.min(top, target.pos),
        to = Math.max(top + node.nodeSize, target.pos + target.node.nodeSize);
      c.insertContentAt(
        { from, to },
        name === "up"
          ? [node.toJSON(), target.node.toJSON()]
          : [target.node.toJSON(), node.toJSON()],
      ).run();
    }
  }
  type Entry =
    | { kind: "item"; name: string; label?: string; checked?: boolean; danger?: boolean }
    | { kind: "submenu"; label: string; icon: string; entries: Entry[] }
    | { kind: "heading"; label: string }
    | { kind: "quick"; names: string[] }
    | { kind: "range"; label: string; value: number }
    | { kind: "separator" };
  const item = (name: string, extra: Partial<Extract<Entry, { kind: "item" }>> = {}): Entry => ({ kind: "item", name, ...extra });
  const radio = (name: string, checked: boolean, label: string): Entry => ({ kind: "item", name, label, checked });
  const separator: Entry = { kind: "separator" };

  /** Every option of the editor, grouped by type; the groups that fit the selection come first. */
  function menuEntries(): Entry[] {
    const selected = editor.state.selection instanceof NodeSelection ? editor.state.selection.node : null;
    const linkEntries: Entry[] = menuLink ? [{ kind: "heading", label: "Link" }, item("link:open"),
      ...(menuLink.closest("#main-content") ? [item("link:beside")] : []), item("link:edit"), item("link:copy"), item("link:remove", { danger: true })] : [];
    const documentEntries: Entry[] = [item(session.mode === "reading" ? "mode:live" : "mode:reading"), item("template"), item("properties")];
    if (session.mode === "reading" || !editor.isEditable) return [...linkEntries.filter(entry => entry.kind !== "item" || ["link:open", "link:beside", "link:copy"].includes(entry.name)), { kind: "heading", label: "Document" }, ...documentEntries];
    const entries: Entry[] = [{ kind: "quick", names: ["bold", "italic", "underline", "strike", "code", "link"] }, ...linkEntries];
    const widthOf = (type: string) => parseInt(editor.getAttributes(type).width || "100", 10) || 100;
    if (editor.isActive("table")) {
      const style = editor.getAttributes("table").tableStyle || "";
      entries.push({ kind: "heading", label: "Table" }, item("row"), item("column"), item("deleteRow"), item("deleteColumn"),
        item("merge"), item("split"), item("headerRow"), item("headerColumn"),
        { kind: "submenu", label: "Table style", icon: "tableStyle", entries: tableStyles.map(([value, label]) => radio(`tableStyle:${value}`, style === value, label)) },
        { kind: "range", label: "Width", value: widthOf("table") });
    } else if (selected?.type.name === "image" || editor.isActive("image")) {
      entries.push({ kind: "heading", label: "Image" }, { kind: "range", label: "Width", value: widthOf("image") });
    } else if (selected?.type.name === "horizontalRule") {
      const style = selected.attrs.dividerStyle || "";
      entries.push({ kind: "heading", label: "Line" }, ...dividerStyles.map(([value, label]) => radio(`dividerStyle:${value}`, style === value, label)));
    }
    const split = splitAt(editor);
    if (split) {
      const columns = editor.state.doc.nodeAt(split.pos)?.childCount || 2;
      entries.push({ kind: "heading", label: "Split" }, item("split:equal"),
        ...(columns < MAX_COLUMNS ? [item("split:add")] : []), item("split:removeColumn"), item("split:unsplit"), item("split:delete", { danger: true }));
    }
    const level = editor.getAttributes("heading").level || 0;
    const textStyle = editor.getAttributes("textStyle");
    const align = ["center", "right"].find(value => editor.isActive({ textAlign: value })) || "left";
    entries.push(separator,
      { kind: "submenu", label: "Text", icon: "bold", entries: [
        { kind: "heading", label: "Style" },
        ...[["0", "Paragraph"], ["1", "Heading 1"], ["2", "Heading 2"], ["3", "Heading 3"]].map(([value, label]) => radio(`heading:${value}`, String(level) === value, label)),
        separator, ...["bold", "italic", "underline", "strike", "code"].map(name => item(name, { checked: editor.isActive(name) })),
        separator, item("color"), item("highlight"), item("clearFormat"),
      ] },
      { kind: "submenu", label: "Font", icon: "properties", entries: [
        { kind: "heading", label: "Family" }, ...fontFamilies.map(([value, label]) => radio(`font:${value}`, (textStyle.fontFamily || "system-ui") === value, label)),
        { kind: "heading", label: "Size" }, ...fontSizes.map(size => radio(`size:${size}`, (textStyle.fontSize || "") === `${size}px`, `${size} px`)),
      ] },
      { kind: "submenu", label: "Paragraph", icon: "left", entries: [
        ...["left", "center", "right"].map(value => radio(value, align === value, commands[value][0])),
        separator, ...["list", "ordered", "task", "quote", "codeBlock"].map(name => item(name, {
          checked: editor.isActive({ list: "bulletList", ordered: "orderedList", task: "taskList", quote: "blockquote", codeBlock: "codeBlock" }[name]!) })),
      ] },
      { kind: "submenu", label: "Insert", icon: "image", entries: [
        item("link"), item("reference"), separator,
        item("image"), item("table"), item("columns", { label: editor.isActive("columns") ? "Undo side by side" : undefined }), item("aside"), item("details"), item("divider"),
        separator, item("script"),
      ] },
      { kind: "submenu", label: "Block", icon: "up", entries: [item("up"), item("down"), separator, item("deleteBlock", { label: deleteLabel(selected), danger: true })] },
      { kind: "submenu", label: "Document", icon: "template", entries: documentEntries },
      separator, item("undo"), item("redo"));
    return entries;
  }
  function deleteLabel(selected: any) {
    const name = selected?.type.name;
    return name === "horizontalRule" ? "Delete the line" : name === "image" ? "Delete the image" : name === "scriptBlock" ? "Delete the script" : editor.isActive("table") ? "Delete the table" : "Delete the block";
  }

  const panels: HTMLElement[] = [];
  function panel(level: number) {
    while (panels.length <= level) {
      const element = document.createElement("div");
      element.className = "rich-context-menu" + (panels.length ? " rich-context-submenu" : "");
      element.setAttribute("role", "menu");
      element.setAttribute("aria-label", panels.length ? "Options" : "Document options");
      element.hidden = true;
      document.body.append(element);
      element.addEventListener("mousedown", event => { if (!(event.target instanceof HTMLInputElement)) event.preventDefault(); });
      panels.push(element);
    }
    return panels[level];
  }
  const submenus: Entry[][] = [];
  function renderEntries(entries: Entry[]) {
    return entries.map(entry => {
      if (entry.kind === "separator") return '<hr role="separator">';
      if (entry.kind === "heading") return `<h4>${escapeHtml(entry.label)}</h4>`;
      if (entry.kind === "range") return `<label class="rich-context-width">${escapeHtml(entry.label)}<input type="range" min="10" max="100" value="${entry.value}" aria-label="${escapeHtml(entry.label)}"><output>${entry.value}%</output></label>`;
      if (entry.kind === "quick") return `<div class="rich-context-quick" role="group" aria-label="Formatting">${entry.names.map(name => {
        const [label, icon, shortcut] = commands[name];
        return `<button type="button" role="menuitemcheckbox" aria-checked="${editor.isActive(name)}" data-context-command="${name}" title="${escapeHtml(label + (shortcut ? ` (${shortcut})` : ""))}" aria-label="${escapeHtml(label)}">${editorIcon(icon || name)}</button>`;
      }).join("")}</div>`;
      if (entry.kind === "submenu") {
        submenus.push(entry.entries);
        return `<button type="button" role="menuitem" aria-haspopup="menu" aria-expanded="false" data-submenu="${submenus.length - 1}">${editorIcon(entry.icon)}<span>${escapeHtml(entry.label)}</span><i aria-hidden="true">›</i></button>`;
      }
      const [label, icon, shortcut] = commands[entry.name] || [entry.name];
      const style = entry.name.startsWith("tableStyle:") ? "tableStyle" : entry.name.startsWith("dividerStyle:") ? "dividerStyle" : null;
      const role = entry.checked === undefined ? "menuitem" : "menuitemradio";
      return `<button type="button" role="${role}" ${entry.checked === undefined ? "" : `aria-checked="${entry.checked}"`} class="${entry.danger ? "danger" : ""}" data-context-command="${escapeHtml(entry.name)}">${editorIcon(style || icon || "properties")}<span>${escapeHtml(entry.label || label)}</span>${shortcut ? `<kbd>${escapeHtml(shortcut)}</kbd>` : ""}</button>`;
    }).join("");
  }
  function place(element: HTMLElement, x: number, y: number) {
    element.hidden = false;
    element.style.left = `${Math.max(8, Math.min(x, innerWidth - element.offsetWidth - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(y, innerHeight - element.offsetHeight - 8))}px`;
  }
  function closeSubmenu() {
    panels.slice(1).forEach(element => { element.hidden = true; });
    panels[0]?.querySelectorAll('[aria-expanded="true"]').forEach(button => button.setAttribute("aria-expanded", "false"));
  }
  function openSubmenu(button: HTMLElement, focus = false) {
    const entries = submenus[Number(button.dataset.submenu)];
    if (!entries) return;
    closeSubmenu();
    const element = panel(1);
    element.innerHTML = renderEntries(entries);
    button.setAttribute("aria-expanded", "true");
    element.hidden = false;
    const box = button.getBoundingClientRect();
    const right = box.right + element.offsetWidth + 8 <= innerWidth;
    place(element, right ? box.right - 2 : box.left - element.offsetWidth + 2, box.top - 6);
    if (focus) element.querySelector<HTMLButtonElement>("button")?.focus();
  }
  let restoreContextFocus = false;
  function closeContext() {
    const wasOpen = panels.some(element => !element.hidden);
    panels.forEach(element => { element.hidden = true; });
    if (wasOpen && restoreContextFocus && root.isConnected && session.mode === "live") editor.commands.focus();
    restoreContextFocus = false;
  }
  function openContext(x: number, y: number, keyboard = false) {
    if (readOnly) return;
    if (keyboard) menuLink = null;
    closeContext();
    submenus.length = 0;
    const element = panel(0);
    element.innerHTML = renderEntries(menuEntries());
    place(element, x, y);
    if (keyboard) element.querySelector<HTMLButtonElement>("button")?.focus();
  }
  const events = new AbortController();
  let menuLink: HTMLAnchorElement | null = null;
  const bubble = document.createElement("div");
  bubble.className = "rich-link-bubble";
  bubble.setAttribute("role", "toolbar");
  bubble.setAttribute("aria-label", "Link");
  bubble.hidden = true;
  document.body.append(bubble);
  let bubbleLink: HTMLAnchorElement | null = null;
  function hideLinkBubble() { bubble.hidden = true; bubbleLink = null; }
  async function showLinkBubble(link: HTMLAnchorElement) {
    const { describeLink } = await import("../linkNavigation");
    const target = describeLink(link);
    bubbleLink = link;
    const beside = link.closest("#main-content") && target.internal;
    bubble.innerHTML = `<span class="rich-link-bubble-target" title="${escapeHtml(target.href)}">${editorIcon(target.internal ? "reference" : "link")}<span><strong>${escapeHtml(target.title)}</strong><small>${escapeHtml(target.detail)}</small></span></span>
      <button type="button" data-bubble="link:open" title="Open (${mod}click)">Open</button>${beside ? '<button type="button" data-bubble="link:beside" title="Open beside (Shift+click)">Beside</button>' : ""}
      ${editor.isEditable ? `<button type="button" data-bubble="link:edit" aria-label="Edit the link" title="Edit the link">${editorIcon("edit")}</button><button type="button" data-bubble="link:remove" aria-label="Remove the link" title="Remove the link">×</button>` : ""}`;
    bubble.hidden = false;
    const box = link.getBoundingClientRect();
    bubble.style.left = `${Math.max(8, Math.min(box.left, innerWidth - bubble.offsetWidth - 8))}px`;
    bubble.style.top = `${box.bottom + 6 + bubble.offsetHeight > innerHeight ? box.top - bubble.offsetHeight - 6 : box.bottom + 6}px`;
  }
  bubble.addEventListener("mousedown", event => event.preventDefault());
  bubble.addEventListener("click", event => {
    const action = (event.target as HTMLElement).closest<HTMLElement>("[data-bubble]")?.dataset.bubble;
    if (!action || !bubbleLink) return;
    menuLink = bubbleLink;
    hideLinkBubble();
    command(action);
  });
  function menuOwner(target: EventTarget | null) {
    return panels.find(element => element.contains(target as globalThis.Node));
  }
  document.addEventListener("click", event => {
    if (!menuOwner(event.target)) return;
    const target = event.target as HTMLElement;
    const parent = target.closest<HTMLElement>("[data-submenu]");
    if (parent) { openSubmenu(parent, true); return; }
    const entry = target.closest<HTMLButtonElement>("[data-context-command]");
    if (entry) { const name = entry.dataset.contextCommand!; closeContext(); command(name); }
  }, { signal: events.signal });
  document.addEventListener("mouseover", event => {
    const owner = menuOwner(event.target);
    if (owner !== panels[0]) return;
    const parent = (event.target as HTMLElement).closest<HTMLElement>("[data-submenu]");
    if (parent && parent.getAttribute("aria-expanded") !== "true") openSubmenu(parent);
    else if (!parent && (event.target as HTMLElement).closest("button, label")) closeSubmenu();
  }, { signal: events.signal });
  document.addEventListener("input", event => {
    const slider = event.target as HTMLInputElement;
    if (!menuOwner(slider) || slider.type !== "range") return;
    slider.nextElementSibling!.textContent = `${slider.value}%`;
    command(`width:${slider.value}`);
  }, { signal: events.signal });
  document.addEventListener("keydown", event => {
    const owner = menuOwner(document.activeElement);
    if (!owner) { if (event.key === "Escape") closeContext(); return; }
    const items = [...owner.querySelectorAll<HTMLElement>("button, input")];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const sub = owner !== panels[0];
    if (event.key === "Escape" || (sub && event.key === "ArrowLeft")) {
      event.preventDefault();
      if (sub) { const parent = panels[0].querySelector<HTMLElement>('[aria-expanded="true"]'); closeSubmenu(); parent?.focus(); }
      else { restoreContextFocus = true; closeContext(); }
    } else if (event.key === "ArrowRight" && (document.activeElement as HTMLElement).dataset.submenu !== undefined) {
      event.preventDefault(); openSubmenu(document.activeElement as HTMLElement, true);
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && (document.activeElement as HTMLInputElement).type !== "range") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    }
  }, { signal: events.signal });
  function openFromEvent(event: MouseEvent) {
    if (readOnly) return;
    event.preventDefault(); event.stopPropagation();
    menuLink = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
    hideLinkBubble();
    if (session.mode === "live") {
      const hit = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
      const image = (event.target as HTMLElement).closest(".rich-image-node");
      const embed = (event.target as HTMLElement).closest(".kv-embed");
      const atom = hit && hit.inside >= 0 ? editor.state.doc.nodeAt(hit.inside) : null;
      if (image) {
        const position = (image as any).kavotImagePosition?.();
        if (typeof position === "number") editor.chain().focus().setNodeSelection(position).run();
      } else if (embed) {
        const position = (embed as any).kavotNodePosition?.();
        if (typeof position === "number") editor.chain().focus().setNodeSelection(position).run();
      } else if (atom?.isBlock && atom.isAtom) editor.chain().focus().setNodeSelection(hit!.inside).run();
      else if (hit && editor.state.selection.empty) editor.commands.setTextSelection(hit.pos);
    }
    openContext(event.clientX, event.clientY);
  }
  host.addEventListener("contextmenu", openFromEvent);
  reading.addEventListener("contextmenu", openFromEvent);
  for (const element of [host, reading]) element.addEventListener("keydown", event => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault(); event.stopPropagation();
      const point = session.mode === "live" ? editor.view.coordsAtPos(editor.state.selection.from) : element.getBoundingClientRect();
      openContext(point.left, session.mode === "live" ? point.bottom : point.top + 40, true);
    }
  });
  document.addEventListener("pointerdown", event => {
    if (!menuOwner(event.target)) closeContext();
    if (!bubble.contains(event.target as globalThis.Node) && !(event.target as Element)?.closest?.("a")) hideLinkBubble();
  }, { signal: events.signal });
  editor.on("update", hideLinkBubble);
  window.addEventListener("resize", closeContext, { signal: events.signal });
  document.addEventListener("scroll", event => { if (!menuOwner(event.target)) { closeContext(); hideLinkBubble(); } }, { capture: true, signal: events.signal });
  editor.on("destroy", () => { events.abort(); panels.forEach(element => element.remove()); bubble.remove(); });
  const referenceDialog = root.querySelector<HTMLDialogElement>('.rich-reference')!;
  const referenceQuery = referenceDialog.querySelector<HTMLInputElement>('[data-reference-query]')!;
  const referenceKind = referenceDialog.querySelector<HTMLSelectElement>('[data-reference-kind]')!;
  const referenceMatches = referenceDialog.querySelector<HTMLElement>('[data-reference-matches]')!;
  let referenceRange = {from: 0, to: 0};
  const KINDS: Record<string, string> = {notes: 'Note', articles: 'Article', tasks: 'Task'};
  let referenceItems: {title: string; detail: string; kind: string; href: string; search: string}[] = [];
  const searchText = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase();
  async function openReferenceDialog() {
    if (!editor.isEditable || readOnly) return;
    referenceRange = {from: editor.state.selection.from, to: editor.state.selection.to};
    const {collectionItems} = await import('../../collections/catalog');
    if (!root.isConnected || !editor.isEditable || readOnly) return;
    referenceItems = Object.keys(KINDS).flatMap(kind =>
      collectionItems(kind).filter(item => !item.source?.trashed_at && !item.source?.archived_at && !(item.type === 'note' && String(item.id) === key(root))).map(item => {
        const reference = {type: item.type, id: item.id, databaseId: kind};
        const href = item.type === 'note' ? `#note-${item.id}` : item.type === 'paper' ? `#paper-${item.id}` : '#record/' + encodeURIComponent(JSON.stringify(reference));
        const detail = String(item.detail || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
        return {title: String(item.title), detail, kind, href, search: searchText(`${item.title} ${detail} ${item.meta || ''}`)};
      })).sort((a, b) => a.title.localeCompare(b.title));
    referenceQuery.value = ''; renderReferences(); referenceDialog.showModal(); referenceQuery.focus();
  }
  function renderReferences() {
    const terms = searchText(referenceQuery.value.trim()).split(/\s+/).filter(Boolean);
    const kind = referenceKind.value;
    const matches = referenceItems.map((item, index) => ({item, index})).filter(({item}) => (!kind || item.kind === kind) && terms.every(term => item.search.includes(term)));
    const visible = matches.slice(0, 50);
    referenceMatches.innerHTML = visible.length ? visible.map(({item, index}) => `<button type="button" data-insert-reference="${index}">${editorIcon('reference')}<span><strong>${escapeHtml(item.title)}</strong><small>${KINDS[item.kind]}${item.detail ? ' · ' + escapeHtml(item.detail.slice(0, 100)) : ''}</small></span></button>`).join('') : '<p>No items found.</p>';
    referenceDialog.querySelector<HTMLElement>('[data-reference-count]')!.textContent = matches.length > 50 ? `50 of ${matches.length} items. Refine the search.` : `${matches.length} item${matches.length === 1 ? '' : 's'}`;
  }
  referenceQuery.addEventListener('input', renderReferences);
  referenceKind.addEventListener('change', renderReferences);
  referenceDialog.querySelector('[data-reference-dialog-close]')!.addEventListener('click', () => referenceDialog.close());
  referenceDialog.addEventListener('close', () => { if (root.isConnected && editor.isEditable) editor.commands.focus(); });
  referenceMatches.addEventListener('click', event => {
    if (!editor.isEditable || readOnly) return;
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-insert-reference]');
    const item = button && referenceItems[Number(button.dataset.insertReference)];
    if (!item) return;
    const text = editor.state.doc.textBetween(referenceRange.from, referenceRange.to) || item.title;
    editor.chain().focus().insertContentAt(referenceRange, {type: 'text', text, marks: [{type: 'link', attrs: {href: item.href, target: null, rel: null}}]}).run();
    editor.view.dispatch(editor.state.tr.removeStoredMark(editor.schema.marks.link));
    referenceDialog.close();
  });
  referenceDialog.addEventListener('keydown', event => {
    const buttons = [...referenceMatches.querySelectorAll<HTMLButtonElement>('button')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Enter' && event.target === referenceQuery) { event.preventDefault(); buttons[0]?.click(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (event.target === referenceKind) return;
      event.preventDefault();
      const target = index < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[target]?.focus();
    }
  });
  async function flushDocumentSaves() {
    const [workspace, canvas] = await Promise.all([import('../workspace'), import('../canvas')]);
    await workspace.flushCurrentNoteAutosave();
    await workspace.flushSecondaryNoteAutosave();
    await workspace.flushWorkspaceMarkdownSaves();
    await canvas.flushCanvasSaves();
    await flushReaderAutosave();
    await flushAgentSaves();
    if (document.querySelector('.note-autosave-state[data-state="error"]')) throw new Error("Save the note before applying this change. The last save failed.");
  }
  function updateTemplatePreview() {
    const dialog = root.querySelector<HTMLDialogElement>('.rich-template')!;
    const template = state.noteTemplates.find(item => String(item.id) === dialog.querySelector<HTMLSelectElement>('[name="template"]')!.value);
    dialog.querySelector<HTMLElement>('[data-template-preview]')!.innerHTML = template ? documentHtml(template.content_template) : '';
    const replace = dialog.querySelector<HTMLSelectElement>('[name="mode"]')!.value === 'replace';
    dialog.querySelector<HTMLElement>('[data-template-replace-warning]')!.hidden = !replace;
    dialog.querySelector<HTMLButtonElement>('[data-apply-template]')!.textContent = replace ? 'Replace the note' : 'Add the template';
  }
  root.querySelectorAll('.rich-template select').forEach(select => select.addEventListener('change', updateTemplatePreview));
  root.querySelector('[data-apply-template]')!.addEventListener('click', async () => {
    const note = state.notes.find(n => String(n.id) === key(root));
    if (!note || readOnly) return;
    const dialog = root.querySelector<HTMLDialogElement>('.rich-template')!;
    const apply = dialog.querySelector<HTMLButtonElement>('[data-apply-template]')!;
    const status = dialog.querySelector<HTMLElement>('[role="status"]')!;
    apply.disabled = true; status.textContent = 'Saving the note…';
    try {
      await flushDocumentSaves();
      const template = dialog.querySelector<HTMLSelectElement>('[name="template"]')!.value;
      const mode = dialog.querySelector<HTMLSelectElement>('[name="mode"]')!.value;
      const updated = await api(`/notes/${note.id}/template/${template}`, {method: 'POST', body: JSON.stringify({mode, cursor: editor.getHTML().length})});
      Object.assign(note, updated);
      document.querySelectorAll<HTMLInputElement>(`[data-note-title-input="${note.id}"]`).forEach(field => { field.value = note.title; });
      const canvasTitle = root.closest('#canvas-details-form')?.querySelector<HTMLInputElement>('[name="title"]');
      if (canvasTitle) canvasTitle.value = note.title;
      for (const [otherRoot, other] of sessions) if (key(otherRoot) === key(root)) {
        otherRoot.dataset.assetBase = noteAssetBase(note);
        other.editor.commands.setContent(documentHtml(note.content, noteAssetBase(note)), {emitUpdate: true});
        if (other.mode === 'reading') other.setMode('reading');
      }
      applyPresentation(); dialog.close();
      const workspace = await import('../workspace');
      await workspace.refreshWorkspaceTreeOnly();
      toast(mode === 'insert' ? 'Template added to the note.' : 'Template applied to the note.');
    } catch(error) { status.textContent = (error as Error).message; }
    finally { apply.disabled = false; }
  });
  (input as any).kavotCommand = command;
  root
    .querySelector("[data-save-properties]")!
    .addEventListener("click", async () => {
      const note = state.notes.find((n) => String(n.id) === key(root));
      if (!note || readOnly) return;
      const dialog = root.querySelector<HTMLDialogElement>(".rich-properties")!,
        status = dialog.querySelector('[role="status"]')!;
      const value = (name: string) =>
        (dialog.querySelector(`[name="${name}"]`) as HTMLInputElement).value;
      try {
        await flushDocumentSaves();
        const saved = await api(`/notes/${note.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            expected_hash: note.content_hash,
            properties: {
              ...note.properties,
              tags: value("tags")
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean),
              status: value("status"),
            },
            presentation: {
              ...note.presentation,
              width: value("width"),
              theme: value("theme"),
            },
          }),
        });
        Object.assign(note, saved);
        applyPresentation();
        dialog.close();
      } catch (error) {
        status.textContent = (error as Error).message;
      }
    });
  function applyPresentation() {
    const pane = root.closest<HTMLElement>("[data-primary-note-id],[data-secondary-note-id],[data-agent-note-id]");
    const note = state.notes.find((n) => String(n.id) === (pane?.dataset.agentNoteId || pane?.dataset.primaryNoteId || pane?.dataset.secondaryNoteId));
    const presentation = note?.presentation || {};
    host.style.maxWidth = "none";
    host.style.margin = "0";
    host.style.width = "100%";
    // The page background follows the note's saved theme in light and dark app themes alike;
    // without one the app surface shows through, so a note never renders on plain white.
    const background = { cream: "#fffaf0", slate: "#eef3f7" }[presentation.theme] || "var(--surface)";
    host.style.background = background;
    reading.style.background = background;
  }
  applyPresentation();
  Object.defineProperties(input, {
    value: {
      get: () => editor.getHTML(),
      set: (value) => {
        syncing = true;
        editor.commands.setContent(
          documentHtml(String(value), root.dataset.assetBase),
          { emitUpdate: false },
        );
        source.value = editor.getHTML();
        syncing = false;
      },
    },
    selectionStart: { get: () => offset(editor) },
    selectionEnd: { get: () => offset(editor) },
  });
  input.focus = () => {
    editor.commands.focus();
  };
  input.setSelectionRange = () => {};
  input.setRangeText = (text) => {
    if (editor.isEditable)
      editor
        .chain()
        .focus()
        .insertContent(documentHtml(text, root.dataset.assetBase))
        .run();
  };
  root.querySelectorAll<HTMLInputElement>("[data-format]").forEach((el) =>
    el.addEventListener("input", () => {
      if (!editor.isEditable) return;
      const c = editor.chain().focus();
      switch (el.dataset.format) {
        case "color":
          c.setColor(el.value).run();
          break;
        case "highlight":
          c.setHighlight({ color: el.value }).run();
          break;
      }
    }),
  );
  /** Send an image to the note (or next to the workspace document) and show it, at `position` if given. */
  async function insertUploadedImage(file: File, position?: number) {
    if (!editor.isEditable) return;
    const form = new FormData();
    form.append("file", file);
    const noteId = root.closest<HTMLElement>(
      "[data-primary-note-id],[data-secondary-note-id]",
    );
    const id =
      noteId?.dataset.primaryNoteId || noteId?.dataset.secondaryNoteId;
    const workspacePath = root.closest<HTMLElement>('[data-workspace-markdown-path]')?.dataset.workspaceMarkdownPath;
    if (!id && workspacePath) form.append('target_path', workspacePath);
    try {
      const result = await api(
        id ? `/notes/${id}/assets` : "/workspace/file",
        { method: "POST", body: form },
      );
      if (!editor.isDestroyed && editor.isEditable) {
        const chain = editor.chain().focus();
        (position === undefined ? chain : chain.setTextSelection(Math.min(position, editor.state.doc.content.size)))
          .setImage({ src: result.url, alt: file.name.replace(/\.[^.]+$/, '') })
          .run();
      }
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }
  root
    .querySelector<HTMLInputElement>("[data-image-upload]")!
    .addEventListener("change", async (event) => {
      const upload = event.target as HTMLInputElement,
        file = upload.files?.[0];
      if (file) await insertUploadedImage(file);
      upload.value = "";
    });
  // While dragging, only the kind of the files is known: accept images only, so other files keep their default.
  const draggedImage = (transfer: DataTransfer | null) =>
    [...(transfer?.items || [])].some((item) => item.kind === "file" && item.type.startsWith("image/"));
  const droppedImages = (transfer: DataTransfer | null) =>
    [...(transfer?.files || [])].filter((file) => file.type.startsWith("image/") && file.size > 0);
  let dragging: { from: number; to: number; node: any } | null = null;
  const blockHandle = document.createElement('button');
  blockHandle.type = 'button'; blockHandle.className = 'rich-block-handle'; blockHandle.dataset.dragBlock = '';
  blockHandle.draggable = true; blockHandle.textContent = '⠿'; blockHandle.title = 'Move this block: drag, or click for options';
  blockHandle.setAttribute('aria-label', 'Move this block'); blockHandle.hidden = true;
  host.append(blockHandle);
  let hoveredBlock: {pos: number; node: any} | null = null;
  let grabbedBlock: {pos: number; node: any} | null = null;
  function selectHoveredBlock() {
    if (!hoveredBlock || !editor.isEditable) return;
    if (hoveredBlock.node.isTextblock) editor.commands.setTextSelection(hoveredBlock.pos + 1);
    else editor.commands.setNodeSelection(hoveredBlock.pos);
  }
  host.addEventListener('mousemove', event => {
    if (!editor.isEditable || (grabbedBlock && event.buttons) || (event.target as Element).closest('.rich-block-handle')) return;
    const hit = editor.view.posAtCoords({left: event.clientX, top: event.clientY});
    if (!hit) { blockHandle.hidden = true; return; }
    const resolved = editor.state.doc.resolve(hit.pos);
    let depth = resolved.depth ? 1 : 0;
    for (let d = 1; d < resolved.depth; d++) if (resolved.node(d).type.name === 'column') depth = d + 1;
    const pos = depth ? resolved.before(depth) : hit.pos;
    const node = editor.state.doc.nodeAt(pos);
    const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
    if (!node || !dom?.getBoundingClientRect) return;
    hoveredBlock = {pos, node};
    const box = dom.getBoundingClientRect(), area = host.getBoundingClientRect();
    blockHandle.style.top = `${box.top - area.top + host.scrollTop}px`;
    blockHandle.hidden = false;
  });
  host.addEventListener('mouseleave', () => { if (!dragging && !grabbedBlock) blockHandle.hidden = true; });
  // Hovering a table reveals "+" controls to append a column (right) or a row (bottom).
  const tableAdd = (['column', 'row'] as const).map(kind => {
    const control = document.createElement('button');
    control.type = 'button'; control.className = 'rich-table-add'; control.dataset.tableAdd = kind; control.hidden = true; control.textContent = '+';
    control.title = kind === 'column' ? 'Add a column at the end of the table' : 'Add a row at the end of the table';
    control.setAttribute('aria-label', control.title);
    host.append(control);
    return control;
  });
  let hoveredTable: HTMLTableElement | null = null;
  function placeTableControls(table: HTMLTableElement | null) {
    hoveredTable = table && editor.isEditable ? table : null;
    tableAdd.forEach(control => { control.hidden = !hoveredTable; });
    if (!hoveredTable) return;
    const box = hoveredTable.getBoundingClientRect(), area = host.getBoundingClientRect();
    const visibleRight = Math.min(box.right, hoveredTable.closest('.tableWrapper')?.getBoundingClientRect().right ?? box.right);
    const [column, row] = tableAdd;
    Object.assign(column.style, { left: `${visibleRight - area.left + 4}px`, top: `${box.top - area.top + host.scrollTop}px`, height: `${box.height}px` });
    Object.assign(row.style, { left: `${box.left - area.left}px`, top: `${box.bottom - area.top + host.scrollTop + 4}px`, width: `${visibleRight - box.left}px` });
  }
  host.addEventListener('mousemove', event => {
    const target = event.target as HTMLElement;
    if (target.closest('.rich-table-add')) return;
    const table = target.closest<HTMLTableElement>('.rich-content table');
    if (table) { placeTableControls(table); return; }
    if (!hoveredTable) return;
    const box = hoveredTable.getBoundingClientRect();
    if (event.clientX > box.right + 30 || event.clientY > box.bottom + 30 || event.clientX < box.left - 10 || event.clientY < box.top - 10) placeTableControls(null);
  });
  host.addEventListener('mouseleave', () => placeTableControls(null));
  tableAdd.forEach(control => {
    control.addEventListener('mousedown', event => event.preventDefault());
    control.addEventListener('click', () => {
      const table = hoveredTable;
      if (!table || !editor.isEditable || readOnly) return;
      const rows = table.querySelectorAll<HTMLTableRowElement>(':scope > tbody > tr, :scope > tr');
      const cell = control.dataset.tableAdd === 'column' ? rows[0]?.cells[rows[0].cells.length - 1] : rows[rows.length - 1]?.cells[0];
      if (!cell) return;
      const pos = editor.view.posAtDOM(cell, 0);
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(pos))));
      const chain = editor.chain().focus();
      (control.dataset.tableAdd === 'column' ? chain.addColumnAfter() : chain.addRowAfter()).run();
      requestAnimationFrame(() => placeTableControls(table.isConnected ? table : null));
    });
  });
  blockHandle.addEventListener('mousedown', () => { grabbedBlock = hoveredBlock; });
  document.addEventListener('mouseup', () => { if (!dragging) grabbedBlock = null; }, {signal: events.signal});
  blockHandle.addEventListener('click', () => {
    selectHoveredBlock(); grabbedBlock = null; const box = blockHandle.getBoundingClientRect(); openContext(box.right, box.bottom, true);
  });
  editor.on('update', () => { blockHandle.hidden = true; hoveredBlock = null; if (hoveredTable) placeTableControls(hoveredTable.isConnected ? hoveredTable : null); });
  blockHandle
    .addEventListener("dragstart", (event: DragEvent) => {
      if (!editor.isEditable) {
        event.preventDefault();
        return;
      }
      const block = grabbedBlock || hoveredBlock;
      if (!block) return;
      if (!block.node) return;
      dragging = {
        from: block.pos,
        to: block.pos + block.node.nodeSize,
        node: block.node,
      };
      event.dataTransfer!.setData("application/x-kavot-rich-block", "move");
      event.dataTransfer!.effectAllowed = "move";
    });
  root.addEventListener("dragend", () => {
    dragging = null;
    grabbedBlock = null;
    blockHandle.hidden = true;
  });
  root.addEventListener(
    "dragover",
    (event) => {
      if (
        editor.isEditable &&
        (dragging || hasInternalTransfer(event.dataTransfer) || draggedImage(event.dataTransfer))
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true,
  );
  root.addEventListener(
    "drop",
    (event) => {
      if (!editor.isEditable) return;
      const hit = editor.view.posAtCoords({
        left: event.clientX,
        top: event.clientY,
      });
      // Images dropped from the computer are added to the note and shown where they land.
      const images = droppedImages(event.dataTransfer);
      if (images.length) {
        event.preventDefault();
        event.stopPropagation();
        void (async () => {
          for (const image of images.slice(0, 10)) await insertUploadedImage(image, hit?.pos);
        })();
        return;
      }
      if (dragging && hit) {
        event.preventDefault();
        event.stopPropagation();
        const { from, to, node } = dragging;
        dragging = null;
        const resolved = editor.state.doc.resolve(hit.pos);
        let depth = resolved.depth ? 1 : 0;
        for (let d = 1; d < resolved.depth; d++)
          if (resolved.node(d).type.name === "column") depth = d + 1;
        let destination = depth ? resolved.before(depth) : hit.pos;
        const targetNode = editor.state.doc.nodeAt(destination);
        const targetDom = editor.view.nodeDOM(destination) as HTMLElement | null;
        const box = targetDom?.getBoundingClientRect?.();
        if (targetNode && box && event.clientY > box.top + box.height / 2)
          destination += targetNode.nodeSize;
        if (destination >= from && destination <= to) return;
        const tr = editor.state.tr.delete(from, to);
        const pos = tr.mapping.map(destination);
        tr.insert(pos, node);
        editor.view.dispatch(tr);
        return;
      }
      if (hasInternalTransfer(event.dataTransfer)) {
        const link = droppedLink(internalTransfer(event.dataTransfer));
        if (link) {
          event.preventDefault();
          event.stopPropagation();
          editor
            .chain()
            .focus()
            .insertContentAt(
              hit?.pos ?? editor.state.selection.from,
              documentHtml(link),
            )
            .run();
        }
      }
    },
    true,
  );
  onDisconnect(root, () => {
    if (sessions.get(root) !== session) return;
    syncSource();
    editor.destroy();
    sessions.delete(root);
  });
}
