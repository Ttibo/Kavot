import { renderMarkdown } from '../../../app/state';

function updateMarkdownDocumentStats(editor) {
  const target = editor
    ?.closest(".note-pane")
    ?.querySelector(".markdown-document-stats");
  if (!editor || !target) return;
  const words = editor.value.trim()
    ? editor.value.trim().split(/\s+/).length
    : 0;
  const minutes = Math.max(1, Math.ceil(words / 220));
  target.textContent = `${words} word${words === 1 ? "" : "s"} · ${minutes} min`;
}

export function bindMarkdownWritingExperience(editor) {
  if (!editor) return;
  updateMarkdownDocumentStats(editor);
  // Counting words reads the whole document: wait for a pause in typing.
  let statsTimer: ReturnType<typeof setTimeout> | undefined;
  editor.addEventListener("input", () => {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(() => updateMarkdownDocumentStats(editor), 500);
  });
  editor.addEventListener("keydown", (event) => {
    const command = event.metaKey || event.ctrlKey;
    if (command && ["b", "i", "k"].includes(event.key.toLowerCase())) {
      event.preventDefault();
      applyMarkdownToEditor(
        editor,
        { b: "bold", i: "italic", k: "link" }[event.key.toLowerCase()],
      );
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      if (event.shiftKey) {
        const lineStart = editor.value.lastIndexOf("\n", start - 1) + 1;
        const removable =
          editor.value.slice(lineStart, lineStart + 2).match(/^(  |\t)/)?.[0] ||
          "";
        if (removable)
          editor.setRangeText(
            "",
            lineStart,
            lineStart + removable.length,
            "end",
          );
      } else {
        editor.setRangeText("  ", start, end, "end");
      }
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.metaKey ||
      event.ctrlKey ||
      editor.selectionStart !== editor.selectionEnd
    )
      return;
    const cursor = editor.selectionStart;
    const lineStart = editor.value.lastIndexOf("\n", cursor - 1) + 1;
    const line = editor.value.slice(lineStart, cursor);
    const list = line.match(/^(\s*)([-*+] |\d+[.)] |[-*] \[[ xX]\] )(.*)$/);
    if (!list) return;
    event.preventDefault();
    if (!list[3]) {
      editor.setRangeText("", lineStart, cursor, "end");
    } else {
      const marker = /^\d/.test(list[2])
        ? `${Number.parseInt(list[2], 10) + 1}. `
        : /\[[ xX]\]/.test(list[2])
          ? "- [ ] "
          : list[2];
      editor.setRangeText(`\n${list[1]}${marker}`, cursor, cursor, "end");
    }
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export function applyMarkdownToEditor(editor, action, preview = null, assetBase = "") {
  if (!editor) return;
  if (editor.kavotCommand) { editor.kavotCommand(action); return; }
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const selected = editor.value.slice(start, end);
  const wrappers = {
    bold: ["**", "**"],
    italic: ["*", "*"],
    strike: ["~~", "~~"],
    code: ["`", "`"],
    link: ["[", "](https://)"],
  };
  let replacement;
  let cursorStart;
  let cursorEnd;
  if (wrappers[action]) {
    const [before, after] = wrappers[action];
    replacement = `${before}${selected || "texte"}${after}`;
    cursorStart = start + before.length;
    cursorEnd = cursorStart + (selected || "texte").length;
  } else {
    const prefixes = {
      heading: "## ",
      list: "- ",
      task: "- [ ] ",
      quote: "> ",
    };
    const prefix = prefixes[action] || "";
    replacement = (selected || "texte")
      .split("\n")
      .map((line) => `${prefix}${line}`)
      .join("\n");
    cursorStart = start + prefix.length;
    cursorEnd = start + replacement.length;
  }
  editor.setRangeText(replacement, start, end, "end");
  editor.setSelectionRange(cursorStart, cursorEnd);
  editor.focus();
  if (preview) preview.innerHTML = renderMarkdown(editor.value, assetBase);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}
