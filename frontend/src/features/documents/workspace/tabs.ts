import { flushCollectionSaves } from '../../collections/noteEditor';
import { escapeHtml, rememberWorkspaceSession, state } from '../../../app/state';
import { findCollectionItem } from '../../collections/catalog';
import { flushCanvasSaves } from '../canvas';
import { api } from '../../../services/api';
import { toast } from '../../../app/navigation';
import { findWorkspaceNode } from './tree';
import { workspaceResourcePayload, flushWorkspaceMarkdownSaves } from './resources';
import { rerenderNotesContext } from './render';
import { flushSecondaryNoteAutosave, flushCurrentNoteAutosave } from './noteSaving';

export function workspaceNoteTab(note) {
  return note
    ? { id: `note:${note.id}`, type: "note", noteId: note.id }
    : null;
}

export async function reloadNoteForOpen(noteId: number) {
  await flushCurrentNoteAutosave();
  await flushSecondaryNoteAutosave();
  if (document.querySelector('.note-autosave-state[data-state="error"]')) {
    toast('Save your changes before reloading a note.', 'error');
    return null;
  }
  try {
    const note = await api(`/notes/${noteId}`, {cache: 'no-store'});
    state.notes = [...state.notes.filter(item => item.id !== noteId), note];
    return note;
  } catch (error) {
    toast(`Unable to reload the note: ${(error as Error).message}`, 'error');
    return null;
  }
}

export function workspaceResourceTab(resource) {
  return resource
    ? { id: `resource:${resource.path}`, type: "resource", resource }
    : null;
}

function workspaceEmptyTab(pane = "primary") {
  return {
    id: `empty:${pane}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 6)}`,
    type: "empty",
  };
}

export function ensureWorkspacePaneTab(pane) {
  if (state.workspaceTabs[pane].length) return;
  ensureWorkspaceTab(pane, workspaceEmptyTab(pane));
}

export function ensureWorkspaceTab(pane, tab) {
  if (!tab) return;
  const tabs = state.workspaceTabs[pane];
  const existing = tabs.find((item) => item.id === tab.id);
  if (existing) Object.assign(existing, tab);
  else tabs.push(tab);
  state.workspaceActiveTabs[pane] = tab.id;
}

function workspaceTabLabel(tab) {
  if (tab.type === "empty") return "New tab";
  if (tab.type === "note")
    return state.notes.find((item) => item.id === Number(tab.noteId))?.title || "Note";
  const node = findWorkspaceNode(tab.resource?.path);
  return node?.label || node?.name || tab.resource?.title || tab.resource?.path?.split("/").pop() || "Document";
}

export function workspacePaneWithTabs(content, pane) {
  const noteId = pane === 'primary' ? state.currentNoteId : state.secondaryResource?.noteId;
  const resource = pane === 'primary' ? state.primaryResource : state.secondaryResource;
  const signature = JSON.stringify({
    noteContent: noteId ? state.notes.find(note => note.id === Number(noteId))?.content : undefined,
    drawing: undefined,
    record: resource?.type === 'collection-record' ? findCollectionItem(resource.content)?.source : undefined,
    active: state.workspaceActiveTabs[pane],
    split: Boolean(state.secondaryResource),
    renderVersion: (pane === "primary" ? state.primaryResource : state.secondaryResource)?.renderVersion || 0,
    tabs: state.workspaceTabs[pane].map((tab) => [tab.id, workspaceTabLabel(tab)]),
  });
  // Pane tabs are drawn in the titlebar, above their pane (see WindowHeader).
  return `<div class="workspace-pane-stack" data-workspace-pane="${pane}" data-workspace-signature="${escapeHtml(signature)}">${content}</div>`;
}

export function workspaceTabById(pane, tabId) {
  return state.workspaceTabs[pane].find((item) => item.id === tabId);
}

export function applyWorkspaceTab(pane, tab) {
  if (!tab) return;
  state.workspaceActiveTabs[pane] = tab.id;
  if (tab.type === "empty") {
    if (pane === "primary") {
      state.currentNoteId = null;
      state.primaryResource = null;
    } else state.secondaryResource = null;
  } else if (tab.type === "note") {
    const note = state.notes.find((item) => item.id === Number(tab.noteId));
    if (!note) return;
    if (pane === "primary") {
      state.currentNoteId = note.id;
      state.primaryResource = null;
      state.noteScope = note.paper_id
        ? `paper:${note.paper_id}`
        : note.project_id
          ? `project:${note.project_id}`
          : "general";
      state.noteFolderId = note.folder_id || "all";
    } else state.secondaryResource = { type: "note", noteId: note.id, mode: "edit" };
    rememberWorkspaceSession({ type: "note", noteId: note.id });
  } else if (pane === "primary") {
    state.currentNoteId = null;
    state.primaryResource = tab.resource;
  }
  else state.secondaryResource = tab.resource;
  if (tab.type === "resource" && !["atelier", "view"].includes(tab.resource?.type)) {
    const paperId = Number(tab.resource?.paperId || tab.resource?.paper_id || 0);
    if (paperId)
      rememberWorkspaceSession({
        type: "paper",
        paperId,
        page: state.readingProgress[String(paperId)] || 1,
      });
    else
      rememberWorkspaceSession({
        type: "resource",
        path: tab.resource?.path,
        title: tab.resource?.title,
        kind: tab.resource?.type,
      });
  }
  state.activeNotePane = pane;
}

export function replaceActiveWorkspaceTab(pane, tab, newTab = false) {
  if (!tab) return;
  if (newTab) {
    ensureWorkspaceTab(pane, tab);
    return applyWorkspaceTab(pane, tab);
  }
  const tabs = state.workspaceTabs[pane];
  const alreadyOpen = tabs.find((item) => item.id === tab.id);
  if (alreadyOpen) return applyWorkspaceTab(pane, alreadyOpen);
  const activeIndex = tabs.findIndex(
    (item) => item.id === state.workspaceActiveTabs[pane],
  );
  if (activeIndex >= 0) {
    // The tab remembers what it showed before: Back returns to it, in this tab only.
    const previous = tabs[activeIndex];
    tab.back = [...(previous.back || []), withoutHistory(previous)].slice(-TAB_HISTORY_LIMIT);
    tab.forward = [];
    tabs.splice(activeIndex, 1, tab);
  } else tabs.push(tab);
  applyWorkspaceTab(pane, tab);
}

const TAB_HISTORY_LIMIT = 30;

const withoutHistory = (tab) => ({ ...tab, back: undefined, forward: undefined });

/** A navigation that shows a document in `pane` and its companion in `companionPane` (an article and its note)
 * is one step of history: Back in the document's tab undoes both, Forward redoes both. */
export function replaceActiveWorkspaceTabPair(pane, tab, companionPane, companion) {
  replaceActiveWorkspaceTab(pane, tab);
  const companionHadTab = Boolean(workspaceTabById(companionPane, state.workspaceActiveTabs[companionPane]));
  replaceActiveWorkspaceTab(companionPane, companion);
  state.activeNotePane = pane;
  const entry = workspaceTabById(pane, state.workspaceActiveTabs[pane]) === tab ? tab.back?.at(-1) : null;
  // A companion that was already open in another tab was only brought forward: nothing to undo there.
  if (!entry || workspaceTabById(companionPane, state.workspaceActiveTabs[companionPane]) !== companion) return;
  entry.companion = companionHadTab
    ? { pane: companionPane, expect: companion.id }
    : { pane: companionPane, expect: companion.id, close: true };
}

export function canNavigateTabHistory(direction: -1 | 1) {
  const pane = state.activeNotePane === "secondary" && state.workspaceTabs.secondary.length ? "secondary" : "primary";
  const tab = state.workspaceTabs[pane]?.find((item) => item.id === state.workspaceActiveTabs[pane]);
  return state.view === "notes" && Boolean((direction < 0 ? tab?.back : tab?.forward)?.length);
}

/** Moves the active tab of `pane` one step in its history. Returns false when nothing changed. */
async function stepTabHistory(pane, direction: -1 | 1) {
  const tabs = state.workspaceTabs[pane];
  const index = tabs.findIndex((item) => item.id === state.workspaceActiveTabs[pane]);
  const current = tabs[index];
  if (!current || !(direction < 0 ? current.back : current.forward)?.length) return false;
  const back = [...(current.back || [])];
  const forward = [...(current.forward || [])];
  const target = { ...(direction < 0 ? back.pop() : forward.pop()) };
  // A file is read again: going back never shows content older than the last save.
  if (target.type === "resource" && target.resource?.path && !["view", "atelier"].includes(target.resource.type)) {
    const node = findWorkspaceNode(target.resource.path);
    if (!node) { toast("This file no longer exists", "error"); return false; }
    target.resource = await workspaceResourcePayload(node);
  }
  if (target.type === "note" && !state.notes.some((note) => note.id === Number(target.noteId))) {
    toast("This note no longer exists", "error");
    return false;
  }
  const companion = target.companion;
  delete target.companion;
  const left = withoutHistory(current);
  delete left.companion;
  // The companion pane follows, and the step left behind remembers how to undo that too.
  const inverse = companion ? await stepCompanion(companion, direction) : undefined;
  if (inverse) left.companion = inverse;
  if (direction < 0) forward.push(left);
  else back.push(left);
  target.back = back;
  target.forward = forward;
  // The same document open in another tab of the pane gives way to this one.
  const position = tabs.indexOf(current);
  const duplicate = tabs.findIndex((item, at) => at !== position && item.id === target.id);
  tabs.splice(position, 1, target);
  if (duplicate >= 0) tabs.splice(duplicate, 1);
  applyWorkspaceTab(pane, target);
  return true;
}

/** Applies the companion part of a history step; returns the record that undoes it, or nothing
 * when the companion pane has moved on since (it is then left as it is). */
async function stepCompanion(companion, direction: -1 | 1) {
  const { pane } = companion;
  const tabs = state.workspaceTabs[pane];
  const active = workspaceTabById(pane, state.workspaceActiveTabs[pane]);
  if (companion.restore) {
    // The companion had been closed: it comes back in a tab of its own.
    if (tabs.some((item) => item.id === companion.restore.id)) return undefined;
    if (companion.restore.type === "note" && !state.notes.some((note) => note.id === Number(companion.restore.noteId))) return undefined;
    const tab = { ...companion.restore };
    tabs.push(tab);
    applyWorkspaceTab(pane, tab);
    return { pane, expect: tab.id, close: true };
  }
  if (!active || active.id !== companion.expect) return undefined;
  if (companion.close) {
    if (pane !== "secondary" && tabs.length < 2) return undefined;
    const index = tabs.indexOf(active);
    tabs.splice(index, 1);
    const fallback = tabs[Math.min(index, tabs.length - 1)];
    if (fallback) applyWorkspaceTab(pane, fallback);
    else {
      state.workspaceActiveTabs[pane] = null;
      state.secondaryResource = null;
      state.secondaryFirst = false;
    }
    return { pane, expect: null, restore: withoutHistory(active) };
  }
  if (!await stepTabHistory(pane, direction)) return undefined;
  return { pane, expect: state.workspaceActiveTabs[pane] };
}

/** Back (-1) or Forward (1) in the active tab of the focused pane; the other tabs and panes are left as they are,
 * except the companion opened with the document by the same navigation (an article's note). */
export async function navigateTabHistory(direction: -1 | 1) {
  if (!canNavigateTabHistory(direction)) return;
  await flushCurrentNoteAutosave();
  await flushSecondaryNoteAutosave();
  await flushWorkspaceMarkdownSaves();
  const pane = state.activeNotePane === "secondary" && state.workspaceTabs.secondary.length ? "secondary" : "primary";
  if (!await stepTabHistory(pane, direction)) return;
  state.activeNotePane = pane;
  await rerenderNotesContext();
}

export function createWorkspaceTab(pane = "primary") {
  const tab = workspaceEmptyTab(pane);
  state.workspaceTabs[pane].push(tab);
  applyWorkspaceTab(pane, tab);
  rerenderNotesContext();
}

export async function activateWorkspaceTab(pane, tabId) {
  await flushCurrentNoteAutosave();
  await flushSecondaryNoteAutosave();
  await flushWorkspaceMarkdownSaves();
  await flushCanvasSaves();
  const tab = workspaceTabById(pane, tabId);
  if (tab?.type === 'note' && !await reloadNoteForOpen(Number(tab.noteId))) return;
  applyWorkspaceTab(pane, tab);
  rerenderNotesContext();
}

export async function closeWorkspaceTab(pane, tabId) {
  await flushCurrentNoteAutosave();
  await flushSecondaryNoteAutosave();
  await flushWorkspaceMarkdownSaves();
  await flushCanvasSaves();
  const tabs = state.workspaceTabs[pane];
  const index = tabs.findIndex((item) => item.id === tabId);
  if (index < 0) return;
  const nextTabs = tabs.filter((_, position) => position !== index);
  const fallback = nextTabs[Math.min(index, nextTabs.length - 1)] || null;
  if (state.workspaceActiveTabs[pane] === tabId && fallback?.type === "note" && !await reloadNoteForOpen(Number(fallback.noteId))) return;
  tabs.splice(index, 1);
  if (state.workspaceActiveTabs[pane] !== tabId) return rerenderNotesContext();
  state.workspaceActiveTabs[pane] = fallback?.id || null;
  if (fallback) applyWorkspaceTab(pane, fallback);
  else if (pane === "secondary") {
    state.secondaryResource = null;
    state.secondaryFirst = false;
    state.activeNotePane = "primary";
  } else {
    if (!promoteSecondaryWorkspacePane()) {
      const empty = workspaceEmptyTab("primary");
      tabs.push(empty);
      applyWorkspaceTab("primary", empty);
    }
  }
  rerenderNotesContext();
}

function promoteSecondaryWorkspacePane() {
  if (!state.workspaceTabs.secondary.length) return false;
  state.workspaceTabs.primary = state.workspaceTabs.secondary;
  state.workspaceActiveTabs.primary =
    state.workspaceActiveTabs.secondary || state.workspaceTabs.primary[0]?.id || null;
  state.workspaceTabs.secondary = [];
  state.workspaceActiveTabs.secondary = null;
  state.primaryResource = null;
  state.secondaryResource = null;
  state.secondaryFirst = false;
  const active = workspaceTabById("primary", state.workspaceActiveTabs.primary);
  if (active) applyWorkspaceTab("primary", active);
  state.activeNotePane = "primary";
  return true;
}

export async function mergeWorkspacePanes(sourcePane: string, targetPane: string) {
  if (!["primary", "secondary"].includes(sourcePane) ||
      !["primary", "secondary"].includes(targetPane) || sourcePane === targetPane) return;
  await flushCurrentNoteAutosave();
  await flushSecondaryNoteAutosave();
  await flushWorkspaceMarkdownSaves();
  await flushCanvasSaves();
  await flushCollectionSaves();
  const active = workspaceTabById(sourcePane, state.workspaceActiveTabs[sourcePane]);
  const tabs = [...state.workspaceTabs[targetPane]];
  for (const tab of state.workspaceTabs[sourcePane]) {
    if (!tabs.some(item => item.id === tab.id)) tabs.push(tab);
  }
  const selected = active || tabs.find(tab => tab.id === state.workspaceActiveTabs[targetPane]) || tabs[0];
  state.workspaceTabs.primary = tabs;
  state.workspaceTabs.secondary = [];
  state.workspaceActiveTabs.secondary = null;
  state.secondaryResource = null;
  state.secondaryFirst = false;
  if (selected) applyWorkspaceTab("primary", selected);
  state.activeNotePane = "primary";
  rerenderNotesContext();
}

/** Move one tab to a position in a pane: reorders within a pane, or moves it to the other one (opening it if needed). */
export async function moveWorkspaceTab(sourcePane: string, tabId: string, targetPane: string, index = -1) {
  if (!["primary", "secondary"].includes(sourcePane) || !["primary", "secondary"].includes(targetPane)) return;
  await flushCurrentNoteAutosave();
  await flushSecondaryNoteAutosave();
  await flushWorkspaceMarkdownSaves();
  await flushCanvasSaves();
  const source = state.workspaceTabs[sourcePane];
  const from = source.findIndex((item) => item.id === tabId);
  if (from < 0) return;
  const target = state.workspaceTabs[targetPane];
  const [tab] = source.splice(from, 1);
  if (sourcePane === targetPane) {
    // The index was measured before removal, so later positions shift by one.
    source.splice(index < 0 ? source.length : Math.min(index > from ? index - 1 : index, source.length), 0, tab);
    return rerenderNotesContext();
  }
  const existing = target.find((item) => item.id === tab.id);
  if (!existing) target.splice(index < 0 ? target.length : Math.min(index, target.length), 0, tab);
  const moved = existing || tab;
  if (!source.length && sourcePane === "primary") {
    // The secondary pane becomes the only pane.
    promoteSecondaryWorkspacePane();
    applyWorkspaceTab("primary", workspaceTabById("primary", moved.id));
    return rerenderNotesContext();
  }
  if (!source.length) {
    state.workspaceActiveTabs.secondary = null;
    state.secondaryResource = null;
    state.secondaryFirst = false;
  } else if (state.workspaceActiveTabs[sourcePane] === tab.id) applyWorkspaceTab(sourcePane, source[Math.min(from, source.length - 1)]);
  applyWorkspaceTab(targetPane, moved);
  rerenderNotesContext();
}

