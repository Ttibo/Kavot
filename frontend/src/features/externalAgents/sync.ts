import { state, flushReaderAutosave, main, noteTitleTimers } from '../../app/state';
import { refreshData, render } from '../../app/navigation';
import { flushCurrentNoteAutosave, flushSecondaryNoteAutosave, flushWorkspaceMarkdownSaves, persistNoteTitle, forgetWorkspaceItems, findWorkspaceNode } from '../documents/workspace';
import { api } from '../../services/api';
import { flushCanvasSaves } from '../documents/canvas';
import { flushAgentSaves } from '../../app/agentEvents';
import { publish } from '../../app/viewBridge';
import { setMarkdownEditorsReadOnly } from '../documents/live-editor';

// The server may serialize attributes in another order (isEqualNode ignores it)
// and drops the target/rel the editor adds to links.
function sameMarkup(a: string, b: string) {
  const parse = (html: string) => {
    const body = new DOMParser().parseFromString(html, 'text/html').body;
    body.querySelectorAll('a').forEach(link => { link.removeAttribute('target'); link.removeAttribute('rel'); });
    // Notes saved before the server stopped identifying the code inside script blocks still carry ids there.
    body.querySelectorAll(':is([data-type="script-block"], [data-type="collection-view"]) [id]').forEach(node => node.removeAttribute('id'));
    return body;
  };
  return parse(a).isEqualNode(parse(b));
}

export async function prepareAgentContext() {
  await flushCurrentNoteAutosave();
  await flushSecondaryNoteAutosave();
  await flushReaderAutosave();
  await flushWorkspaceMarkdownSaves();
  await flushCanvasSaves();
  await flushAgentSaves();
  for (const input of document.querySelectorAll<HTMLInputElement>('[data-note-title-input]')) {
    const id = Number(input.dataset.noteTitleInput);
    clearTimeout(noteTitleTimers.get(id)); noteTitleTimers.delete(id);
    if (!await persistNoteTitle(id, input)) throw new Error('The note title must be saved before continuing.');
  }
  // Some existing autosave helpers show an error without rejecting their promise.
  // Compare source editors to the server before allowing agent writes.
  for (const [selector, id] of [
    ['#note-content', state.currentNoteId],
    ['#secondary-note-content', Number(document.querySelector<HTMLElement>('[data-secondary-note-id]')?.dataset.secondaryNoteId)],
  ] as const) {
    const source = document.querySelector<HTMLTextAreaElement>(selector);
    if (source && id) {
      const saved = await api<Note>(`/notes/${id}`);
      if (source.value !== saved.content && !sameMarkup(source.value, saved.content)) throw new Error('A note draft is not saved. Save it before starting the assistant.');
    }
  }
  if ([...document.querySelectorAll('.note-autosave-state')].some(el => /failed/i.test(el.textContent || ''))) {
    throw new Error('A save failed. Fix it before starting the assistant.');
  }
}

let protectionObserver: MutationObserver | null = null;
const protectedInputs = new Map<HTMLInputElement | HTMLTextAreaElement, boolean>();
const protectedButtons = new Map<HTMLButtonElement, boolean>();
export function lockAgentEditors(locked: boolean) {
  // Keep navigation, text selection, scrolling and all PDF viewer controls active.
  if (main) main.inert = false;
  setMarkdownEditorsReadOnly(locked);
  protectionObserver?.disconnect(); protectionObserver = null;
  if (!locked) {
    protectedInputs.forEach((value, input) => { input.readOnly = value; }); protectedInputs.clear();
    protectedButtons.forEach((value, button) => { button.disabled = value; }); protectedButtons.clear();
    return;
  }
  const protect = () => {
    main?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-note-title-input], .note-editor textarea, [data-workspace-markdown-path] textarea').forEach(input => {
      if (!protectedInputs.has(input)) { protectedInputs.set(input, input.readOnly); input.readOnly = true; }
    });
    main?.querySelectorAll<HTMLButtonElement>('[data-reader-md-action], [data-md-action], #capture-insert, #pdf-extract-toggle').forEach(button => {
      if (!protectedButtons.has(button)) { protectedButtons.set(button, button.disabled); button.disabled = true; }
    });
  };
  protect();
  if (main) { protectionObserver = new MutationObserver(protect); protectionObserver.observe(main, { childList: true, subtree: true }); }
}

export async function refreshAgentArtifacts() {
  await flushCanvasSaves();
  const previousNoteIds = state.notes.map(note => note.id);
  const previousPaths = new Set<string>([state.primaryResource, state.secondaryResource,
    ...state.workspaceTabs.primary.map(tab => tab.resource),
    ...state.workspaceTabs.secondary.map(tab => tab.resource)]
    .map(resource => resource?.path).filter(path => path && findWorkspaceNode(path)));
  await refreshData();
  forgetWorkspaceItems({ noteIds: previousNoteIds.filter(id => !state.notes.some(note => note.id === id)) });
  for (const path of previousPaths) if (!findWorkspaceNode(path)) forgetWorkspaceItems({ path });
  if (state.selectedProject) state.selectedProject = state.projects.find(project => project.id === state.selectedProject.id) || null;
  if (!state.databases.some(database => database.id === state.collectionId)) state.collectionId = 'articles';
  if (state.selectedPaperId && !state.papers.some(paper => paper.id === state.selectedPaperId)) state.selectedPaperId = null;
  const resources = new Set<any>([state.primaryResource, state.secondaryResource,
    ...state.workspaceTabs.primary.map(tab => tab.resource),
    ...state.workspaceTabs.secondary.map(tab => tab.resource)].filter(Boolean));
  for (const resource of resources) {
    if (resource.path?.endsWith('.md')) {
      const response = await fetch(`/api/workspace/file?path=${encodeURIComponent(resource.path)}`);
      if (response.status === 404) { forgetWorkspaceItems({ path: resource.path }); continue; }
      if (!response.ok) throw new Error('Unable to reload an open note.');
      resource.content = await response.text();
    }
    if (!resource.path?.toLowerCase().endsWith('.pdf')) resource.renderVersion = Number(resource.renderVersion || 0) + 1;
  }
  window.dispatchEvent(new CustomEvent('kavot:agent-notes-updated', { detail: { notes: state.notes } }));
  render();
  publish();
}
