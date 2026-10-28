/** Script blocks: the editor node, the script editor dialog and the "Insert a script" picker. */
import { Node, mergeAttributes } from "@tiptap/core";
import { escapeHtml, state } from "../../../app/state";
import { toast } from "../../../app/navigation";
import { deleteLibraryScript, saveLibraryScript } from "../scriptLibrary";
import { scriptExamples } from "../scriptExamples";
import { emptyScript, runScript, scriptFromElement, type ScriptSource } from "./scriptRuntime";
import { deleteNode, dialogShell, embedIcon } from "./shared";

const FIXED_HEIGHTS = [160, 240, 320, 480, 640];
const isFixedHeight = (height: string) => /^\d+$/.test(height);
const MIN_HEIGHT = 60, MAX_HEIGHT = 2400;
const clampHeight = (height: number) => Math.round(Math.min(Math.max(height, MIN_HEIGHT), MAX_HEIGHT));

type ScriptViewOptions = { editable: () => boolean; onEdit?: () => void; onDelete?: () => void; onResize?: (height: string) => void; noteTitle?: () => string };

/** Render a script block (header + sandboxed result) into `dom`. */
export function mountScript(dom: HTMLElement, initial: ScriptSource, options: ScriptViewOptions) {
  dom.classList.add("kv-embed", "kv-script");
  dom.innerHTML = `<header class="kv-embed-head">
      <span class="kv-embed-icon">${embedIcon("script")}</span>
      <strong data-script-title></strong>
      <small class="kv-script-error" role="status" hidden></small>
      <span class="kv-embed-actions">
        <button type="button" data-script-run title="Run the script again" aria-label="Run the script again">${embedIcon("run")}</button>
        <button type="button" data-script-edit title="Edit the script" aria-label="Edit the script">${embedIcon("edit")}<span>Edit</span></button>
        <button type="button" data-embed-delete title="Delete the script" aria-label="Delete the script">${embedIcon("trash")}</button>
      </span>
    </header>
    <iframe class="kv-script-frame" title="Script output"></iframe>
    <div class="kv-script-resize" role="separator" aria-orientation="horizontal" tabindex="0" aria-label="Resize the script output" title="Drag to resize · double-click for automatic height"></div>`;
  const frame = dom.querySelector("iframe")!;
  const error = dom.querySelector<HTMLElement>(".kv-script-error")!;
  const editButton = dom.querySelector<HTMLElement>("[data-script-edit]")!;
  const deleteButton = dom.querySelector<HTMLElement>("[data-embed-delete]")!;
  const resizer = dom.querySelector<HTMLElement>(".kv-script-resize")!;
  let script = initial;

  function run() {
    error.hidden = true;
    frame.style.height = isFixedHeight(script.height) ? `${script.height}px` : "60px";
    runScript(frame, script, {
      noteTitle: options.noteTitle,
      onSize: height => { if (!isFixedHeight(script.height) && !dom.classList.contains("kv-script-resizing")) frame.style.height = `${Math.min(Math.max(height, 24), 2400)}px`; },
      onError: message => { error.textContent = message; error.title = message; error.hidden = false; },
    });
  }
  /** Keep the chosen height locally (no rerun) and let the host persist it. */
  function setHeight(height: string) {
    script = { ...script, height };
    if (isFixedHeight(height)) frame.style.height = `${height}px`; else run();
    options.onResize?.(height);
  }
  function syncActions() {
    editButton.hidden = !options.editable() || !options.onEdit;
    deleteButton.hidden = !options.editable() || !options.onDelete;
  }
  function render() {
    dom.querySelector("[data-script-title]")!.textContent = script.name || "Script";
    syncActions();
    run();
  }

  dom.querySelector("[data-script-run]")!.addEventListener("click", run);
  resizer.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY, startHeight = frame.getBoundingClientRect().height;
    resizer.setPointerCapture(event.pointerId);
    dom.classList.add("kv-script-resizing");
    const move = (moveEvent: PointerEvent) => { frame.style.height = `${clampHeight(startHeight + moveEvent.clientY - startY)}px`; };
    const stop = () => {
      dom.classList.remove("kv-script-resizing");
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", stop);
      resizer.removeEventListener("pointercancel", stop);
      setHeight(String(clampHeight(frame.getBoundingClientRect().height)));
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", stop);
    resizer.addEventListener("pointercancel", stop);
  });
  resizer.addEventListener("keydown", event => {
    const step = { ArrowUp: -20, ArrowDown: 20 }[event.key];
    if (!step) return;
    event.preventDefault();
    setHeight(String(clampHeight(frame.getBoundingClientRect().height + step)));
  });
  resizer.addEventListener("dblclick", () => setHeight("auto"));
  editButton.addEventListener("click", () => options.onEdit?.());
  deleteButton.addEventListener("click", () => options.onDelete?.());
  render();
  return {
    update(next: ScriptSource) {
      const changed = JSON.stringify({ ...next, height: "" }) !== JSON.stringify({ ...script, height: "" });
      const resized = next.height !== script.height;
      script = next;
      if (changed || (resized && !isFixedHeight(next.height))) render();
      else {
        if (resized) frame.style.height = `${next.height}px`;
        syncActions();
      }
    },
  };
}

const codeAttribute = (lang: "html" | "css" | "js") => ({ default: "", parseHTML: (el: HTMLElement) => scriptFromElement(el)[lang], renderHTML: () => ({}) });

/** Stored as <div data-type="script-block"> with one inert <pre data-lang> per language. */
export const ScriptBlock = Node.create({
  name: "scriptBlock",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes: () => ({
    name: { default: "Script", parseHTML: el => el.getAttribute("data-script-name") || "Script", renderHTML: attrs => ({ "data-script-name": attrs.name }) },
    height: { default: "auto", parseHTML: el => el.getAttribute("data-height") || "auto", renderHTML: attrs => ({ "data-height": attrs.height }) },
    html: codeAttribute("html"),
    css: codeAttribute("css"),
    js: codeAttribute("js"),
  }),
  parseHTML: () => [{ tag: 'div[data-type="script-block"]' }],
  renderHTML({ node, HTMLAttributes }) {
    const parts = (["html", "css", "js"] as const)
      .filter(lang => node.attrs[lang])
      .map(lang => ["pre", { "data-lang": lang }, ["code", {}, node.attrs[lang]]]);
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "script-block" }), ...parts] as any;
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement("div");
      dom.contentEditable = "false";
      (dom as any).kavotNodePosition = getPos; // lets the editor context menu select this block
      if (node.attrs.id) dom.id = node.attrs.id;
      const source = (n = node): ScriptSource => ({ name: n.attrs.name, height: n.attrs.height, html: n.attrs.html, css: n.attrs.css, js: n.attrs.js });
      const view = mountScript(dom, source(), {
        editable: () => editor.isEditable,
        noteTitle: () => document.querySelector<HTMLInputElement>("[data-note-title-input]")?.value || "",
        onDelete: () => deleteNode(editor, getPos),
        onResize: height => {
          const pos = getPos();
          if (typeof pos === "number" && editor.isEditable)
            editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, height }));
        },
        onEdit: () => openScriptEditor(source(), {
          onSave: next => {
            const pos = getPos();
            if (typeof pos === "number" && editor.isEditable)
              editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...next }));
          },
        }),
      });
      return {
        dom,
        update(updated) {
          if (updated.type.name !== "scriptBlock") return false;
          node = updated;
          view.update(source(updated));
          return true;
        },
        stopEvent: event => !!(event.target as Element)?.closest?.(".kv-embed-head button, iframe, .kv-script-resize"),
        ignoreMutation: () => true,
      };
    };
  },
});

/** Tab indents, Shift+Tab outdents, inside the code textareas. */
function codeArea(textarea: HTMLTextAreaElement) {
  textarea.spellcheck = false;
  textarea.addEventListener("keydown", event => {
    if (event.key !== "Tab" || event.ctrlKey || event.altKey || event.metaKey) return;
    event.preventDefault();
    const { selectionStart: start, selectionEnd: end, value } = textarea;
    if (event.shiftKey) {
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      if (value.slice(lineStart, lineStart + 2) === "  ") {
        textarea.setRangeText("", lineStart, lineStart + 2, "preserve");
        textarea.setSelectionRange(Math.max(lineStart, start - 2), Math.max(lineStart, end - 2));
      }
    } else textarea.setRangeText("  ", start, end, "end");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const tabs = ["html", "css", "js"] as const;
const tabLabels = { html: "HTML", css: "CSS", js: "JavaScript" };
const placeholders = {
  html: '<div id="app"></div>',
  css: "#app { color: var(--accent); }",
  js: "// kavot.items('tasks'), kavot.collections(), kavot.toast('…')",
};
const API_HELP = `<details class="kv-help"><summary>API available to scripts</summary><ul>
  <li><code>await kavot.collections()</code>: list of collections.</li>
  <li><code>await kavot.items('tasks')</code>: items of a collection, with <code>title</code>, <code>detail</code> and <code>fields</code>.</li>
  <li><code>await kavot.note()</code>: title, text, word count and headings of the note.</li>
  <li><code>kavot.scrollTo(id)</code>: scrolls the note to a heading.</li>
  <li><code>kavot.open(item)</code>: opens an item in Kavot.</li>
  <li><code>kavot.toast('message')</code>: shows a notification.</li>
  <li><code>await kavot.fetch(url, options)</code>: calls a web address like <code>fetch</code> and returns a <code>Response</code>. You approve each new URL the first time; local and private addresses are refused.</li>
  <li>The theme’s CSS variables (<code>var(--accent)</code>, <code>var(--line)</code>…) are available.</li>
  <li>Libraries can be loaded with <code>import</code> from cdn.jsdelivr.net, unpkg.com, esm.sh or cdnjs. Scripts have no file access, and <code>fetch</code> itself is blocked: use <code>kavot.fetch</code>.</li>
</ul></details>`;

type EditorOptions = {
  onSave: (script: ScriptSource) => void | Promise<void>;
  saveLabel?: string;
  title?: string;
  /** Edit a library entry (description, author, tags) instead of a block in a note. */
  metadata?: boolean;
};

/** Full-screen code editor with a live, isolated preview. */
export function openScriptEditor(initial: ScriptSource, options: EditorOptions) {
  const title = options.title || "Script editor";
  const dialog = dialogShell("kv-script-editor", title);
  dialog.innerHTML = `<form method="dialog">
    <header class="kv-dialog-head"><h3>${escapeHtml(title)}</h3><button type="button" class="kv-icon-button" data-close aria-label="Close">${embedIcon("close", 16)}</button></header>
    <div class="kv-script-meta">
      <label>Name<input name="name" required maxlength="120"></label>
      <label>Height<select name="height"><option value="auto">Automatic</option>${FIXED_HEIGHTS.map(h => `<option value="${h}">${h} px</option>`).join("")}</select></label>
      <label>Library<select name="library" aria-label="Load an existing script"><option value="">Load a script…</option></select></label>
    </div>
    ${options.metadata ? `<div class="kv-script-meta kv-script-meta-library">
      <label>Description<input name="description" maxlength="1000" placeholder="What does this script do?"></label>
      <label>Author<input name="author" maxlength="120"></label>
      <label>Tags<input name="tags" placeholder="tasks, chart"></label>
    </div>` : ""}
    <div class="kv-script-workspace">
      <section class="kv-code">
        <div class="kv-tabs" role="tablist">${tabs.map(tab => `<button type="button" role="tab" data-tab="${tab}" aria-selected="${tab === "js"}">${tabLabels[tab]}</button>`).join("")}</div>
        ${tabs.map(tab => `<textarea name="${tab}" aria-label="${tabLabels[tab]} code" ${tab === "js" ? "" : "hidden"} placeholder="${escapeHtml(placeholders[tab])}"></textarea>`).join("")}
        ${API_HELP}
      </section>
      <section class="kv-preview">
        <header><span>Preview</span><small role="status" class="kv-script-error" hidden></small><button type="button" class="kv-icon-button" data-preview-run aria-label="Rerun the preview">${embedIcon("run")}</button></header>
        <iframe title="Script preview"></iframe>
      </section>
    </div>
    <footer class="form-actions">
      <button type="button" data-library-save ${options.metadata ? "hidden" : ""}>${embedIcon("save")} Save to library</button>
      <span class="kv-spacer"></span>
      <button type="button" data-close>Cancel</button>
      <button type="submit" class="primary">${escapeHtml(options.saveLabel || "Apply")}</button>
    </footer>
  </form>`;

  const form = dialog.querySelector("form")!;
  const field = <T extends HTMLElement = HTMLInputElement>(name: string) => form.querySelector<T>(`[name="${name}"]`)!;
  const code = (tab: string) => field<HTMLTextAreaElement>(tab);

  function fill(script: ScriptSource) {
    field("name").value = script.name;
    const height = field<HTMLSelectElement>("height");
    if (isFixedHeight(script.height) && !FIXED_HEIGHTS.includes(Number(script.height)))
      height.add(new Option(`${script.height} px (resized)`, script.height));
    height.value = isFixedHeight(script.height) ? script.height : "auto";
    tabs.forEach(tab => { code(tab).value = script[tab] || ""; });
    if (options.metadata) {
      field("description").value = script.description || "";
      field("author").value = script.author || "";
      field("tags").value = (script.tags || []).join(", ");
    }
  }
  function read(): ScriptSource {
    const script: ScriptSource = {
      name: field("name").value.trim() || "Script",
      height: field<HTMLSelectElement>("height").value,
      html: code("html").value,
      css: code("css").value,
      js: code("js").value,
    };
    if (!options.metadata) return script;
    return {
      ...script,
      description: field("description").value.trim(),
      author: field("author").value.trim(),
      tags: field("tags").value.split(",").map(tag => tag.trim()).filter(Boolean).slice(0, 20),
    };
  }

  // "Load a script…" replaces only the code; library metadata being edited is kept.
  const library = field<HTMLSelectElement>("library");
  const choices = [
    ...state.noteScripts.map(script => ({ key: `s${script.id}`, label: script.name, script })),
    ...scriptExamples.map((script, index) => ({ key: `e${index}`, label: `${script.name} (example)`, script })),
  ];
  choices.forEach(choice => library.add(new Option(choice.label, choice.key)));
  library.addEventListener("change", () => {
    const choice = choices.find(item => item.key === library.value);
    if (choice) {
      const { html, css, js, name } = choice.script;
      fill({ ...read(), html, css, js, name: options.metadata ? read().name : name });
      preview();
    }
    library.value = "";
  });

  form.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach(button => button.addEventListener("click", () => {
    form.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach(other => other.setAttribute("aria-selected", String(other === button)));
    tabs.forEach(tab => { code(tab).hidden = tab !== button.dataset.tab; });
    code(button.dataset.tab!).focus();
  }));
  tabs.forEach(tab => codeArea(code(tab)));

  const frame = dialog.querySelector<HTMLIFrameElement>(".kv-preview iframe")!;
  const error = dialog.querySelector<HTMLElement>(".kv-preview .kv-script-error")!;
  function preview() {
    error.hidden = true;
    runScript(frame, read(), { onError: message => { error.textContent = message; error.title = message; error.hidden = false; } });
  }
  let timer: ReturnType<typeof setTimeout>;
  form.addEventListener("input", event => {
    if (!(event.target as HTMLElement).matches("textarea")) return;
    clearTimeout(timer);
    timer = setTimeout(preview, 600);
  });
  dialog.querySelector("[data-preview-run]")!.addEventListener("click", preview);
  dialog.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => dialog.close()));

  dialog.querySelector("[data-library-save]")!.addEventListener("click", async () => {
    const script = read();
    try {
      const existing = state.noteScripts.find(item => item.name === script.name);
      const base = existing || { description: "", author: "", tags: [] };
      await saveLibraryScript({ ...base, name: script.name, html: script.html, css: script.css, js: script.js }, existing?.id);
      toast(existing ? "Script updated in the library." : "Script added to the library.");
    } catch (failure) {
      toast((failure as Error).message, "error");
    }
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    try {
      await options.onSave(read());
      dialog.close();
    } catch (failure) {
      toast((failure as Error).message, "error");
    }
  });

  fill(initial);
  dialog.showModal();
  preview();
  code("js").focus();
  return dialog;
}

/** Pick a saved script, an example or a blank script, then insert it. */
export function openScriptLibrary(onInsert: (script: ScriptSource) => void) {
  const dialog = dialogShell("kv-script-library", "Scripts");

  const row = (key: string, script: { name: string; description?: string }, editable: boolean) => `<li>
      <button type="button" class="kv-library-insert" data-insert="${key}">
        <span class="kv-embed-icon">${embedIcon("script")}</span>
        <span><strong>${escapeHtml(script.name)}</strong><small>${escapeHtml(script.description || "Personal script")}</small></span>
      </button>
      ${editable ? `<button type="button" class="kv-icon-button" data-edit="${key}" aria-label="Edit ${escapeHtml(script.name)}">${embedIcon("edit")}</button>
      <button type="button" class="kv-icon-button" data-delete="${key}" aria-label="Delete ${escapeHtml(script.name)}">${embedIcon("close")}</button>` : ""}
    </li>`;

  function render() {
    const saved = state.noteScripts || [];
    dialog.innerHTML = `<header class="kv-dialog-head"><h3>Insert a script</h3><button type="button" class="kv-icon-button" data-close aria-label="Close">${embedIcon("close", 16)}</button></header>
      <p class="kv-dialog-intro">A script is a small HTML, CSS and JavaScript program that runs inside the note, isolated from the rest of the app.</p>
      <button type="button" class="kv-library-new" data-insert="new">${embedIcon("plus", 16)}<span><strong>New script</strong><small>Write a script from scratch</small></span></button>
      <h4>My library</h4>
      ${saved.length ? `<ul class="kv-library">${saved.map(script => row(`s${script.id}`, script, true)).join("")}</ul>` : '<p class="kv-empty">No saved scripts. Use “Save to library” from the script editor.</p>'}
      <h4>Examples</h4>
      <ul class="kv-library">${scriptExamples.map((script, index) => row(`e${index}`, script, false)).join("")}</ul>`;
  }

  const savedScript = (key: string) => state.noteScripts.find(item => `s${item.id}` === key);
  function lookup(key: string): ScriptSource | null {
    if (key.startsWith("s")) { const script = savedScript(key); return script ? { ...emptyScript(), ...script, height: "auto" } : null; }
    if (key.startsWith("e")) { const script = scriptExamples[Number(key.slice(1))]; return script ? { ...script } : null; }
    return null;
  }

  dialog.addEventListener("click", async event => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-close]")) return dialog.close();

    const insert = target.closest<HTMLElement>("[data-insert]")?.dataset.insert;
    if (insert === "new") {
      dialog.close();
      openScriptEditor(emptyScript(), { onSave: onInsert, saveLabel: "Insert into the note", title: "New script" });
      return;
    }
    if (insert) {
      const script = lookup(insert);
      dialog.close();
      if (script) onInsert(script);
      return;
    }

    const edit = target.closest<HTMLElement>("[data-edit]")?.dataset.edit;
    const saved = edit && savedScript(edit);
    if (saved) {
      dialog.close();
      openScriptEditor({ ...emptyScript(), ...saved, height: "auto" }, {
        title: "Edit library script", saveLabel: "Save", metadata: true,
        onSave: async script => { await saveLibraryScript({ ...saved, ...script }, saved.id); toast("Script saved."); },
      });
      return;
    }

    const remove = target.closest<HTMLElement>("[data-delete]")?.dataset.delete;
    const doomed = remove && savedScript(remove);
    if (!doomed || !confirm(`Delete “${doomed.name}” from the library? Notes that use it keep their copy.`)) return;
    try {
      await deleteLibraryScript(doomed.id);
      render();
    } catch (failure) {
      toast((failure as Error).message, "error");
    }
  });

  render();
  dialog.showModal();
}
