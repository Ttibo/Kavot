import { changedSinceBase, setEditorBase } from '../editorBase';
import { state } from '../../../app/state';
import { setMarkdownBlockEditorContent } from '../markdown';
import { api } from '../../../services/api';
import { toast } from '../../../app/navigation';
import { editorSession } from '../../../app/editorSession';
import { refreshWorkspaceTreeOnly } from './render';

/** A save made on an older version of the note than the latest known: the editor shows the latest instead.
 * Returns the note when the save must not be sent. */
function reloadIfChangedElsewhere(noteId: number, editor: Element | null) {
  const latest = state.notes.find((item) => item.id === noteId);
  if (!latest || !changedSinceBase(editor, latest.content)) return null;
  // A redrawn editor that is gone just drops its stale save; a visible one shows the note as it is now.
  if (editor?.isConnected) {
    const block = editor.closest(".note-pane")?.querySelector(".markdown-block-editor");
    if (block) setMarkdownBlockEditorContent(block, editor, latest.content, null, null, true);
    toast("This note was changed by an agent or elsewhere: it now shows that version.", "error");
  }
  return latest;
}

/** A save refused because the note changed on the server (409): load that version, show it in the editor. */
async function recoverFromConflict(noteId: number, editor: Element | null, error: unknown) {
  if ((error as { status?: number })?.status !== 409) return null;
  try {
    const fresh = await api<Note>(`/notes/${noteId}`);
    const cached = state.notes.find((item) => item.id === noteId);
    if (cached) Object.assign(cached, fresh); else state.notes.push(fresh);
    return reloadIfChangedElsewhere(noteId, editor) || fresh;
  } catch { return null; }
}

// Serialize writes per note, including when it is open in both panes.
const noteWrites = new Map<number, Promise<any>>();

function writeNoteContent(noteId: number, content: string) {
  const previous = noteWrites.get(noteId) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const cached = state.notes.find(n => n.id === noteId);
    const saved = await api(`/notes/${noteId}`, {
      method: 'PATCH', body: JSON.stringify({ content, expected_hash: cached?.content_hash }),
    });
    if (cached) cached.content_hash = saved.content_hash;
    return saved;
  });
  noteWrites.set(noteId, pending);
  const cleanup = () => { if (noteWrites.get(noteId) === pending) noteWrites.delete(noteId); };
  pending.then(cleanup, cleanup);
  return pending;
}

async function persistSecondaryNoteContent(noteId, content, editor: Element | null = null) {
  const indicator = document.querySelector("#secondary-note-save-state");
  const latest = reloadIfChangedElsewhere(noteId, editor);
  if (latest) {
    if (indicator) { indicator.textContent = "Updated elsewhere"; (indicator as HTMLElement).dataset.state = "saved"; }
    return latest;
  }
  if (indicator) { indicator.textContent = "Saving…"; (indicator as HTMLElement).dataset.state = "saving"; }
  try {
    const updated = await writeNoteContent(noteId, content);
    setEditorBase(editor, updated.content);
    const cached = state.notes.find((item) => item.id === noteId);
    if (cached) Object.assign(cached, updated);
    if (indicator) { indicator.textContent = "Saved automatically"; (indicator as HTMLElement).dataset.state = "saved"; }
    return updated;
  } catch (error) {
    const recovered = await recoverFromConflict(noteId, editor, error);
    if (recovered) {
      if (indicator) { indicator.textContent = "Updated elsewhere"; (indicator as HTMLElement).dataset.state = "saved"; }
      return recovered;
    }
    if (indicator) { indicator.textContent = "Save failed"; (indicator as HTMLElement).dataset.state = "error"; }
    toast(error.message, "error");
    return null;
  }
}

export function queueSecondaryNoteAutosave() {
  const editor = document.querySelector("#secondary-note-content");
  const noteId = Number(
    (document.querySelector("[data-secondary-note-id]") as HTMLElement)?.dataset
      .secondaryNoteId || 0,
  );
  if (!editor || !noteId) return;
  clearTimeout(editorSession.secondaryNoteAutosaveTimer);
  const indicator = document.querySelector("#secondary-note-save-state");
  if (indicator) { indicator.textContent = "Unsaved changes…"; (indicator as HTMLElement).dataset.state = "pending"; }
  editorSession.secondaryNoteAutosaveTimer = setTimeout(() => {
    editorSession.secondaryNoteAutosaveTimer = null;
    persistSecondaryNoteContent(noteId, (editor as HTMLInputElement).value, editor);
  }, 650);
}

export async function flushSecondaryNoteAutosave() {
  const editor = document.querySelector("#secondary-note-content");
  const noteId = Number(
    (document.querySelector("[data-secondary-note-id]") as HTMLElement)?.dataset
      .secondaryNoteId || 0,
  );
  if (!editor || !noteId) return null;
  if (!editorSession.secondaryNoteAutosaveTimer) return noteWrites.get(noteId)?.catch(() => null) || null;
  clearTimeout(editorSession.secondaryNoteAutosaveTimer);
  editorSession.secondaryNoteAutosaveTimer = null;
  return persistSecondaryNoteContent(noteId, (editor as HTMLInputElement).value, editor);
}

export function setNoteAutosaveState(message, stateName = "") {
  const indicator = document.querySelector("#note-autosave-state");
  if (!indicator) return;
  indicator.textContent = message;
  (indicator as HTMLElement).dataset.state = stateName;
}

async function persistNoteContent(noteId, content, version, notify = false, editor: Element | null = null) {
  const latest = reloadIfChangedElsewhere(noteId, editor);
  if (latest) { setNoteAutosaveState("Updated elsewhere", "saved"); return latest; }
  try {
    setNoteAutosaveState("Saving…", "saving");
    const updated = await writeNoteContent(noteId, content);
    setEditorBase(editor, updated.content);
    const cached = state.notes.find((item) => item.id === noteId);
    if (cached) Object.assign(cached, updated);
    if (version === editorSession.noteAutosaveVersion && state.currentNoteId === noteId)
      setNoteAutosaveState("Saved automatically", "saved");
    if (notify) toast("Note saved");
    return updated;
  } catch (error) {
    const recovered = await recoverFromConflict(noteId, editor, error);
    if (recovered) { setNoteAutosaveState("Updated elsewhere", "saved"); return recovered; }
    setNoteAutosaveState("Save failed", "error");
    toast(error.message, "error");
    return null;
  }
}

export async function persistNoteTitle(noteId, input) {
  const title = input?.value.trim();
  const note = state.notes.find((item) => item.id === Number(noteId));
  if (!input || !note || !title) {
    if (input && note) input.value = note.title;
    return null;
  }
  if (title === note.title) return note;
  const indicator = input
    .closest(".note-pane")
    ?.querySelector(".note-autosave-state");
  if (indicator) {
    indicator.textContent = "Renommage…";
    indicator.dataset.state = "saving";
  }
  try {
    const updated = await api(`/notes/${noteId}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    });
    Object.assign(note, updated);
    document
      .querySelectorAll(`[data-note-title-input="${noteId}"]`)
      .forEach((item) => {
        if (item !== input) (item as HTMLInputElement).value = updated.title;
      });
    if (indicator) {
      indicator.textContent = "Saved automatically";
      indicator.dataset.state = "saved";
    }
    refreshWorkspaceTreeOnly().catch(() => {});
    return updated;
  } catch (error) {
    input.value = note.title;
    if (indicator) {
      indicator.textContent = "Rename failed";
      indicator.dataset.state = "error";
    }
    toast(error.message, "error");
    return null;
  }
}

export function queueCurrentNoteAutosave() {
  const editor = document.querySelector("#note-content");
  if (!editor || !state.currentNoteId) return;
  clearTimeout(editorSession.noteAutosaveTimer);
  editorSession.noteAutosaveVersion += 1;
  const version = editorSession.noteAutosaveVersion;
  const noteId = state.currentNoteId;
  setNoteAutosaveState("Unsaved changes…", "pending");
  editorSession.noteAutosaveTimer = setTimeout(() => {
    editorSession.noteAutosaveTimer = null;
    persistNoteContent(noteId, (editor as HTMLInputElement).value, version, false, editor);
  }, 650);
}

export async function flushCurrentNoteAutosave(notify = false) {
  const editor = document.querySelector("#note-content");
  if (!editor || !state.currentNoteId) return null;
  if (!editorSession.noteAutosaveTimer && !notify) return noteWrites.get(state.currentNoteId)?.catch(() => null) || null;
  clearTimeout(editorSession.noteAutosaveTimer);
  editorSession.noteAutosaveTimer = null;
  editorSession.noteAutosaveVersion += 1;
  return persistNoteContent(
    state.currentNoteId,
    (editor as HTMLInputElement).value,
    editorSession.noteAutosaveVersion,
    notify,
    editor,
  );
}

export async function saveCurrentNote() {
  return flushCurrentNoteAutosave(true);
}
