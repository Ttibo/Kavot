import { bindCollectionEditors } from '../../collections/noteEditor';
import { setEditorBase } from '../editorBase';
import { noteAssetBase, state } from '../../../app/state';
import { bindMarkdownBlockEditor, markdownBlockSourceOffset, setMarkdownBlockEditorContent } from '../markdown';
import { bindCanvasEditors } from '../canvas';
import { decorateTreeSelection } from '../treeSelection';
import { bindWorkspacePdfExtractors } from '../../library/documents';
import { api } from '../../../services/api';
import { toast } from '../../../app/navigation';
import { expandWorkspacePathParents, decorateTreeFocus, bindThemedDocumentPreviews, bindNotesExplorerOnce, bindWorkspaceTreeEditors, applyNoteSearch, bindNoteSearchOnce } from './tree';
import { bindWorkspaceMarkdownEditors } from './resources';
import { bindMarkdownWritingExperience } from './markdownTools';
import { refreshWorkspaceTreeOnly } from './render';
import { queueSecondaryNoteAutosave, flushSecondaryNoteAutosave, setNoteAutosaveState, queueCurrentNoteAutosave, flushCurrentNoteAutosave } from './noteSaving';
import { bindNotesResizers } from './resizers';

function transferredNoteFile(files) {
  return [...(files || [])].find((item) => item?.size > 0) || null;
}

function markActiveNotePane(pane, root: Document | Element = document) {
  state.activeNotePane = pane === "secondary" ? "secondary" : "primary";
  root.querySelectorAll("[data-pane-drop]").forEach((item) => {
    item.classList.toggle(
      "active-note-pane",
      (item as HTMLElement).dataset.paneDrop === state.activeNotePane,
    );
  });
}

async function uploadFileIntoNote(
  noteId,
  editor,
  file,
  cursor,
  assetBase,
  context = "primary",
) {
  if (!noteId || !editor || !file) return;
  if (context === "secondary") await flushSecondaryNoteAutosave();
  else await flushCurrentNoteAutosave();
  const form = new FormData();
  form.append(
    "cursor",
    String(
      Math.max(
        0,
        Math.min(editor.value.length, cursor ?? editor.selectionStart),
      ),
    ),
  );
  form.append("alt", file.name?.replace(/\.[^.]+$/, "") || "Image");
  form.append("file", file);
  try {
    const result = await api(`/notes/${noteId}/assets`, {
      method: "POST",
      body: form,
    });
    editor.value = result.content;
    editor.setSelectionRange(result.insertion_end, result.insertion_end);
    const blockEditor = editor
      .closest(".note-pane, .reader-note-pane, .project-note-modal")
      ?.querySelector(".markdown-block-editor");
    if (blockEditor) {
      const focusIndex = result.content
        .slice(0, result.insertion_end)
        .split("\n").length - 1;
      setMarkdownBlockEditorContent(
        blockEditor,
        editor,
        result.content,
        assetBase,
        focusIndex,
      );
    }
    const cached = state.notes.find((item) => item.id === Number(noteId));
    if (cached) Object.assign(cached, result.note);
    const assetLabel = result.kind === "image" ? "Image" : "File";
    if (context === "secondary")
      document.querySelector("#secondary-note-save-state").textContent =
        `${assetLabel} inserted · saved`;
    else setNoteAutosaveState(`${assetLabel} inserted · saved`, "saved");
    refreshWorkspaceTreeOnly().catch(() => {});
    if (!blockEditor) editor.focus();
    toast(`${assetLabel} added to the note`);
  } catch (error) {
    toast(error.message, "error");
  }
}

function bindSecondaryResource(root) {
  const editor = root?.querySelector("#secondary-note-content");
  const blockEditor = root?.querySelector("#secondary-note-block-editor");
  const note = state.notes.find(
    (item) =>
      item.id ===
      Number(
        root?.querySelector("[data-secondary-note-id]")?.dataset
          .secondaryNoteId || 0,
      ),
  );
  setEditorBase(editor, note?.content);
  bindMarkdownBlockEditor(blockEditor, editor);
  bindMarkdownWritingExperience(editor);
  blockEditor?.addEventListener("focusin", () =>
    markActiveNotePane("secondary", root),
  );
  editor?.addEventListener("input", () => {
    queueSecondaryNoteAutosave();
  });
  blockEditor?.addEventListener("focusout", (event) => {
    if (!event.relatedTarget || !blockEditor.contains(event.relatedTarget))
      flushSecondaryNoteAutosave();
  });
  blockEditor?.addEventListener("paste", (event) => {
    const file = transferredNoteFile(event.clipboardData?.files);
    if (!file || !note) return;
    event.preventDefault();
    uploadFileIntoNote(
      note.id,
      editor,
      file,
      markdownBlockSourceOffset(blockEditor, event.target),
      noteAssetBase(note),
      "secondary",
    );
  });
  blockEditor?.addEventListener("dragover", (event) => {
    if (transferredNoteFile(event.dataTransfer?.files)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      blockEditor.classList.add("is-file-drop");
    }
  });
  blockEditor?.addEventListener("dragleave", (event) => {
    if (!blockEditor.contains(event.relatedTarget))
      blockEditor.classList.remove("is-file-drop");
  });
  blockEditor?.addEventListener("drop", (event) => {
    const file = transferredNoteFile(event.dataTransfer?.files);
    if (!file || !note) return;
    event.preventDefault();
    blockEditor.classList.remove("is-file-drop");
    uploadFileIntoNote(
      note.id,
      editor,
      file,
      markdownBlockSourceOffset(
        blockEditor,
        event.target.closest(".markdown-block")?.querySelector(
          ".markdown-block-input",
        ),
      ),
      noteAssetBase(note),
      "secondary",
    );
  });
}

export function bindNotesWorkspace(projectId = null) {
  const root =
    document.querySelector(
      projectId ? "#project-notes-area" : "#main-notes-area",
    ) || document.querySelector("#main-notes-area");
  const freshPrimary = root?.querySelector(
    '.workspace-pane-stack[data-workspace-pane="primary"]:not([data-workspace-bound="true"])',
  );
  const freshSecondary = root?.querySelector(
    '.workspace-pane-stack[data-workspace-pane="secondary"]:not([data-workspace-bound="true"])',
  );
  [freshPrimary, freshSecondary].forEach(pane => pane?.addEventListener('input', event => {
    const input = event.target as HTMLInputElement;
    if (!input.hasAttribute('data-review-search')) return;
    const wrapper = input.closest('.review-data-table');
    const rows = [...wrapper.querySelectorAll<HTMLTableRowElement>('tbody tr')];
    rows.forEach(row => { row.hidden = !row.textContent.toLocaleLowerCase().includes(input.value.toLocaleLowerCase()); });
    wrapper.querySelector('.review-table-tools span').textContent = `${rows.filter(row => !row.hidden).length} / ${rows.length} lignes`;
  }));
  [freshPrimary, freshSecondary].forEach(pane => pane?.addEventListener('click', event => {
    const sort = (event.target as HTMLElement).closest<HTMLElement>('[data-review-sort]');
    if (sort) {
      const table = sort.closest('table');
      const descending = sort.parentElement.getAttribute('aria-sort') === 'ascending';
      table.querySelectorAll('th').forEach(header => header.setAttribute('aria-sort', 'none'));
      sort.parentElement.setAttribute('aria-sort', descending ? 'descending' : 'ascending');
      const column = Number(sort.dataset.reviewSort);
      [...table.tBodies[0].rows].sort((a, b) => (a.cells[column]?.textContent || '').localeCompare(b.cells[column]?.textContent || '', undefined, { numeric: true }) * (descending ? -1 : 1)).forEach(row => table.tBodies[0].append(row));
      return;
    }
    const link = (event.target as HTMLElement).closest<HTMLElement>('.relational-note-pane a');
    if (!link) return;
    if (link.dataset.note || link.dataset.openWorkspaceResource || link.dataset.collectionNav || link.dataset.action || link.dataset.reviewFolder) event.preventDefault();
    if (link.dataset.reviewFolder) {
      const path = link.dataset.reviewFolder;
      expandWorkspacePathParents(path);
      state.expandedWorkspacePaths.add(path);
      void refreshWorkspaceTreeOnly().then(() => {
        const row = [...document.querySelectorAll<HTMLElement>('[data-workspace-toggle]')].find(item => item.dataset.workspaceToggle === path);
        row?.scrollIntoView({ block: 'nearest' });
        row?.focus();
      });
    }
  }));
  const editor = freshPrimary?.querySelector("#note-content");
  const blockEditor = freshPrimary?.querySelector("#note-block-editor");
  setEditorBase(editor, state.notes.find((item) => item.id === state.currentNoteId)?.content);
  const noteFilter = document.querySelector<HTMLInputElement>("#note-filter");
  const noteTree = document.querySelector<HTMLElement>("#notes-tree");
  // The explorer outlives the editor's redraws: listen to its scrolling once.
  if (noteTree && noteTree.dataset.scrollBound !== "true") {
    noteTree.dataset.scrollBound = "true";
    noteTree.addEventListener(
      "scroll",
      () => {
        state.noteTreeScrollTop = noteTree.scrollTop;
      },
      { passive: true },
    );
  }
  bindCollectionEditors(root);
  bindWorkspaceMarkdownEditors(root);
  bindCanvasEditors(root);
  bindWorkspacePdfExtractors(root);
  bindMarkdownBlockEditor(blockEditor, editor);
  bindMarkdownWritingExperience(editor);
  bindWorkspaceTreeEditors(noteTree);
  blockEditor?.addEventListener("focusin", () =>
    markActiveNotePane("primary", root),
  );
  // The search field lives in the titlebar and survives tree rerenders: reapply its query.
  bindNoteSearchOnce();
  bindNotesExplorerOnce();
  bindThemedDocumentPreviews();
  decorateTreeSelection();
  decorateTreeFocus();
  applyNoteSearch(noteFilter?.value || "");
  editor?.addEventListener("input", () => {
    queueCurrentNoteAutosave();
  });
  blockEditor?.addEventListener("focusout", (event) => {
    if (!(event as FocusEvent).relatedTarget || !blockEditor.contains((event as FocusEvent).relatedTarget as Node))
      flushCurrentNoteAutosave();
  });
  blockEditor?.addEventListener("paste", (event) => {
    const file = transferredNoteFile((event as ClipboardEvent).clipboardData?.files);
    const note = state.notes.find((item) => item.id === state.currentNoteId);
    if (!file || !note) return;
    event.preventDefault();
    uploadFileIntoNote(
      note.id,
      editor,
      file,
      markdownBlockSourceOffset(blockEditor, event.target),
      noteAssetBase(note),
    );
  });
  blockEditor?.addEventListener("dragover", (event) => {
    if (transferredNoteFile((event as DragEvent).dataTransfer?.files)) {
      event.preventDefault();
      (event as DragEvent).dataTransfer.dropEffect = "copy";
      blockEditor.classList.add("is-file-drop");
    }
  });
  blockEditor?.addEventListener("dragleave", (event) => {
    if (!blockEditor.contains((event as FocusEvent).relatedTarget as Node))
      blockEditor.classList.remove("is-file-drop");
  });
  blockEditor?.addEventListener("drop", (event) => {
    const file = transferredNoteFile((event as DragEvent).dataTransfer?.files);
    const note = state.notes.find((item) => item.id === state.currentNoteId);
    if (!file || !note) return;
    event.preventDefault();
    blockEditor.classList.remove("is-file-drop");
    uploadFileIntoNote(
      note.id,
      editor,
      file,
      markdownBlockSourceOffset(
        blockEditor,
        (event.target as HTMLElement).closest(".markdown-block")?.querySelector(
          ".markdown-block-input",
        ),
      ),
      noteAssetBase(note),
    );
  });
  if (freshSecondary) bindSecondaryResource(freshSecondary);
  bindNotesResizers(root);
  root
    ?.querySelectorAll('.workspace-pane-stack:not([data-workspace-bound="true"]) [data-pane-drop]')
    .forEach((pane) =>
      pane.addEventListener("pointerdown", () =>
        markActiveNotePane((pane as HTMLElement).dataset.paneDrop, root),
      ),
    );
  markActiveNotePane(state.activeNotePane, root);
  root
    ?.querySelectorAll('.workspace-pane-stack:not([data-workspace-bound="true"])')
    .forEach((pane) => {
      (pane as HTMLElement).dataset.workspaceBound = "true";
    });
}
