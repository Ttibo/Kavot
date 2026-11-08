import { collectionRecordMarkup } from '../../collections/noteEditor';
import { iconPaths } from '../../../components/Icon';
import { reactTabPane } from '../../../app/tabs/kinds';
import { launcherPages, pages } from '../../../app/pages';
import { escapeHtml, noteAssetBase, renderMarkdown, state } from '../../../app/state';
import { markdownBlockEditorMarkup } from '../markdown';
import { canvasEditorMarkup } from '../canvas';
import { openDrawingEditor } from '../drawing';
import { pdfCaptureWorkspaceMarkup } from '../../library/documents';
import { api } from '../../../services/api';
import { toast } from '../../../app/navigation';
import { isDrawingNote } from './notesContext';
import { interfaceIcon } from './icons';
import { findWorkspaceNode } from './tree';
import { refreshWorkspaceTreeOnly } from './render';

export function markdownFormattingToolbarMarkup(
  _actionAttribute = "data-md-action",
  before = "",
  after = "",
) {
  return before || after ? `<div class="note-document-actions">${before}${after}</div>` : '';
}

function notePaneChrome(note, pane = "primary") {
  const workspace = Boolean(note.workspacePath);
  const secondary = pane === "secondary";
  // Keep save and document-status hooks for the editor integration without
  // repeating them visibly in the condensed toolbar.
  const hiddenStatus = workspace
    ? `<span class="note-autosave-state workspace-markdown-save-state" hidden>Saved</span>`
    : `<span class="note-autosave-state" id="${secondary ? "secondary-note-save-state" : "note-autosave-state"}" hidden>Saved automatically</span>`;
  return `${hiddenStatus}<span class="markdown-document-stats" aria-live="polite" hidden></span>`;
}

export function primaryNoteEditor(note, projectId = null) {
  if (!note)
    return `<div class="note-empty" data-pane-drop="primary"><span>✎</span><h3>No note in this folder</h3><p>The new note will be created in the selected location.</p><button class="button button-primary" data-action="new-note" ${projectId ? `data-project-id="${projectId}"` : ""}>＋ New note here</button></div>`;
  const assetBase = noteAssetBase(note);
  const blocks = markdownBlockEditorMarkup(note.content, {
    sourceId: "note-content",
    sourceClass: "note-content",
    editorId: "note-block-editor",
    assetBase,
    ariaLabel: `Markdown source — ${note.title}`,
  });
  return `<div class="note-editor note-pane" data-primary-note-id="${note.id}" data-pane-drop="primary">${notePaneChrome(note, "primary")}<div class="markdown-block-shell">${blocks}</div></div>`;
}

/** Drawing notes open their editor directly in the tab; the host is filled once it is in the page. */
export function drawingNotePane(note, pane = "primary") {
  watchDrawingHosts();
  return `<section class="drawing-note-pane drawing-inline-host note-pane" data-${pane}-note-id="${note.id}" data-pane-drop="${pane}" data-drawing-host="${note.id}" aria-label="${escapeHtml(note.title)}"></section>`;
}

let drawingHostWatcher: MutationObserver | null = null;

function mountDrawingHosts() {
  document.querySelectorAll<HTMLElement>("[data-drawing-host]:not([data-drawing-mounted])").forEach(host => {
    const note = state.notes.find(item => Number(item.id) === Number(host.dataset.drawingHost));
    if (!note) return;
    host.dataset.drawingMounted = "true";
    openNoteDrawing(note, host);
  });
}

function watchDrawingHosts() {
  queueMicrotask(mountDrawingHosts);
  if (drawingHostWatcher) return;
  // Only inserted subtrees can hold a new host: no need to search the whole page on every change.
  const selector = "[data-drawing-host]:not([data-drawing-mounted])";
  drawingHostWatcher = new MutationObserver(records => {
    for (const record of records)
      for (const node of record.addedNodes)
        if (node instanceof Element && (node.matches(selector) || node.querySelector(selector))) return mountDrawingHosts();
  });
  drawingHostWatcher.observe(document.body, { childList: true, subtree: true });
}

function openNoteDrawing(note: Note, host?: HTMLElement) {
  if (!isDrawingNote(note)) return;
  let draft: { title: string; drawing: Record<string, any>; drawing_preview: string } | null = null;
  try {
    openDrawingEditor(note.title || "Drawing", note.drawing as any, (title, drawing, drawing_preview) => {
      draft = { title, drawing, drawing_preview };
      Object.assign(note, draft);
      const current = state.notes.find(item => Number(item.id) === Number(note.id));
      if (current && current !== note) Object.assign(current, draft);
    }, async () => {
      if (!draft) return;
      const saved = await api<Note>(`/notes/${note.id}`, { method: "PATCH", body: JSON.stringify(draft) });
      Object.assign(note, saved);
      const current = state.notes.find(item => Number(item.id) === Number(note.id));
      if (current && current !== note) Object.assign(current, saved);
      await refreshWorkspaceTreeOnly();
    }, host);
  } catch (error) { toast(error.message, "error"); }
}

function relationalNoteMarkup(content: string, path: string) {
  const rendered = renderMarkdown(content).replace(/&amp;((?:#\d+|lt|gt|amp);)/g, '&$1');
  const document = new DOMParser().parseFromString(rendered, 'text/html');
  document.querySelectorAll('table').forEach(table => {
    if (table.closest('.markdown-table-wrap')) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'markdown-table-wrap';
    table.replaceWith(wrapper); wrapper.append(table);
  });
  document.querySelectorAll<HTMLElement>('.markdown-table-wrap').forEach((wrapper, index) => {
    wrapper.classList.add('review-data-table');
    const controls = document.createElement('div');
    controls.className = 'review-table-tools';
    controls.innerHTML = `<input type="search" data-review-search aria-label="Search table ${index + 1}" placeholder="Search this table…"><span>${wrapper.querySelectorAll('tbody tr').length} lignes</span>`;
    wrapper.prepend(controls);
    wrapper.querySelectorAll('th').forEach((header, column) => {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.reviewSort = String(column);
      button.textContent = header.textContent;
      header.textContent = ''; header.append(button); header.setAttribute('aria-sort', 'none');
    });
  });
  document.querySelectorAll('a').forEach(link => {
    const href = link.getAttribute('href') || '';
    if (href.startsWith('#resource/')) {
      link.setAttribute('data-action', 'open-project-resource');
      link.setAttribute('data-resource-target', decodeURIComponent(href.slice(10)));
      link.removeAttribute('target');
      return;
    }
    if (href.startsWith('#collection/')) {
      link.setAttribute('data-collection-nav', decodeURIComponent(href.slice(12)));
      link.removeAttribute('target');
      return;
    }
    if (!href.startsWith('./') && !href.startsWith('../')) return;
    const target = decodeURIComponent(new URL(href, `https://workspace.local/${path}`).pathname.slice(1));
    const node = findWorkspaceNode(target);
    if (!node) return;
    link.removeAttribute('target');
    link.setAttribute('href', '#');
    link.setAttribute(node.kind === 'directory' ? 'data-review-folder' : node.note_id ? 'data-note' : 'data-open-workspace-resource', String(node.note_id || target));
  });
  // Keep the generated content and link behavior intact while grouping each topic.
  let section: HTMLElement | null = null;
  for (const child of [...document.body.children]) {
    if (child.tagName === 'H2') {
      section = document.createElement('section');
      section.className = 'review-section';
      document.body.insertBefore(section, child);
    }
    if (section) section.append(child);
  }
  return document.body.innerHTML;
}

export async function refreshRelationalNotes() {
  const panes = [...document.querySelectorAll<HTMLElement>('[data-relational-note-path]')];
  await Promise.all(panes.map(async pane => {
    const path = pane.dataset.relationalNotePath;
    const revision = String(Number(pane.dataset.refreshRevision || 0) + 1);
    pane.dataset.refreshRevision = revision;
    try {
      const response = await fetch(`/api/workspace/file?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('Unable to refresh relational note');
      const content = await response.text();
      if (!pane.isConnected || pane.dataset.refreshRevision !== revision) return;
      pane.querySelector('.relational-note-content').innerHTML = relationalNoteMarkup(content, path);
      for (const resource of [state.primaryResource, state.secondaryResource, ...state.workspaceTabs.primary.map(tab => tab.resource), ...state.workspaceTabs.secondary.map(tab => tab.resource)]) {
        if (resource?.path === path) resource.content = content;
      }
    } catch (error) { toast(error.message, 'error'); }
  }));
}

export function workspaceResourcePane(resource, pane = "secondary") {
  // Pages, project sections and office documents are React tabs (see app/tabs).
  const reactTab = reactTabPane(resource, pane);
  if (reactTab) return reactTab;
  if (resource?.cloudDeleted) return '<section class="note-pane"><p role="status">This document was deleted remotely.</p></section>';
  if (resource?.type === "collection-record") return collectionRecordMarkup(resource, pane);
  const node = findWorkspaceNode(resource?.path) || resource;
  if (!node?.type && !node?.kind) return "";
  const kind = node.kind || node.type;
  const title = node.label || node.title || node.name || "Document";
  const path = node.path || resource.path;
  const url = node.url || resource.url || "";
  const paperId = Number(node.paper_id || node.paperId || resource.paperId || 0);
  const markdownContent = String(resource.content || "");
  if (kind === "canvas") return canvasEditorMarkup(resource, pane);
  if (kind === "markdown" && (node.generated || resource.generated)) {
    return `<section class="secondary-resource-pane note-pane relational-note-pane" data-${pane}-path="${escapeHtml(path)}" data-pane-drop="${pane}" data-relational-note-path="${escapeHtml(path)}"><header><strong>${escapeHtml(title)}</strong><small>Automatically updated · Read-only</small>${node.project_id ? `<button class="button" data-action="edit-project" data-project-id="${node.project_id}">Project settings</button><button class="button" data-action="add-project-resource" data-project-id="${node.project_id}">Link resource</button><a class="button" href="/api/projects/${node.project_id}/export" download>Export</a>` : ""}</header><article class="relational-note-content">${relationalNoteMarkup(markdownContent, path)}</article></section>`;
  }
  if (kind === "markdown") {
    const descriptor = { title, workspacePath: path, url };
    const blocks = markdownBlockEditorMarkup(markdownContent, {
      sourceClass: "note-content workspace-markdown-content",
      assetBase: "",
      ariaLabel: `Markdown source — ${title}`,
    });
    return `<section class="secondary-resource-pane workspace-markdown-pane note-pane note-editor" data-${pane}-path="${escapeHtml(path)}" data-pane-drop="${pane}" data-workspace-markdown-path="${escapeHtml(path)}">${notePaneChrome(descriptor, pane)}<div class="markdown-block-shell workspace-markdown-block-shell">${blocks}</div></section>`;
  }
  const content =
    kind === "image"
      ? `<div class="secondary-image-view"><img src="${escapeHtml(url)}" alt="${escapeHtml(title)}"></div>`
      : kind === "video" || kind === "audio"
        ? `<${kind} src="${escapeHtml(url)}" controls preload="metadata" aria-label="${escapeHtml(title)}"></${kind}>`
      : kind === "pdf" && paperId
        ? pdfCaptureWorkspaceMarkup(paperId, true, url)
      : `<iframe class="secondary-document-view" src="${escapeHtml(url)}${kind === "pdf" ? "#view=FitH" : ""}" title="${escapeHtml(title)}" data-document-theme></iframe>`;
  return `<section class="secondary-resource-pane resource-kind-${escapeHtml(kind)}" data-${pane}-path="${escapeHtml(path)}" data-pane-drop="${pane}">${content}</section>`;
}

export function secondaryResourcePane() {
  const resource = state.secondaryResource;
  if (!resource) return "";
  if (resource.type === "note") {
    const note = state.notes.find(
      (item) => item.id === Number(resource.noteId),
    );
    if (!note) return "";
    if (isDrawingNote(note)) return drawingNotePane(note, "secondary");
    const blocks = markdownBlockEditorMarkup(note.content, {
      sourceId: "secondary-note-content",
      sourceClass: "note-content",
      editorId: "secondary-note-block-editor",
      assetBase: noteAssetBase(note),
      ariaLabel: `Markdown source — ${note.title}`,
    });
    return `<section class="secondary-resource-pane secondary-note-pane note-pane" data-secondary-note-id="${note.id}" data-pane-drop="secondary">${notePaneChrome(note, "secondary")}<div class="markdown-block-shell">${blocks}</div></section>`;
  }
  return workspaceResourcePane(resource, "secondary");
}

/** A new tab: open a page of the application or start a document here. */
export function emptyWorkspacePane(pane = "primary") {
  const page = (view, icon, label) => `<button type="button" class="workspace-launch" data-nav="${view}"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${iconPaths[icon]}"/></svg><span>${label}</span></button>`;
  const create = (action, icon, label) => `<button type="button" class="workspace-launch" data-action="${action}">${interfaceIcon(icon)}<span>${label}</span></button>`;
  return `<section class="workspace-empty-pane workspace-launcher" data-pane-drop="${pane}"><div><h3>New tab</h3><p>Open a page or start a document here. Ctrl+click anywhere opens in a new tab.</p>
    <div class="workspace-launch-group"><small>Open</small>${launcherPages.map(id => page(id, pages[id].icon, pages[id].title)).join("")}</div>
    <div class="workspace-launch-group"><small>Create</small>${create("new-note", "noteplus", "Note")}${create("new-canvas", "canvas", "Canvas")}${create("new-drawing", "draw", "Drawing")}</div></div></section>`;
}
