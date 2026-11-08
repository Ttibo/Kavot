import { flushCollectionSaves } from '../../collections/noteEditor';
import { state, workspaceMarkdownTimers } from '../../../app/state';
import { bindMarkdownBlockEditor } from '../markdown';
import { api } from '../../../services/api';
import { toast } from '../../../app/navigation';
import { findWorkspaceNode } from './tree';
import { bindMarkdownWritingExperience } from './markdownTools';
import { rerenderNotesContext } from './render';

export async function workspaceResourcePayload(node) {
  const resource: WorkspaceResource = {
    type: node.kind,
    path: node.path,
    title: node.label || node.name,
    url: node.url,
    paperId: Number(node.paper_id || 0) || null,
    generated: Boolean(node.generated),
  };
  if (node.kind === "markdown") {
    const response = await fetch(node.url, { cache: "no-store" });
    if (!response.ok) throw new Error("Unable to read this Markdown file");
    resource.content = await response.text();
    // The version this copy was read at: a save is refused if the file changed since (see persistWorkspaceMarkdown).
    resource.version = response.headers.get("X-Kavot-Version") || undefined;
  }
  if (node.kind === "canvas") {
    const response = await fetch(node.url, { cache: "no-store" });
    if (!response.ok) throw new Error("Unable to read this canvas");
    resource.content = await response.json();
  }
  return resource;
}

/** Reload cached file payloads too: refreshing the tree alone leaves them stale. */
export async function refreshOpenCloudResources(canApply: () => boolean) {
  const resources = [...new Set([
    state.primaryResource, state.secondaryResource,
    ...state.workspaceTabs.primary.map(tab => tab.resource),
    ...state.workspaceTabs.secondary.map(tab => tab.resource),
  ].filter(Boolean))];
  const updates = await Promise.all(resources.map(async resource => {
    if (!['markdown', 'canvas'].includes(resource.type)) return null;
    const node = findWorkspaceNode(resource.path);
    if (!node) return {resource, payload: {cloudDeleted: true}};
    const fresh = await workspaceResourcePayload(node);
    return {resource, payload: {...fresh, cloudDeleted: false}};
  }));
  if (!canApply()) return;
  for (const update of updates) {
    if (!update) continue;
    const {resource, payload} = update;
    // Canvas cards also display linked notes/records. Their content can change
    // without changing the .canvas file: rebuild the open canvas after every
    // received revision so its cards and inspector use the freshly loaded data.
    if (resource.type === 'canvas' || Object.entries(payload).some(([key, value]) => JSON.stringify(resource[key]) !== JSON.stringify(value))) {
      Object.assign(resource, payload, {renderVersion: (resource.renderVersion || 0) + 1});
    }
  }
  const openNoteIds = [...document.querySelectorAll<HTMLElement>('[data-primary-note-id], [data-secondary-note-id]')]
    .map(pane => Number(pane.dataset.primaryNoteId || pane.dataset.secondaryNoteId));
  if (openNoteIds.some(id => !state.notes.some(note => note.id === id)))
    toast('An open note was deleted remotely.', 'error');
}

const openResources = (path) => [state.primaryResource, state.secondaryResource,
  ...state.workspaceTabs.primary.map(tab => tab.resource), ...state.workspaceTabs.secondary.map(tab => tab.resource)]
  .filter(resource => resource?.path === path);

/** Saves a document opened as a workspace file, on top of the version its editor was drawn with: when the file
 * changed since (an agent wrote the note, another window saved it), the file is reloaded instead of overwritten.
 * The version belongs to the editor element, so an editor redrawn away cannot save with a newer one. */
async function persistWorkspaceMarkdown(path, editor, indicator) {
  if (!path || !editor) return;
  if (!editor.isConnected) return;
  if (indicator) { indicator.textContent = "Saving…"; indicator.dataset.state = 'saving'; }
  try {
    const saved = await api<{ version?: string }>("/workspace/file", {
      method: "PUT",
      body: JSON.stringify({ path, content: editor.value, expected_version: editor.dataset.version || null }),
    });
    if (saved?.version) editor.dataset.version = saved.version;
    openResources(path).forEach((resource) => { resource.content = editor.value; resource.version = saved?.version; });
    if (indicator) { indicator.textContent = "Saved"; indicator.dataset.state = 'saved'; }
  } catch (error) {
    if ((error as { status?: number }).status === 409) {
      const node = findWorkspaceNode(path);
      if (node) {
        const fresh = await workspaceResourcePayload(node);
        openResources(path).forEach((resource) => Object.assign(resource, fresh, { renderVersion: (resource.renderVersion || 0) + 1 }));
        toast("This document was changed by an agent or elsewhere: it now shows that version.", "error");
        await rerenderNotesContext();
        return;
      }
    }
    if (indicator) { indicator.textContent = "Save failed"; indicator.dataset.state = 'error'; }
    toast(error.message, "error");
  }
}

export function bindWorkspaceMarkdownEditors(root) {
  root
    ?.querySelectorAll("[data-workspace-markdown-path]")
    .forEach((container) => {
      if (container.closest('[data-workspace-bound="true"]')) return;
      const path = container.dataset.workspaceMarkdownPath;
      const editor = container.querySelector(".workspace-markdown-content");
      const blockEditor = container.querySelector(".markdown-block-editor");
      const indicator = container.querySelector(
        ".workspace-markdown-save-state",
      );
      const drawn = [state.primaryResource, state.secondaryResource, ...state.workspaceTabs.primary.map(tab => tab.resource),
        ...state.workspaceTabs.secondary.map(tab => tab.resource)].find(resource => resource?.path === path);
      if (editor && drawn?.version) editor.dataset.version = drawn.version;
      bindMarkdownBlockEditor(blockEditor, editor);
      bindMarkdownWritingExperience(editor);
      const queueSave = () => {
        const pending = workspaceMarkdownTimers.get(path);
        if (pending) clearTimeout(pending.timer);
        const save = () => persistWorkspaceMarkdown(path, editor, indicator);
        const timer = setTimeout(async () => {
          workspaceMarkdownTimers.delete(path);
          await save();
        }, 650);
        workspaceMarkdownTimers.set(path, { timer, save });
      };
      editor?.addEventListener("input", () => {
        if (indicator) indicator.textContent = "Unsaved changes…";
        queueSave();
      });
      blockEditor?.addEventListener("focusout", async (event) => {
        if (event.relatedTarget && blockEditor.contains(event.relatedTarget))
          return;
        const pending = workspaceMarkdownTimers.get(path);
        if (!pending) return;
        clearTimeout(pending.timer);
        workspaceMarkdownTimers.delete(path);
        await pending.save();
      });
    });
}

export async function flushWorkspaceMarkdownSaves() {
  await flushCollectionSaves();
  const pending = [...workspaceMarkdownTimers.values()];
  workspaceMarkdownTimers.clear();
  await Promise.all(
    pending.map((item) => {
      clearTimeout(item.timer);
      return item.save();
    }),
  );
}
