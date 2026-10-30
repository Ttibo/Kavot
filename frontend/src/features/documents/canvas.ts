import { canvasTextCss, canvasTextControls } from './canvasText';
import { renderPdfPreviews } from './pdfPreview';
import { mediaPreview, mediaKind } from './mediaPreview';
import { workspaceColor } from '../../styles/palette';
import { closestConnectorSides } from './canvasRouting';
import { showContextMenu } from '../../components/contextMenu';
import { registerAgentContext, suggestToAgent, suggestions } from '../externalAgents/context';
import { escapeHtml, noteAssetBase, renderMarkdown, state, truncate } from '../../app/state';
import { api } from '../../services/api';
import { flushSecondaryNoteAutosave, flushWorkspaceMarkdownSaves, findWorkspaceNode, interfaceIcon, noteContextLabel, refreshRelationalNotes, refreshWorkspaceTreeOnly, replaceActiveWorkspaceTab, rerenderNotesContext, workspaceResourcePayload, workspaceResourceTab } from './workspace';
import { collectionItems, collectionDragPayload, collectionItemCanvasPayload, findCollectionItem, openCollectionItem, parseCollectionDragPayload } from '../collections/catalog';
import { refreshData, toast } from '../../app/navigation';
import { bindMarkdownBlockEditor, currentMarkdownBlockInput, markdownBlockEditorMarkup, setMarkdownBlockEditorContent } from './markdown';
import { closeModal, openModal, templateEditorModal } from '../../components/dialogs/controller';
import { previewPaperPdfModal } from '../library/documents';
import { canvasHiddenNodes, migrateCanvasBranchFolds, canvasWebUrl, canvasMovementNodes, canvasTemplateIcon, canvasNoteTreeOpenPaths } from './canvasModel';
import { conferenceModal, datasetModal } from '../research/actions';
import { newTaskModal } from '../tasks/dialogs';
import { openItemInSheet } from '../collections/itemSheet';
import { bindNoteReferences, noteReferencePickerMarkup } from './references';
import { editorSession } from '../../app/editorSession';

import { canvasCollections, collectionCardPreview } from '../collections/canvasCollections';
import { openCanvasCollectionPicker } from '../collections/canvasCollectionPicker';
import { loadReadingNote } from '../library/documents';

import { drawingPreviewPng, emptyDrawing, flushInlineDrawings, openDrawingEditor } from './drawing';
import { hydrateEmbeds } from './embeds';

type WebPreview = { available: boolean; title: string; description: string; image?: string };
const webPreviews = new Map<string, WebPreview>();
const webPreviewRequests = new Map<string, Promise<void>>();
async function loadWebPreview(url: string) {
  if (webPreviews.has(url)) return;
  if (!webPreviewRequests.has(url)) webPreviewRequests.set(url, api<WebPreview>("/workspace/link-preview", { method: "POST", body: JSON.stringify({ url }) }).then(preview => {
    webPreviews.set(url, preview);
  }).catch(() => { webPreviews.set(url, { available: false, title: new URL(url).hostname, description: "Preview unavailable. Open the website to read this source." }); }).finally(() => webPreviewRequests.delete(url)));
  await webPreviewRequests.get(url);
}

// Canvases shown live inside other canvases, as last read from disk, keyed by path.
const canvasEmbeds = new Map<string, any>();
const canvasEmbedRequests = new Map<string, Promise<boolean>>();
/** Read an embedded canvas again; resolves true when its content changed. */
function loadCanvasEmbed(path: string): Promise<boolean> {
  if (!canvasEmbedRequests.has(path)) canvasEmbedRequests.set(path, fetch(`/api/workspace/file?path=${encodeURIComponent(path)}`, { cache: "no-store" })
    .then(response => response.ok ? response.json() : { missing: true }).catch(() => null).then(content => {
      if (!content || typeof content !== "object") return false;
      const changed = JSON.stringify(canvasEmbeds.get(path)) !== JSON.stringify(content);
      canvasEmbeds.set(path, content);
      return changed;
    }).finally(() => canvasEmbedRequests.delete(path)));
  return canvasEmbedRequests.get(path);
}

function canvasEmbedPath(node): string | null {
  if (node.projectId) return state.projects.find(item => item.id === Number(node.projectId))?.canvas_path || null;
  return node.canvasPath || null;
}

function openCanvasResources() {
  return [state.primaryResource, state.secondaryResource,
    ...state.workspaceTabs.primary.map(tab => tab.resource), ...state.workspaceTabs.secondary.map(tab => tab.resource)];
}

/** A canvas being edited in this window: its editor is shown, or its edits are not saved yet. */
function canvasEditedHere(path: string) {
  return Boolean(document.querySelector(`[data-canvas-path="${CSS.escape(path)}"]`) || canvasSaveTimers.has(path) || canvasSaveRequests.has(path));
}

/** A canvas being edited here shows its latest edits; any other is read from disk, never from a stale tab. */
function canvasEmbedSource(path: string) {
  const open = canvasEditedHere(path)
    ? openCanvasResources().find(resource => resource?.path === path && resource.content && typeof resource.content === "object")
    : null;
  return open?.content || canvasEmbeds.get(path);
}

async function openEmbeddedCanvas(node) {
  await flushCanvasSaves();
  if (node.projectId) {
    const { openProjectArea } = await import("../projects/navigation");
    return openProjectArea(Number(node.projectId), "canvas");
  }
  const target = findWorkspaceNode(node.canvasPath);
  if (!target) throw new Error("This canvas no longer exists");
  const pane = state.activeNotePane === "secondary" && state.workspaceTabs.secondary.length ? "secondary" : "primary";
  replaceActiveWorkspaceTab(pane, workspaceResourceTab(await workspaceResourcePayload(target)));
  await rerenderNotesContext();
}

// A shown canvas is a frame holding the source's own cards at full size, so each can be linked from here.
const EMBED_PADDING = 40;
const EMBED_HEADER = 72;

/** The source's cards and links placed in the frame; ids are `<frame id>~<source id>`, stable across reloads. */
function canvasEmbedMirror(embed) {
  const path = canvasEmbedPath(embed);
  const source = path ? canvasEmbedSource(path) : null;
  if (!source || source.missing) return { nodes: [], edges: [] };
  const allNodes = source.nodes || [], allEdges = source.edges || [];
  const hidden = canvasHiddenNodes(allNodes, allEdges);
  const visible = allNodes.filter(item => !hidden.has(item.id));
  if (!visible.length) return { nodes: [], edges: [] };
  const left = Math.min(...visible.map(item => Number(item.x) || 0)), top = Math.min(...visible.map(item => Number(item.y) || 0));
  const id = (sourceId: string) => `${embed.id}~${sourceId}`;
  return {
    nodes: visible.map(item => ({ ...item, ...canvasNodeSize(item), id: id(item.id), mirrorOf: embed.id,
      x: (Number(embed.x) || 0) + EMBED_PADDING + (Number(item.x) || 0) - left,
      y: (Number(embed.y) || 0) + EMBED_HEADER + (Number(item.y) || 0) - top })),
    edges: allEdges.filter(edge => !hidden.has(edge.fromNode) && !hidden.has(edge.toNode))
      .map(edge => ({ ...edge, id: id(edge.id), fromNode: id(edge.fromNode), toNode: id(edge.toNode), mirrorOf: embed.id })),
  };
}

function canvasEmbedPreview(node) {
  // A canvas shown inside a shown canvas stays a plain card: no endless nesting.
  if (node.mirrorOf) return `<p class="canvas-embed-empty">${interfaceIcon("canvas")} Canvas</p>`;
  const path = canvasEmbedPath(node);
  const source = path ? canvasEmbedSource(path) : { missing: true };
  const message = source?.missing ? "This canvas no longer exists." : !source ? "Loading canvas…" : !(source.nodes || []).length ? "This canvas is empty." : "";
  return `<div class="canvas-embed" data-canvas-embed="${escapeHtml(path || "")}" title="Double-click to open this canvas">${message ? `<p class="canvas-embed-empty">${escapeHtml(message)}</p>` : ""}</div>`;
}

const canvasSaveTimers = new Map();
const canvasSaveRequests = new Map<string, Promise<unknown>>();
// Keep pending inspector edits alive when cards or views change.
const canvasDetailSaves = new Map<string, { timer: ReturnType<typeof setTimeout>; save: () => Promise<void>; failed?: boolean }>();
const canvasDetailRequests = new Map<string, Promise<void>>();
export const hasCanvasDrafts = () => Boolean(canvasSaveTimers.size || canvasSaveRequests.size || canvasDetailSaves.size || canvasDetailRequests.size);

export function removeNoteFromOpenCanvases(noteId) {
  removeFromOpenCanvases(node => ["note", "drawing"].includes(node.type) && Number(node.noteId) === Number(noteId));
}

function removeFromOpenCanvases(matches) {
  const resources = new Set(
    [
      state.primaryResource,
      state.secondaryResource,
      ...state.workspaceTabs.primary.map((tab) => tab.resource),
      ...state.workspaceTabs.secondary.map((tab) => tab.resource),
    ].filter((resource) => resource?.type === "canvas" || resource?.path?.endsWith(".canvas")),
  );
  resources.forEach((resource) => {
    const content = resource.content;
    if (!content || typeof content !== "object") return;
    const removedIds = new Set(
      (content.nodes || [])
        .filter(matches)
        .map((node) => String(node.id)),
    );
    if (!removedIds.size) return;
    content.nodes = (content.nodes || []).filter((node) => !removedIds.has(String(node.id)));
    content.edges = (content.edges || []).filter(
      (edge) =>
        !removedIds.has(String(edge.fromNode)) &&
        !removedIds.has(String(edge.toNode)),
    );
    resource.renderVersion = Number(resource.renderVersion || 0) + 1;
  });
}

/** Update presentation only: never rebuild an open editor or discard its draft. */
export function refreshCanvasTemplatePresentation() {
  document.querySelectorAll<HTMLElement>('[data-canvas-edit-template]').forEach(badge => {
    const template = state.noteTemplates.find(item => item.id === Number(badge.dataset.canvasEditTemplate));
    const card = badge.closest<HTMLElement>('[data-canvas-node]');
    if (!template || !card) return;
    badge.textContent = `${template.name}${template.archived ? ' · archived' : ''}`;
    card.style.setProperty('--canvas-card-color', workspaceColor(template.color || '#087e86'));
    const icon = card.querySelector('.canvas-node-header > span');
    if (icon) icon.innerHTML = interfaceIcon(canvasTemplateIcon(template), 'canvas-card-icon');
  });
}

function canvasUid(prefix = "node") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function canvasWorkspaceResources(kinds, nodes = state.workspaceTree, output = []) {
  (nodes || []).forEach((node) => {
    if (kinds.includes(node.kind)) output.push(node);
    canvasWorkspaceResources(kinds, node.children || [], output);
  });
  return output;
}

function canvasNoteTreeMarkup(nodes, query = "", canvasNoteIds = new Set(), seenNoteIds = new Set(), ancestorMatches = false, openPaths = new Set<string>()) {
  return (nodes || []).map((node) => {
    if (node.path === "trash") return "";
    const label = String(node.label || node.name || "Untitled");
    const searchable = `${label} ${node.path || ""}`.toLocaleLowerCase();
    const branchMatches = ancestorMatches || Boolean(query && searchable.includes(query));
    if (node.kind === 'pdf' && node.paper_id) return ''; // The article is represented by its reading note.
    if (node.note_id) {
      const noteId = Number(node.note_id);
      if (seenNoteIds.has(noteId) || (query && !branchMatches)) return "";
      seenNoteIds.add(noteId);
      const note = state.notes.find((item) => Number(item.id) === noteId);
      const alreadyAdded = canvasNoteIds.has(noteId);
      return `<button class="canvas-picker-note" data-canvas-note-id="${noteId}" ${alreadyAdded ? "disabled" : ""} style="--picker-color:${escapeHtml(workspaceColor(note?.template_color || "#087e86"))}">${interfaceIcon("note")}<span><strong>${escapeHtml(note?.title || label)}</strong><small>${alreadyAdded ? "Already on this canvas" : escapeHtml(noteContextLabel(note || {}))}</small></span></button>`;
    }
    if (node.protected && ["image", "pdf", "file"].includes(node.kind)) {
      if (query && !branchMatches) return "";
      const assetType = ["image", "pdf"].includes(node.kind) ? node.kind : "file";
      return `<button class="canvas-picker-asset" data-canvas-asset-path="${escapeHtml(node.path || "")}" style="--picker-color:#087e86">${interfaceIcon(assetType)}<span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(node.path || "Asset")}</small></span></button>`;
    }
    const children = canvasNoteTreeMarkup(node.children || [], query, canvasNoteIds, seenNoteIds, branchMatches, openPaths);
    if (!children && (query || !node.folder_id && !openPaths.has(node.path))) return "";
    return `<details class="canvas-picker-branch" data-canvas-tree-path="${escapeHtml(node.path || "")}" ${query || openPaths.has(node.path) ? "open" : ""}><summary>${interfaceIcon(node.kind === "project" ? "project" : "folder")}<span>${escapeHtml(label)}</span></summary><div>${children || '<p class="canvas-picker-empty">No notes in this folder.</p>'}</div></details>`;
  }).join("");
}

function canvasTemplatePickerMarkup(includeText = false, query = "") {
  const templates = state.noteTemplates.filter((template) =>
    !template.archived && `${template.name} ${template.title_template || ""}`.toLocaleLowerCase().includes(query),
  ).map((template) =>
    `<button class="canvas-picker-template" data-canvas-template-choice="${template.id}" style="--picker-color:${escapeHtml(workspaceColor(template.color || "#087e86"))}">${interfaceIcon(canvasTemplateIcon(template))}<span><strong>${escapeHtml(template.name)}</strong><small>${escapeHtml(template.title_template || "Create from template")}</small></span></button>`,
  ).join("");
  return `<div class="canvas-picker-quick-actions"><button data-canvas-blank-note style="--picker-color:#087e86">${interfaceIcon("plus")}<span><strong>Blank note</strong><small>Create a new empty note</small></span></button>${includeText ? `<button data-canvas-connection-text style="--picker-color:#d4a850">${interfaceIcon("text")}<span><strong>Text card</strong><small>Add free text without creating a note</small></span></button>` : ""}</div><div class="canvas-picker-section-title">Templates</div><div class="canvas-picker-template-grid">${templates || "<p>No template available.</p>"}</div>`;
}

function canvasNodeMinimumSize(node) {
  if (node.type === "zone") return { width: 320, height: 220 };
  if (node.type === "shape") return { width: 120, height: 80 };
  if (node.type === "text") return { width: 150, height: 80 };
  return { width: 180, height: 120 };
}

function canvasNodeSize(node) {
  const minimum = canvasNodeMinimumSize(node);
  return {
    width: Math.max(minimum.width, Number(node.width) || 300),
    height: Math.max(minimum.height, Number(node.height) || 190),
  };
}

const canvasSideNames = ["top", "right", "bottom", "left"];

const canvasShapeNames = ["rectangle", "ellipse", "diamond"];

function canvasSidePoint(node, side) {
  const { width, height } = canvasNodeSize(node);
  const left = Number(node.x) || 0;
  const top = Number(node.y) || 0;
  if (side === "top") return { x: left + width / 2, y: top };
  if (side === "right") return { x: left + width, y: top + height / 2 };
  if (side === "bottom") return { x: left + width / 2, y: top + height };
  return { x: left, y: top + height / 2 };
}

function canvasDefaultEdgeSides(from, to) {
  return closestConnectorSides(
    { x: Number(from.x) || 0, y: Number(from.y) || 0, ...canvasNodeSize(from) },
    { x: Number(to.x) || 0, y: Number(to.y) || 0, ...canvasNodeSize(to) },
  );
}

function canvasSideControlPoint(point, side, distance) {
  if (side === "top") return { x: point.x, y: point.y - distance };
  if (side === "right") return { x: point.x + distance, y: point.y };
  if (side === "bottom") return { x: point.x, y: point.y + distance };
  return { x: point.x - distance, y: point.y };
}

function canvasEdgeGeometry(fromPoint, fromSide, toPoint, toSide) {
  const distance = Math.hypot(toPoint.x - fromPoint.x, toPoint.y - fromPoint.y);
  const curve = Math.max(18, Math.min(180, distance * 0.25));
  const fromControl = canvasSideControlPoint(fromPoint, fromSide, curve);
  const toControl = canvasSideControlPoint(toPoint, toSide, curve);
  return {
    path: `M ${fromPoint.x} ${fromPoint.y} C ${fromControl.x} ${fromControl.y}, ${toControl.x} ${toControl.y}, ${toPoint.x} ${toPoint.y}`,
    midpoint: {
      x: (fromPoint.x + 3 * fromControl.x + 3 * toControl.x + toPoint.x) / 8,
      y: (fromPoint.y + 3 * fromControl.y + 3 * toControl.y + toPoint.y) / 8,
    },
  };
}

function canvasEdgePath(fromPoint, fromSide, toPoint, toSide) {
  return canvasEdgeGeometry(fromPoint, fromSide, toPoint, toSide).path;
}

function canvasDraftTargetSide(fromPoint, toPoint) {
  const deltaX = toPoint.x - fromPoint.x;
  const deltaY = toPoint.y - fromPoint.y;
  if (Math.abs(deltaX) >= Math.abs(deltaY))
    return deltaX >= 0 ? "left" : "right";
  return deltaY >= 0 ? "top" : "bottom";
}

// Below this zoom, cards show only their title.
const CANVAS_OVERVIEW_ZOOM = 0.2;

// A note card shows its whole page: it is laid out at a document width, then zoomed
// to the card. Narrow cards use a narrower page so the text stays readable.
function canvasNotePageLayout(cardWidth: number) {
  const width = Math.round(Math.min(820, Math.max(560, cardWidth * 1.6)));
  return { width, zoom: cardWidth / width };
}

function applyNotePageLayout(sheet: HTMLElement) {
  const page = sheet.querySelector<HTMLElement>(":scope > .canvas-note-page");
  if (!page || !sheet.clientWidth) return;
  const layout = canvasNotePageLayout(sheet.clientWidth);
  page.style.width = `${layout.width}px`;
  page.style.zoom = String(layout.zoom);
}

const noteSheetObserver = typeof ResizeObserver === "undefined" ? null
  : new ResizeObserver(entries => entries.forEach(entry => applyNotePageLayout(entry.target as HTMLElement)));

function fitNoteSheets(root: ParentNode) {
  root.querySelectorAll<HTMLElement>("[data-canvas-note-sheet]").forEach(sheet => {
    // Script blocks and collection views show their live interface, not their source.
    hydrateEmbeds(sheet.querySelector<HTMLElement>(":scope > .canvas-note-page"));
    applyNotePageLayout(sheet);
    noteSheetObserver?.observe(sheet);
  });
}

function canvasNodePreview(node) {
  if (node.type === "articles" || node.type === "collection") return collectionCardPreview(node);
  if (node.type === "canvas") return canvasEmbedPreview(node);
  if (node.type === "project") {
    const project = state.projects.find((item) => item.id === Number(node.projectId));
    const description = project?.description || node.description || "Add the project objective.";
    const tasks = state.tasks.filter(task => task.project_id === Number(node.projectId));
    const done = tasks.filter(task => task.status === "done").length;
    return `<div class="canvas-project-preview" data-canvas-open-card="${escapeHtml(node.id)}"><p>${escapeHtml(description)}</p><div class="canvas-project-progress"><span>${done} / ${tasks.length} tasks completed</span><progress value="${done}" max="${tasks.length || 1}" aria-label="Project task progress"></progress></div></div>`;
  }
  if (node.type === "note") {
    const note = state.notes.find((item) => item.id === Number(node.noteId));
    // The whole HTML page, zoomed to the card (see fitNoteSheets).
    const paper = ({cream: '#fffaf0', slate: '#eef3f7'} as Record<string, string>)[note?.presentation?.theme];
    const layout = canvasNotePageLayout(canvasNodeSize(node).width - 16);
    return note
      ? `<div class="canvas-note-sheet" data-canvas-note-sheet${paper ? ` data-paper style="--note-paper:${paper}"` : ""}><article class="canvas-note-page markdown-preview" aria-label="Content of ${escapeHtml(note.title)}" style="width:${layout.width}px;zoom:${layout.zoom}">${renderMarkdown(String(note.content || ""), noteAssetBase(note))}</article></div>`
      : `<div class="canvas-missing-preview">This note no longer exists.</div>`;
  }
  if (["paper", "task", "conference", "dataset", "record"].includes(node.type)) {
    const item = findCollectionItem({
      type: node.collectionType || node.type,
      id: node.recordId,
      databaseId: node.databaseId,
    });
    const detail = item?.detail || node.detail || "Linked collection record";
    const meta = item?.meta || node.status || node.databaseId || "Collection";
    return `<div class="canvas-collection-preview"><span>${escapeHtml(node.collectionType || node.type)}</span><p>${escapeHtml(truncate(detail, 240))}</p><div class="canvas-card-tags"><small>${escapeHtml(meta)}</small>${node.databaseId ? `<small>Collection</small>` : ""}</div></div>`;
  }
  if (["video", "audio"].includes(node.type)) return mediaPreview(node.url || "", node.title || "File", node.type);
  if (node.type === "pdf")
    return `<div class="canvas-pdf-preview" data-canvas-pdf-preview="${escapeHtml(node.url || (node.paperId ? `/api/papers/${node.paperId}/file` : node.path ? `/api/workspace/file?path=${encodeURIComponent(node.path)}` : ""))}" aria-label="${escapeHtml(node.title || "PDF")}">Loading preview…</div>`;
  if (node.type === "drawing")
    return `<img draggable="false" src="${escapeHtml(node.preview || "")}" alt="${escapeHtml(node.title || "Drawing")}" title="Click to edit drawing">`;
  if (node.type === "image")
    return `<img draggable="false" src="${escapeHtml(node.url || "")}" alt="${escapeHtml(node.title || "Image")}" loading="lazy">`;
  if (node.type === "link") {
    const url = canvasWebUrl(node.url || "");
    if (!url) return `<div class="canvas-missing-preview">Invalid web address</div>`;
    const preview = webPreviews.get(url);
    const image = preview?.image && canvasWebUrl(preview.image);
    return `<div class="canvas-link-preview" data-web-preview="${escapeHtml(url)}">${image ? `<img class="canvas-web-image" src="${escapeHtml(image)}" alt="" loading="lazy" draggable="false" referrerpolicy="no-referrer">` : ""}<div class="canvas-web-copy"><span>${interfaceIcon("link")} ${escapeHtml(new URL(url).hostname)}</span><strong>${escapeHtml(preview?.title || node.title || new URL(url).hostname)}</strong><p>${escapeHtml(preview?.description || (preview ? "Website preview" : "Loading preview…"))}</p><a class="canvas-web-reference" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open website ↗</a></div></div>`;
  }
  if (node.type === 'code-file' || node.type === 'code-folder') return `<p>This old card can no longer be opened.</p>`;
  if (node.type === "file")
    return `<a class="canvas-file-reference" href="${escapeHtml(node.url || "#")}" target="_blank" rel="noreferrer"><span>${interfaceIcon("file")}</span><strong>${escapeHtml(node.title || "File")}</strong><small>Open reference ↗</small></a>`;
  if (node.type === "zone")
    return `<textarea class="canvas-zone-description" data-canvas-zone-description="${escapeHtml(node.id)}" placeholder="Describe this area…">${escapeHtml(node.description || "")}</textarea>`;
  if (node.type === "shape") {
    const kind = canvasShapeNames.includes(node.shape) ? node.shape : "rectangle";
    const geometry = kind === "ellipse"
      ? '<ellipse cx="50" cy="50" rx="47" ry="45"/>'
      : kind === "diamond"
        ? '<polygon points="50,3 97,50 50,97 3,50"/>'
        : '<rect x="3" y="3" width="94" height="94" rx="8"/>';
    return `<div class="canvas-shape-surface canvas-shape-${kind}"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${geometry}</svg><textarea class="canvas-shape-label" data-canvas-shape-label="${escapeHtml(node.id)}" placeholder="Label…">${escapeHtml(node.text || "")}</textarea></div>`;
  }
  return `<textarea class="canvas-text-editor" data-canvas-text="${escapeHtml(node.id)}" placeholder="Write an idea…">${escapeHtml(node.text || "")}</textarea>`;
}

function canvasNodeIcon(node) {
  const type = node?.type;
  if (type === "note") {
    const note = state.notes.find(item => item.id === Number(node.noteId));
    const template = state.noteTemplates.find(item => item.id === Number(note?.template_id ?? node.templateId));
    return interfaceIcon(canvasTemplateIcon(template), "canvas-card-icon");
  }
  const icons = {
    'code-file': 'file',
    'code-folder': 'folder',
    link: "link",
    project: "project",
    canvas: "canvas",
    articles: "database",
    collection: "database",
    note: "bulb",
    pdf: "pdf",
    image: "image",
    drawing: "edit",
    file: "file",
    task: "task",
    conference: "conference",
    dataset: "database",
    record: "database",
    paper: "file",
    shape: "diamond",
    zone: "zone",
    text: "text",
  };
  return interfaceIcon(icons[type] || "file", "canvas-card-icon");
}

/** The project card and the project home note stay on their own project canvas; elsewhere they are ordinary cards. */
function canvasNodeProtected(node, hostProjectId): boolean {
  if (!hostProjectId) return false;
  if (node.type === "project") return !node.projectId || Number(node.projectId) === Number(hostProjectId);
  const note = node.noteId != null ? state.notes.find(item => Number(item.id) === Number(node.noteId)) : null;
  return note?.system_kind === "project_home" && Number(note.project_id) === Number(hostProjectId);
}

function canvasNodeMarkup(node, hostProjectId = null) {
  const { width, height } = canvasNodeSize(node);
  const zoneTones = ["teal", "blue", "green", "amber", "rose"];
  const zoneTone = zoneTones.includes(node.tone) ? node.tone : "teal";
  const note =
    node.type === "note"
      ? state.notes.find((item) => item.id === Number(node.noteId))
      : null;
  const shapeKind = canvasShapeNames.includes(node.shape) ? node.shape : "rectangle";
  const project = node.type === "project" || node.type === "canvas" && node.projectId
    ? state.projects.find((item) => item.id === Number(node.projectId))
    : null;
  const title = note?.title || project?.name || node.title || (node.type === "text" ? "Text" : node.type === "shape" ? shapeKind : node.type === "zone" ? "New zone" : "Resource");
  const connectors = node.type === "zone" ? "" : canvasSideNames
    .map((side) => `<button class="canvas-connector ${side}" data-canvas-connector="${side}" aria-label="Connect from the ${side} side" title="Drag to another side"></button>`)
    .join("");
  const titleMarkup = node.type === "zone"
    ? `<input data-canvas-zone-title="${escapeHtml(node.id)}" value="${escapeHtml(title)}" maxlength="120" aria-label="Zone title">`
    : `<strong>${escapeHtml(title)}</strong>`;
  const typeColors = {
    project: "#1f8a5b",
    note: "#1f8a5b",
    paper: "#2877ca",
    pdf: "#2877ca",
    file: "#2877ca",
    image: "#2896b3",
    task: "#20836c",
    dataset: "#20836c",
    record: "#20836c",
    conference: "#a06c13",
    text: "#bc4c81",
  };
  const template = state.noteTemplates.find(item => item.id === Number(note?.template_id ?? node.templateId));
  const templateBadge = template ? `<button class="canvas-template-badge" data-canvas-edit-template="${template.id}" title="Edit card template">${escapeHtml(template.name)}${template.archived ? " · archived" : ""}</button>` : "";
  const color = template?.color || (/^#[0-9a-f]{6}$/i.test(node.color || "")
    ? node.color
    : typeColors[node.type] || "#087e86");
  // Cards of a shown canvas are edited in their source: here they can only be linked.
  const mirrored = node.mirrorOf ? ` canvas-node-mirrored" data-mirror-of="${escapeHtml(node.mirrorOf)}` : "";
  const deleteAction = node.mirrorOf || canvasNodeProtected(node, hostProjectId) ? "" : `<button data-canvas-delete-node="${escapeHtml(node.id)}" title="Remove from canvas" aria-label="Remove ${escapeHtml(title)} from canvas">×</button>`;
  if (["image", "pdf", "video", "audio", "file", "link"].includes(node.type)) {
    return `<article class="canvas-node canvas-node-${escapeHtml(node.type)} canvas-node-media${mirrored}" aria-label="${escapeHtml(title)}" data-canvas-node="${escapeHtml(node.id)}" style="left:${Number(node.x) || 0}px;top:${Number(node.y) || 0}px;width:${width}px;height:${height}px;--canvas-card-color:${escapeHtml(workspaceColor(color))}">${connectors}${deleteAction}<div class="canvas-node-content">${canvasNodePreview(node)}</div><span class="canvas-node-resize" aria-hidden="true"></span></article>`;
  }
  return `<article class="canvas-node canvas-node-${escapeHtml(node.type)} canvas-tone-${zoneTone}${mirrored}" data-canvas-node="${escapeHtml(node.id)}" style="left:${Number(node.x) || 0}px;top:${Number(node.y) || 0}px;width:${width}px;height:${height}px;--canvas-card-color:${escapeHtml(workspaceColor(color))}${canvasTextCss(node)}">${connectors}<header class="canvas-node-header"><span>${canvasNodeIcon(node)}</span>${titleMarkup}<div>${templateBadge}${node.type === "text" ? `<button data-canvas-text-style="${escapeHtml(node.id)}" aria-label="Bubble style" title="Bubble style">Aa</button>` : ""}${deleteAction}</div></header><div class="canvas-node-content">${canvasNodePreview(node)}</div><span class="canvas-node-resize" aria-hidden="true"></span></article>`;
}

function canvasEdgeMarkup(edge, nodes, edges = []) {
  const from = nodes.find((node) => node.id === edge.fromNode);
  const to = nodes.find((node) => node.id === edge.toNode);
  if (!from || !to) return "";
  const { fromSide, toSide } = canvasDefaultEdgeSides(from, to);
  const fromPoint = canvasSidePoint(from, fromSide);
  const toPoint = canvasSidePoint(to, toSide);
  const siblings = edges.filter(item => {
    if (item.fromNode !== from.id) return false;
    const target = nodes.find(node => node.id === item.toNode);
    return target && canvasDefaultEdgeSides(from, target).fromSide === fromSide;
  });
  const offset = (Math.max(0, siblings.indexOf(edge)) - (siblings.length - 1) / 2) * 28;
  const junction = canvasSideControlPoint(fromPoint, fromSide, Math.min(26, Math.max(16, Math.hypot(toPoint.x - fromPoint.x, toPoint.y - fromPoint.y) / 5)));
  if (fromSide === "left" || fromSide === "right") junction.y += offset;
  else junction.x += offset;
  const opposite = { top: "bottom", right: "left", bottom: "top", left: "right" }[fromSide];
  const stub = canvasEdgeGeometry(fromPoint, fromSide, junction, opposite);
  const geometry = canvasEdgeGeometry(junction, fromSide, toPoint, toSide);
  const path = edge.collapsed ? stub.path : `${stub.path} ${geometry.path.slice(geometry.path.indexOf(" C ") + 1)}`;
  const labelX = Math.round(geometry.midpoint.x);
  let labelY = Math.round(geometry.midpoint.y);
  const color = /^#[0-9a-f]{6}$/i.test(edge.color || "") && edge.color !== "#77746d" ? edge.color : (to.color || (to.type === "note" ? "#72d4e8" : to.type === "articles" ? "#92b1b7" : "#71a991"));
  const displayLabel = truncate(edge.label || "", 42);
  const labelWidth = Math.max(64, displayLabel.length * 10 + 28);
  // Keep relation captions outside cards, even when two cards sit close together.
  for (let attempt = 0; displayLabel && attempt <= nodes.length; attempt++) {
    const collisions = nodes.filter(node => node.type !== 'zone' && node.type !== 'canvas'
      && labelX + labelWidth / 2 + 8 > Number(node.x)
      && labelX - labelWidth / 2 - 8 < Number(node.x) + canvasNodeSize(node).width
      && labelY + 21 > Number(node.y)
      && labelY - 21 < Number(node.y) + canvasNodeSize(node).height);
    if (!collisions.length) break;
    labelY = Math.min(...collisions.map(node => Number(node.y))) - 30 - Math.max(0, edges.indexOf(edge)) * 44;
  }
  const leader = labelY !== Math.round(geometry.midpoint.y) && !edge.collapsed
    ? `<path d="M ${labelX} ${geometry.midpoint.y} L ${labelX} ${labelY + 17}" fill="none" stroke="${escapeHtml(workspaceColor(color))}" stroke-width="1.5" stroke-dasharray="3 4" pointer-events="none"/>` : '';
  const label = displayLabel && !edge.collapsed
    ? `${leader}<g class="canvas-edge-label" style="--edge-color:${escapeHtml(workspaceColor(color))}" data-canvas-edge="${escapeHtml(edge.id)}" transform="translate(${labelX} ${labelY})"><rect x="${-labelWidth / 2}" y="-17" width="${labelWidth}" height="34" rx="8"/><title>${escapeHtml(edge.label || "")}</title><text text-anchor="middle" dominant-baseline="central">${escapeHtml(displayLabel)}</text></g>`
    : "";
  const targetNote = to.type === "note" ? state.notes.find(note => note.id === Number(to.noteId)) : null;
  const targetTitle = targetNote?.title || to.title || to.text || "Card";
  const actionLabel = `${edge.collapsed ? "Expand" : "Collapse"} connection to ${targetTitle}`;
  const anchor = fromSide === "left" ? "end" : "start";
  const textX = fromSide === "left" ? -20 : 20;
  const collapsedLabel = edge.collapsed ? `<text class="canvas-folded-title" x="${textX}" y="4" text-anchor="${anchor}">${escapeHtml(truncate(targetTitle, 24))}</text>` : "";
  const toggle = `<g class="canvas-connection-toggle ${edge.collapsed ? "is-collapsed" : ""}" data-canvas-collapse-edge="${escapeHtml(edge.id)}" transform="translate(${junction.x} ${junction.y})" role="button" tabindex="0" aria-expanded="${!edge.collapsed}" aria-label="${escapeHtml(actionLabel)}"><title>${escapeHtml(actionLabel)}</title><circle r="13"/><text class="canvas-connection-symbol" text-anchor="middle" dominant-baseline="central">${edge.collapsed ? "+" : "−"}</text>${collapsedLabel}</g>`;
  return `<path class="canvas-edge-hit" data-canvas-edge="${escapeHtml(edge.id)}" d="${path}"/><path class="canvas-edge ${edge.collapsed ? "canvas-edge-folded" : ""}" style="stroke:${escapeHtml(workspaceColor(color))}" ${edge.collapsed ? "" : 'marker-end="url(#canvas-arrow)"'} d="${path}"/>${label}${toggle}`;
}

function canvasDraftEdgeMarkup(connection) {
  if (!connection) return "";
  const from = connection.nodes.find((node) => node.id === connection.fromNode);
  if (!from) return "";
  const target = connection.toNode
    ? connection.nodes.find((node) => node.id === connection.toNode)
    : null;
  const fromPoint = canvasSidePoint(from, connection.fromSide);
  const toPoint = target
    ? canvasSidePoint(target, connection.toSide)
    : { x: connection.x, y: connection.y };
  const toSide = connection.toSide || canvasDraftTargetSide(fromPoint, toPoint);
  const path = canvasEdgePath(fromPoint, connection.fromSide, toPoint, toSide);
  return `<path class="canvas-edge canvas-edge-draft" d="${path}"/>`;
}

export function canvasEditorMarkup(resource, pane = "primary") {
  const tool = (type, icon, label, aria) => `<button data-canvas-add="${type}" title="${aria}" aria-label="${aria}">${interfaceIcon(icon)}<span>${label}</span></button>`;
  return `<section class="canvas-document-pane canvas-studio inspector-closed secondary-resource-pane" data-canvas-path="${escapeHtml(resource.path)}" data-${pane}-path="${escapeHtml(resource.path)}" data-pane-drop="${pane}">
    <div class="canvas-workbench">
      <div class="canvas-board">
        <div class="canvas-resource-picker hidden"><header><strong data-canvas-picker-title>Add to canvas</strong><button data-canvas-picker-close aria-label="Close">×</button></header><nav class="canvas-picker-tabs hidden" aria-label="Note source"><button class="active" data-canvas-picker-view="templates">${interfaceIcon("template")}<span>Templates</span></button><button data-canvas-picker-view="tree">${interfaceIcon("folder")}<span>Tree</span></button></nav><input type="search" data-canvas-picker-search placeholder="Search…"><div data-canvas-picker-results></div></div>
        <div class="canvas-viewport" tabindex="0" aria-label="Canvas workspace; right-drag to pan, left-drag to select, double-click to write, paste images or links">
          <div class="canvas-stage"><svg class="canvas-edges" width="4000" height="2600"><defs><marker id="canvas-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs><g data-canvas-edges></g></svg><div data-canvas-nodes></div></div>
          <div class="canvas-empty-hint"><span class="canvas-welcome-icon">${interfaceIcon("canvas")}</span><strong>A space for your next discovery</strong><ol><li>Add notes, sources and hypotheses below.</li><li>Double-click anywhere to capture an idea.</li><li>Connect your thinking, one branch at a time.</li></ol></div>
        </div>
        <div class="canvas-interaction-hint">Right-drag to pan · Left-drag to select · Ctrl-click to add to the selection · Double-click to write</div>
        <div class="canvas-toolbar" aria-label="Canvas tools">
          ${tool("notes", "note", "Note", "Add a note")}${tool("text", "text", "Text", "Add text")}${tool("drawing", "edit", "Drawing", "Add drawing card")}
          <button data-canvas-upload-image aria-label="Upload image" title="Upload image">${interfaceIcon("image")}<span>Image</span></button><input class="hidden" type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-canvas-image-input>
          ${tool("link", "link", "Link", "Add web link")}${tool("zone", "zone", "Zone", "Add zone")}${tool("collection", "database", "Collection", "Collection")}
          <button data-canvas-group hidden aria-label="Group the selection into a zone" title="Group into a zone (Ctrl+G)">${interfaceIcon("zone")}<span>Group</span></button>
          <button data-canvas-delete-selection hidden aria-label="Remove the selected cards from the canvas" title="Remove the selected cards (Delete)">${interfaceIcon("trash")}<span>Remove</span></button>
          <span class="canvas-toolbar-separator"></span>
          <button class="canvas-save-state" aria-label="Canvas save status; click to retry" title="Saved" aria-live="polite">Saved</button>
          <button data-canvas-inspector-toggle aria-label="Toggle card details" aria-expanded="false" title="Card details">${interfaceIcon("edit")}</button>
        </div>

        <div class="canvas-navigation-dock"><div class="canvas-minimap"><svg data-canvas-minimap role="img" aria-label="Canvas overview; click to navigate"></svg></div><div class="canvas-zoom-tools"><button data-canvas-zoom="out" aria-label="Zoom out">${interfaceIcon("zoomout")}</button><output data-canvas-zoom-label>100 %</output><button data-canvas-zoom="in" aria-label="Zoom in">${interfaceIcon("zoomin")}</button><button data-canvas-zoom="fit" aria-label="Fit canvas" title="Fit canvas">${interfaceIcon("fit")}</button></div></div>
      </div>
      <div class="canvas-inspector-resizer" data-canvas-inspector-resizer role="separator" aria-label="Resize card details" aria-orientation="vertical" tabindex="0" title="Drag to resize · double-click to reset"></div>
      <aside class="canvas-inspector" aria-label="Card details"><div class="canvas-inspector-bar"><strong>Card details</strong><button type="button" data-canvas-inspector-close aria-label="Close card details">×</button></div><div data-canvas-inspector-content><div class="canvas-inspector-empty"><h3>Your thinking, in detail</h3><p>Select a card to edit its title and content.</p></div></div></aside>
    </div>
  </section>`;
}

function canvasPickerItems(type) {
  if (type === "template")
    return state.noteTemplates.filter(template => !template.archived).map((template) => ({
      key: String(template.id),
      title: template.name,
      detail: `Create ${template.title_template}`,
      color: template.color,
      item: { type: "template", templateId: template.id },
    }));
  if (type === "note")
    return state.notes.map((note) => ({
      key: String(note.id),
      title: note.title,
      detail: noteContextLabel(note),
      item: { type: "note", noteId: note.id, title: note.title },
    }));
  if (type === "pdf")
    return state.papers
      .filter((paper) => paper.file_path)
      .map((paper) => ({
        key: `paper:${paper.id}`,
        title: paper.title,
        detail: (paper.authors || []).join(", ") || "Library article",
        item: { type: "library-paper", paperId: paper.id },
      }));
  return canvasWorkspaceResources(type === "pdf" ? ["pdf"] : ["image"]).map(
    (node) => ({
      key: node.path,
      title: node.label || node.name,
      detail: node.path,
      item: { type, path: node.path, url: node.url, paperId: node.paper_id || null, title: node.label || node.name },
    }),
  );
}

export function bindCanvasEditors(root) {
  root?.querySelectorAll("[data-canvas-path]").forEach((container) => {
    if (container.closest('[data-workspace-bound="true"]')) return;
    const path = container.dataset.canvasPath;
    const resource = [state.primaryResource, state.secondaryResource].find(
      (item) => item?.path === path,
    );
    if (!resource) return;
    let content = resource.content && typeof resource.content === "object"
      ? JSON.parse(JSON.stringify(resource.content))
      : { nodes: [], edges: [] };
    content.nodes ||= [];
    content.edges ||= [];
    migrateCanvasBranchFolds(content);
    // Drawings dropped before they had their own card type still show their schema.
    for (const node of content.nodes) {
      const drawingNote = node.type === "note" && node.noteId ? state.notes.find(note => Number(note.id) === Number(node.noteId) && note.drawing) : null;
      if (drawingNote) Object.assign(node, { type: "drawing", drawing: drawingNote.drawing, preview: drawingNote.drawing_preview || drawingPreviewPng(drawingNote.drawing) });
    }
    let zoom = 1;
    let panX = -80;
    let panY = -80;
    let connectionDraft = null;
    let pendingConnection = null;
    let pendingTemplateId = null;
    let pickerType = null;
    let pickerView = "templates";
    const viewport = container.querySelector(".canvas-viewport");
    const stage = container.querySelector(".canvas-stage");
    const nodesLayer = container.querySelector("[data-canvas-nodes]");
    const edgesLayer = container.querySelector("[data-canvas-edges]");
    const emptyHint = container.querySelector(".canvas-empty-hint");
    const picker = container.querySelector(".canvas-resource-picker");
    const pickerSearch = container.querySelector("[data-canvas-picker-search]");
    const pickerResults = container.querySelector("[data-canvas-picker-results]");
    const pickerTitle = container.querySelector("[data-canvas-picker-title]");
    const pickerTabs = container.querySelector(".canvas-picker-tabs");
    const saveState = container.querySelector(".canvas-save-state");
    const imageInput = container.querySelector("[data-canvas-image-input]");
    const inspector = container.querySelector("[data-canvas-inspector-content]") as HTMLElement;
    const workbench = container.querySelector(".canvas-workbench") as HTMLElement;
    const resizeHandle = container.querySelector("[data-canvas-inspector-resizer]") as HTMLElement;
    const sidebarToggle = container.querySelector("[data-canvas-inspector-toggle]") as HTMLButtonElement;
    const storedWidth = Number(localStorage.getItem("kavot-canvas-inspector-width"));
    let preferredWidth = Number.isFinite(storedWidth) && storedWidth > 0 ? storedWidth : 380;
    const resizeBounds = () => {
      const max = Math.min(720, workbench.clientWidth - Math.min(180, workbench.clientWidth * .35));
      return { min: Math.min(280, max), max };
    };
    const setInspectorWidth = (width: number, persist = false) => {
      const { min, max } = resizeBounds();
      const actual = Math.round(Math.max(min, Math.min(max, width)));
      container.style.setProperty("--canvas-inspector-width", `${actual}px`);
      resizeHandle.setAttribute("aria-valuemin", String(Math.round(min)));
      resizeHandle.setAttribute("aria-valuemax", String(Math.round(max)));
      resizeHandle.setAttribute("aria-valuenow", String(actual));
      if (persist) { preferredWidth = actual; localStorage.setItem("kavot-canvas-inspector-width", String(actual)); }
      return actual;
    };
    setInspectorWidth(preferredWidth);
    const openInspector = () => {
      container.classList.remove("inspector-closed"); sidebarToggle.setAttribute("aria-expanded", "true");
      setInspectorWidth(preferredWidth); renderMinimap();
    };
    const closeInspector = async () => {
      try {
        await flushCanvasSaves();
        container.classList.add("inspector-closed"); sidebarToggle.setAttribute("aria-expanded", "false");
        sidebarToggle.focus({ preventScroll: true }); renderMinimap();
      } catch { inspector.querySelector<HTMLElement>("[data-detail-save-state]")?.focus(); }
    };
    sidebarToggle.addEventListener("click", () => container.classList.contains("inspector-closed") ? openInspector() : closeInspector());
    container.addEventListener("click", event => { if ((event.target as HTMLElement).closest("[data-canvas-inspector-close]")) void closeInspector(); });
    resizeHandle.addEventListener("focus", () => setInspectorWidth(preferredWidth));
    resizeHandle.addEventListener("dblclick", () => { setInspectorWidth(380, true); renderMinimap(); });
    resizeHandle.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const { min, max } = resizeBounds();
      const current = Number(resizeHandle.getAttribute("aria-valuenow"));
      setInspectorWidth(event.key === "Home" ? min : event.key === "End" ? max : current + (event.key === "ArrowLeft" ? 1 : -1) * (event.shiftKey ? 50 : 20), true);
      renderMinimap();
    });
    resizeHandle.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault(); resizeHandle.focus({ preventScroll: true }); resizeHandle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startWidth = (container.querySelector(".canvas-inspector") as HTMLElement).getBoundingClientRect().width;
      container.classList.add("inspector-resizing");
      const move = (next: PointerEvent) => { setInspectorWidth(startWidth + startX - next.clientX, true); renderMinimap(); };
      const finish = () => {
        container.classList.remove("inspector-resizing");
        resizeHandle.removeEventListener("pointermove", move);
        resizeHandle.removeEventListener("pointerup", finish);
        resizeHandle.removeEventListener("pointercancel", finish);
        if (resizeHandle.hasPointerCapture(event.pointerId)) resizeHandle.releasePointerCapture(event.pointerId);
      };
      resizeHandle.addEventListener("pointermove", move);
      resizeHandle.addEventListener("pointerup", finish);
      resizeHandle.addEventListener("pointercancel", finish);
    });
    const inspectorDrafts = new Map();
    let selectedNodeId = null;
    let selectedEdgeId = null;
    registerAgentContext(container, () => {
      const selected = content.nodes.find(node => node.id === selectedNodeId);
      return { area: 'canvas', canvas_path: path, selected_node_id: selectedNodeId,
        selected_node_title: selected?.title, selected_edge_id: selectedEdgeId,
        note_id: selected?.type === 'note' ? Number(selected.noteId) || null : null };
    });
    let syncingCanvasText = false;
    let lastDragEndedAt = 0;
    // Cards picked with Ctrl-click or the selection rectangle; they move together.
    const selectedIds = new Set<string>();
    const groupButton = container.querySelector("[data-canvas-group]") as HTMLButtonElement;
    const deleteSelectionButton = container.querySelector("[data-canvas-delete-selection]") as HTMLButtonElement;
    const groupable = () => content.nodes.filter(node => selectedIds.has(node.id) && node.type !== "project");
    const removable = (node) => !canvasNodeProtected(node, content.projectId);
    const paintSelection = () => {
      nodesLayer.querySelectorAll("[data-canvas-node]").forEach((element: HTMLElement) =>
        element.classList.toggle("is-selected", element.dataset.canvasNode === selectedNodeId || selectedIds.has(element.dataset.canvasNode)));
      groupButton.hidden = groupable().length < 2;
      const removableCount = content.nodes.filter(node => selectedIds.has(node.id) && removable(node)).length;
      deleteSelectionButton.hidden = removableCount < 2;
      deleteSelectionButton.querySelector("span").textContent = `Remove ${removableCount} cards`;
    };
    const removeNodes = (ids: string[]) => {
      const removed = new Set<string>(content.nodes.filter(node => ids.includes(node.id) && removable(node)).map(node => node.id));
      if (!removed.size) return;
      content.nodes = content.nodes.filter(node => !removed.has(node.id));
      // A link may point to a card of a removed frame (`<frame id>~<card id>`).
      const gone = (end: string) => removed.has(end) || removed.has(String(end).split("~")[0]);
      content.edges = content.edges.filter(edge => !gone(edge.fromNode) && !gone(edge.toNode));
      for (const id of removed) {
        inspectorDrafts.delete(id);
        const pendingDetails = canvasDetailSaves.get(`${path}:${id}`);
        if (pendingDetails) { clearTimeout(pendingDetails.timer); canvasDetailSaves.delete(`${path}:${id}`); }
        selectedIds.delete(id);
      }
      if (removed.has(selectedNodeId)) showCanvasOverview();
      if (removed.has(connectionDraft?.fromNode) || removed.has(connectionDraft?.toNode)) connectionDraft = null;
      renderNodes();
      queueSave();
    };
    deleteSelectionButton.addEventListener("click", () => removeNodes([...selectedIds]));
    // Wrap the selected cards in a new zone drawn behind them; the zone then carries them when moved.
    const groupSelection = () => {
      const members = groupable();
      if (members.length < 2) return;
      const boxes = members.map(node => {
        const size = canvasNodeSize(node);
        node.width = size.width; node.height = size.height;
        return { x: Number(node.x) || 0, y: Number(node.y) || 0, right: (Number(node.x) || 0) + size.width, bottom: (Number(node.y) || 0) + size.height };
      });
      const left = Math.min(...boxes.map(box => box.x)) - 40, top = Math.min(...boxes.map(box => box.y)) - 80;
      const zone = { id: canvasUid("zone"), type: "zone", title: "New zone", description: "", tone: "teal",
        x: left, y: top, width: Math.max(...boxes.map(box => box.right)) + 40 - left, height: Math.max(...boxes.map(box => box.bottom)) + 40 - top };
      content.nodes.unshift(zone);
      selectedIds.clear(); selectedIds.add(zone.id);
      renderNodes(); queueSave();
      const title = nodesLayer.querySelector(`[data-canvas-zone-title="${CSS.escape(zone.id)}"]`) as HTMLInputElement | null;
      title?.focus(); title?.select();
    };
    groupButton.addEventListener("click", groupSelection);
    viewport.addEventListener("keydown", event => {
      if ((event.target as HTMLElement).closest("input, textarea, [contenteditable='true']")) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "g") {
        event.preventDefault(); groupSelection();
      }
      if (event.key === "Delete" && (selectedIds.size || selectedNodeId)) {
        event.preventDefault(); removeNodes(selectedIds.size ? [...selectedIds] : [selectedNodeId]);
      }
    });
    const minimap = container.querySelector("[data-canvas-minimap]");
    const renderMinimap = () => {
      const nodes = allNodes();
      if (!nodes.length) { minimap.innerHTML = ""; return; }
      const minX = Math.min(...nodes.map(node => Number(node.x) || 0)) - 80;
      const minY = Math.min(...nodes.map(node => Number(node.y) || 0)) - 80;
      const maxX = Math.max(...nodes.map(node => (Number(node.x) || 0) + canvasNodeSize(node).width)) + 80;
      const maxY = Math.max(...nodes.map(node => (Number(node.y) || 0) + canvasNodeSize(node).height)) + 80;
      minimap.setAttribute("viewBox", `${minX} ${minY} ${Math.max(1, maxX - minX)} ${Math.max(1, maxY - minY)}`);
      minimap.innerHTML = nodes.map(node => `<rect x="${Number(node.x) || 0}" y="${Number(node.y) || 0}" width="${canvasNodeSize(node).width}" height="${canvasNodeSize(node).height}" rx="12" class="${node.type === "zone" ? "minimap-zone" : "minimap-card"} ${node.id === selectedNodeId ? "minimap-selected" : ""}"/>`).join("") + `<rect class="minimap-viewport" x="${-panX / zoom}" y="${-panY / zoom}" width="${viewport.clientWidth / zoom}" height="${viewport.clientHeight / zoom}"/>`;
    };
    minimap.addEventListener("click", event => {
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(minimap.getScreenCTM().inverse());
      panX = viewport.clientWidth / 2 - point.x * zoom;
      panY = viewport.clientHeight / 2 - point.y * zoom;
      applyTransform();
    });
    const applyTransform = () => {
      viewport.scrollLeft = 0; viewport.scrollTop = 0;
      stage.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
      // Zoomed out, card bodies are unreadable: cards show only a large title instead.
      container.classList.toggle("canvas-overview", zoom < CANVAS_OVERVIEW_ZOOM);
      container.style.setProperty("--canvas-inverse-zoom", String(1 / zoom));
      container.querySelector("[data-canvas-zoom-label]").textContent = `${Math.round(zoom * 100)} %`;
      renderMinimap();
    };
    const visibleNodes = () => {
      const hidden = canvasHiddenNodes(content.nodes, content.edges);
      return content.nodes.filter(node => !hidden.has(node.id));
    };
    // Cards of the canvases shown here: drawn and linkable like this canvas's own, but never saved in it.
    let mirrors = { nodes: [], edges: [] };
    const computeMirrors = () => {
      const nodes = [], edges = [];
      for (const embed of visibleNodes().filter(node => node.type === "canvas")) {
        const mirror = canvasEmbedMirror(embed);
        // The frame grows with its source.
        embed.width = mirror.nodes.length ? Math.max(...mirror.nodes.map(item => item.x + item.width)) + EMBED_PADDING - (Number(embed.x) || 0) : 420;
        embed.height = mirror.nodes.length ? Math.max(...mirror.nodes.map(item => item.y + item.height)) + EMBED_PADDING - (Number(embed.y) || 0) : 200;
        nodes.push(...mirror.nodes);
        edges.push(...mirror.edges);
      }
      mirrors = { nodes, edges };
    };
    const allNodes = () => [...visibleNodes(), ...mirrors.nodes];
    const renderEdges = () => {
      const nodes = allNodes();
      const byId = new Map(nodes.map(node => [node.id, node]));
      for (const edge of content.edges) {
        const from = byId.get(edge.fromNode);
        const to = byId.get(edge.toNode);
        if (from && to) Object.assign(edge, canvasDefaultEdgeSides(from, to));
      }
      const hidden = canvasHiddenNodes(content.nodes, content.edges);
      const own = content.edges.filter(edge => !hidden.has(edge.fromNode) && (edge.collapsed || !hidden.has(edge.toNode)));
      const edges = [...own, ...mirrors.edges];
      edgesLayer.innerHTML = own.map((edge) => canvasEdgeMarkup(edge, nodes, edges)).join("") +
        mirrors.edges.map(edge => `<g class="canvas-edge-mirrored">${canvasEdgeMarkup(edge, nodes, edges)}</g>`).join("") +
        canvasDraftEdgeMarkup(connectionDraft);
      renderMinimap();
    };
    const queueSave = () => {
      // Snapshot immediately: tab changes and slow requests must not lose newer edits.
      const snapshot = JSON.parse(JSON.stringify(content));
      resource.content = snapshot;
      window.dispatchEvent(new CustomEvent("kavot:canvas-changed", { detail: { path } }));
      saveState.textContent = "Unsaved changes…";
      saveState.dataset.saveStatus = "pending";
      const previous = canvasSaveTimers.get(path);
      if (previous) clearTimeout(previous.timer);
      const entry = { timer: null, save: null, request: null };
      const save = () => {
        if (entry.request) return entry.request;
        saveState.textContent = "Saving…";
        saveState.dataset.saveStatus = "pending";
        const request = (canvasSaveRequests.get(path) || Promise.resolve()).catch(() => {}).then(async () => {
          try {
            await api("/workspace/canvas", { method: "PUT", body: JSON.stringify({ path, content: snapshot }) });
            void refreshRelationalNotes();
            if (canvasSaveTimers.get(path) === entry) {
              canvasSaveTimers.delete(path);
              saveState.textContent = "Saved";
              saveState.dataset.saveStatus = "saved";
            }
          } catch (error) {
            if (canvasSaveTimers.get(path) === entry) { saveState.textContent = "Save failed · retry"; saveState.dataset.saveStatus = "error"; }
            toast(error.message, "error");
            throw error;
          }
        });
        canvasSaveRequests.set(path, request);
        entry.request = request;
        request.finally(() => {
          entry.request = null;
          if (canvasSaveRequests.get(path) === request) canvasSaveRequests.delete(path);
        }).catch(() => {});
        return request;
      };
      entry.save = save;
      entry.timer = setTimeout(() => { save().catch(() => {}); }, 550);
      canvasSaveTimers.set(path, entry);
    };
    new MutationObserver(() => { saveState.title = saveState.textContent; }).observe(saveState, { childList: true });
    saveState.addEventListener("click", () => {
      const pending = canvasSaveTimers.get(path);
      if (pending) { clearTimeout(pending.timer); pending.save().catch(() => {}); }
    });
    // Redraw when a shown canvas changes, unless someone is typing or dragging here: then on the next poll.
    let embedRefreshPending = false;
    const refreshCanvasEmbeds = () => {
      if (!container.isConnected) return;
      const active = document.activeElement as HTMLElement | null;
      if (active && nodesLayer.contains(active) && active.matches("input, textarea, [contenteditable='true']") ||
        nodesLayer.classList.contains("is-dragging-nodes") || connectionDraft) { embedRefreshPending = true; return; }
      embedRefreshPending = false;
      renderNodes();
    };
    const embeddedCanvasPaths = (): string[] => [...new Set<string>(visibleNodes().filter(node => node.type === "canvas").map(canvasEmbedPath).filter(Boolean))];
    const renderNodes = () => {
      nodesLayer.querySelectorAll("[data-canvas-note-sheet]").forEach(sheet => noteSheetObserver?.unobserve(sheet));
      computeMirrors();
      nodesLayer.innerHTML = allNodes()
        .map((node) => canvasNodeMarkup(node, content.projectId))
        .join("");
      renderPdfPreviews(nodesLayer);
      fitNoteSheets(nodesLayer);
      for (const sourcePath of embeddedCanvasPaths()) {
        if (!canvasEmbedSource(sourcePath)) void loadCanvasEmbed(sourcePath).then(changed => { if (changed) refreshCanvasEmbeds(); });
      }
      paintSelection();
      const tasks = state.tasks.filter(task => Number(task.project_id) === Number(content.projectId) && content.projectId);
      const tasksDone = tasks.filter(task => task.status === "done").length;
      const hidden = content.nodes.length - visibleNodes().length;
      const summary = container.querySelector("[data-canvas-summary]");
      if (summary) summary.innerHTML = `<span>${content.nodes.filter(node => !["project", "zone"].includes(node.type)).length} cards${hidden ? ` · ${hidden} hidden` : ""}</span>${tasks.length ? `<span>${tasksDone}/${tasks.length} project tasks done</span>` : ""}`;
      const hasUserContent = content.nodes.some(
        (node) => node.type !== "project" && node.id !== "project-root",
      );
      const hasProjectRoot = content.nodes.some(
        (node) => node.type === "project" || node.id === "project-root",
      );
      emptyHint.classList.toggle("with-project-root", hasProjectRoot);
      emptyHint.classList.toggle("hidden", hasUserContent);
      renderEdges();
      for (const node of allNodes().filter(node => node.type === "link")) {
        const url = canvasWebUrl(node.url || "");
        if (!url || webPreviews.has(url)) continue;
        loadWebPreview(url).then(() => {
          if (node.url !== url || !container.isConnected) return;
          for (const preview of [...(container as HTMLElement).querySelectorAll<HTMLElement>("[data-web-preview]"), ...inspector.querySelectorAll<HTMLElement>("[data-web-preview]")]) {
            if (preview.dataset.webPreview === url) preview.outerHTML = canvasNodePreview(node);
          }
        });
      }
    };
    const addNode = (item, point = null) => {
      // A dropped or picked note that holds a drawing becomes a drawing card showing the schema.
      const drawingNote = item.type === "note" && item.noteId ? state.notes.find(note => Number(note.id) === Number(item.noteId) && note.drawing) : null;
      if (drawingNote) item = { ...item, type: "drawing", title: drawingNote.title || item.title, drawing: drawingNote.drawing, preview: drawingNote.drawing_preview || drawingPreviewPng(drawingNote.drawing) };
      const defaultWidth = item.type === "canvas" ? 760 : item.type === "zone" ? 620 : ["articles", "collection"].includes(item.type) ? 560 : item.type === "image" ? 380 : item.type === "shape" ? 210 : item.type === "text" ? 300 : 360;
      const defaultHeight = item.type === "canvas" ? 520 : item.type === "zone" ? 380 : ["articles", "collection"].includes(item.type) ? 360 : ["pdf", "link"].includes(item.type) ? 360 : item.type === "shape" ? 135 : item.type === "text" ? 160 : 240;
      const slot = content.nodes.length % 9;
      const column = slot % 3;
      const row = Math.floor(slot / 3);
      const centerX = (-panX + viewport.clientWidth / 2) / zoom;
      const centerY = (-panY + viewport.clientHeight / 2) / zoom;
      const columnOffset = item.type === "zone"
        ? 0
        : (column - 1) * (Math.min(defaultWidth, 260) + 32);
      const rowOffset = item.type === "zone"
        ? 0
        : (row - 1) * (Math.min(defaultHeight, 160) + 32);
      const created = {
        id: canvasUid(item.type),
        ...item,
        x: Math.round(point?.x != null
          ? point.x - defaultWidth / 2
          : centerX - defaultWidth / 2 + columnOffset),
        y: Math.round(point?.y != null
          ? point.y - defaultHeight / 2
          : centerY - defaultHeight / 2 + rowOffset),
        width: defaultWidth,
        height: defaultHeight,
      };
      content.nodes.push(created);
      renderNodes();
      queueSave();
      return created;
    };
    const focusCardText = (node) => {
      const card = [...(nodesLayer as HTMLElement).querySelectorAll<HTMLElement>("[data-canvas-node]")].find(element => element.dataset.canvasNode === node.id);
      card?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    };
    const editCardDetails = (node, isNewLink = false, focusWriting = false) => {
      if (node.type === "text" && !node.title) node.title = "Text";
      if (node.type === "project") {
        void (async () => {
          await flushSecondaryNoteAutosave();
          await flushWorkspaceMarkdownSaves();
          await flushCanvasSaves();
          const project = state.projects.find(item => item.id === Number(node.projectId));
          if (!project) return;
          // The project card opens that project's canvas, or its settings when already there.
          if (project.canvas_path === state.primaryResource?.path) {
            const { editProjectModal } = await import("../projects/dialogs");
            editProjectModal(project.id);
          } else {
            const { openProjectArea } = await import("../projects/navigation");
            await openProjectArea(project.id, "canvas");
          }
        })().catch(error => toast(error.message, "error"));
        return;
      }
      if (node.collectionType && node.recordId != null) {
        void openItemInSheet({ type: node.collectionType, id: node.recordId, databaseId: node.databaseId }, () => {
          const item = findCollectionItem({ type: node.collectionType, id: node.recordId, databaseId: node.databaseId });
          if (item) { Object.assign(node, collectionItemCanvasPayload(item)); renderNodes(); queueSave(); }
        });
        return;
      }
      if (node.type === "drawing") {
        try {
          openDrawingEditor(node.title || "Drawing", node.drawing || emptyDrawing(), (title, drawing, preview) => {
            Object.assign(node, { title, drawing, preview });
            const drawingNote = node.noteId
              ? state.notes.find((item) => Number(item.id) === Number(node.noteId))
              : null;
            if (drawingNote) Object.assign(drawingNote, { title, drawing, drawing_preview: preview });
            renderNodes(); queueSave();
          }, async () => {
            const drawingNote = node.noteId
              ? state.notes.find((item) => Number(item.id) === Number(node.noteId))
              : null;
            if (drawingNote) {
              const saved = await api<Note>(`/notes/${drawingNote.id}`, {
                method: "PATCH",
                body: JSON.stringify({ title: node.title, drawing: node.drawing, drawing_preview: node.preview }),
              });
              Object.assign(drawingNote, saved);
              await refreshWorkspaceTreeOnly();
            }
            const pending = canvasSaveTimers.get(path);
            if (pending) { clearTimeout(pending.timer); await pending.save(); }
          });
        } catch (error) { toast(error.message, "error"); }
        return;
      }
      // Resource cards and note cards share the same HTML document.
      const linkedNoteId = node.noteId || node.note_id || node.ocrNoteId;
      const note = state.notes.find(item => item.id === Number(linkedNoteId) && !item.trashed_at);
      if (note && node.noteId !== note.id) { node.noteId = note.id; queueSave(); }
      const detailKey = `${path}:${node.id}`;
      const draft = inspectorDrafts.get(node.id);
      const noteEditor = !isNewLink ? `<section class="canvas-inspector-writing" aria-label="Write card notes">${noteReferencePickerMarkup()}${markdownBlockEditorMarkup(draft?.content ?? note?.content ?? (node.type === "text" ? node.text : node.cardNotes) ?? "", { sourceId: "canvas-inspector-source", editorId: "canvas-inspector-editor", assetBase: note ? noteAssetBase(note) : "", ariaLabel: "Contenu HTML de la note" })}</section>` : "";
      const panelTag = isNewLink ? "form" : "section";
      const markup = `<${panelTag} id="${isNewLink ? "canvas-new-link-form" : "canvas-details-form"}" class="form-grid"><header class="canvas-inspector-bar"><label class="form-field full canvas-detail-title"><span class="sr-only">Title</span><input aria-label="Title" name="title" required maxlength="240" value="${escapeHtml(draft?.title ?? note?.title ?? node.title ?? "")}"></label><button type="button" data-canvas-inspector-close aria-label="Close card details">×</button></header>${isNewLink ? "<h2>Add web link</h2>" : '<button type="button" class="canvas-detail-save-state" data-detail-save-state hidden aria-live="polite">Saved automatically</button>'}${node.type === "link" ? `<label class="form-field full">Web address<input name="url" type="url" required placeholder="https://…" value="${escapeHtml(node.url || "")}"></label>` : ""}${node.type === "image" ? `<img class="canvas-inspector-image" src="${escapeHtml(node.url || "")}" alt="${escapeHtml(node.title || "Image")}">` : node.type === "link" && !isNewLink ? canvasNodePreview(node) : ""}${node.collectionType ? `<button type="button" class="button button-small" data-card-open-resource>Edit ${escapeHtml(node.collectionType)} record ↗</button>` : ""}${node.type === "text" ? canvasTextControls(node) : ""}${noteEditor}${isNewLink ? '<div class="form-actions"><button class="button button-primary">Add link</button></div>' : ""}</${panelTag}>`;
      inspector.innerHTML = markup;
      if (!isNewLink) {
        inspector.querySelector('.canvas-inspector-bar').insertAdjacentHTML('beforeend', '<button type="button" data-agent-card-menu aria-label="Assistant for this card" title="Assistant for this card">✦</button>');
        inspector.querySelector<HTMLElement>('[data-agent-card-menu]').addEventListener('click', event => {
          const button = event.currentTarget as HTMLElement;
          const rect = button.getBoundingClientRect();
          showContextMenu(suggestions.canvas.map(text => ({ label: text, run: () => suggestToAgent(text) })), rect.left, rect.bottom, button, 'Assistant for this card');
        });
      }
      inspector.parentElement.scrollTop = 0;
      openInspector();
      if (!isNewLink) {
        selectedNodeId = node.id;
        selectedEdgeId = null;
        selectedIds.clear(); selectedIds.add(node.id);
        paintSelection();
        renderMinimap();
      }
      const form = inspector.querySelector<HTMLElement>(isNewLink ? "#canvas-new-link-form" : "#canvas-details-form");
      const status = isNewLink ? null : inspector.querySelector("[data-detail-save-state]");
      const showStatus = (message, error = false) => {
        if (selectedNodeId !== node.id) return;
        const currentStatus = inspector.querySelector<HTMLElement>("[data-detail-save-state]");
        if (!currentStatus) return;
        currentStatus.textContent = message;
        currentStatus.hidden = !error;
        currentStatus.classList.toggle("has-error", error);
      };
      if (!isNewLink && draft) for (const [name, value] of Object.entries(draft)) {
        const input = form.querySelector<HTMLInputElement>(`[name="${CSS.escape(name)}"]`);
        if (input) input.value = String(value);
      }
      let source: HTMLTextAreaElement | null = null;
      let editorRoot: HTMLElement | null = null;
      if (!isNewLink) {
        source = form.querySelector("#canvas-inspector-source");
        source.name = "content";
        editorRoot = form.querySelector("#canvas-inspector-editor");
        if (note) editorRoot.dataset.agentNoteId = String(note.id);
        bindMarkdownBlockEditor(editorRoot, source);
        bindNoteReferences(form, editorRoot, note?.id);
      }
      let savedTitle = note?.title || node.title;
      const values = () => Object.fromEntries(
        [...form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[name]')]
          .filter(input => !input.disabled && !input.closest('dialog') && (!(input instanceof HTMLInputElement) || !['checkbox', 'radio'].includes(input.type) || input.checked))
          .map(input => [input.name, input.value]),
      ) as Record<string, string>;
      const applyValues = (data) => {
        const title = String(data.title || "").trim();
        if (!title) throw new Error("Enter a title to save your changes");
        const url = node.type === "link" ? canvasWebUrl(String(data.url || "")) : null;
        if (node.type === "link" && !url) throw new Error("Enter an http or https web address");
        node.title = title;
        if (url) {
          node.url = url;
          const preview = form.querySelector<HTMLElement>("[data-web-preview]");
          if (preview && preview.dataset.webPreview !== url) preview.outerHTML = canvasNodePreview(node);
        }
        if (note) { note.title = title; note.content = data.content ?? note.content; }
        else if (node.type === "text") {
          node.text = data.content ?? node.text;
          node.textStyle = { fontSize: Math.max(10, Math.min(96, Number(data.textSize) || 18)),
            color: data.textColor, background: data.textBackground, align: data.textAlign,
            shape: data.textShape, bold: data.textBold === "on", italic: data.textItalic === "on" };
        }
        else if (!isNewLink) node.cardNotes = data.content ?? node.cardNotes;
        if (!isNewLink) {
          renderNodes();
          resource.content = JSON.parse(JSON.stringify(content));
        }
      };
      const schedule = () => {
        const data = values();
        inspectorDrafts.set(node.id, data);
        try { applyValues(data); showStatus("Saving…"); }
        catch (error) { showStatus(error.message, true); }
        const previous = canvasDetailSaves.get(detailKey);
        if (previous) clearTimeout(previous.timer);
        let request: Promise<void> | null = null;
        const entry = { timer: null, save: null, failed: false };
        const save = () => {
          if (request) return request;
          entry.failed = false;
          showStatus("Saving…");
          const entityKey = note ? `note:${note.id}` : detailKey;
          request = (canvasDetailRequests.get(entityKey) || Promise.resolve()).catch(() => {}).then(async () => {
            const title = String(data.title || "").trim();
            if (!title || (node.type === "link" && !canvasWebUrl(String(data.url || "")))) throw new Error(!title ? "Enter a title to save your changes" : "Enter an http or https web address");
            if (!content.nodes.includes(node)) return;
            if (note) {
              const saved = await api<Note>(`/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ title, content: data.content }) });
              // A late response must never replace newer text or reset the cursor.
              if (canvasDetailSaves.get(detailKey) === entry) Object.assign(note, saved);
              if (savedTitle !== title) { savedTitle = title; await refreshWorkspaceTreeOnly(); }
            }
            if (node.type === "project") {
              const updated = await api(`/projects/${node.projectId}`, { method: "PATCH", body: JSON.stringify({ name: title }) });
              Object.assign(state.projects.find(item => item.id === Number(node.projectId)), updated);
              if (canvasDetailSaves.get(detailKey) === entry) {
                content.title = title;
                const heading = container.querySelector(".canvas-workspace-heading strong");
                if (heading) heading.textContent = title;
              }
            }
            if (canvasDetailSaves.get(detailKey) === entry) {
              queueSave();
              const pending = canvasSaveTimers.get(path);
              if (pending) { clearTimeout(pending.timer); await pending.save(); }
              if (canvasDetailSaves.get(detailKey) === entry) {
                canvasDetailSaves.delete(detailKey); inspectorDrafts.delete(node.id);
                showStatus("Saved automatically");
              }
            }
          }).catch(error => {
            entry.failed = true;
            if (canvasDetailSaves.get(detailKey) === entry) showStatus("Save failed · click to retry", true);
            throw error;
          }).finally(() => {
            if (canvasDetailRequests.get(entityKey) === request) canvasDetailRequests.delete(entityKey);
            request = null;
          });
          canvasDetailRequests.set(entityKey, request);
          return request;
        };
        entry.save = save;
        entry.timer = setTimeout(() => { save().catch(() => {}); }, 500);
        canvasDetailSaves.set(detailKey, entry);
      };
      if (!isNewLink) {
        if (canvasDetailSaves.has(detailKey)) showStatus(canvasDetailSaves.get(detailKey).failed ? "Save failed · click to retry" : "Saving…", Boolean(canvasDetailSaves.get(detailKey).failed));
        form.addEventListener("input", event => { if (!syncingCanvasText && (event.target as HTMLInputElement).name && !(event.target as HTMLElement).closest("dialog")) schedule(); });
        status.addEventListener("click", () => {
          const pending = canvasDetailSaves.get(detailKey);
          if (pending) { clearTimeout(pending.timer); pending.save().then(() => showStatus("Saved automatically")).catch(() => showStatus("Save failed · click to retry", true)); }
        });
      }
      form.addEventListener("submit", event => {
        if (!isNewLink) return;
        event.preventDefault();
        try { applyValues(values()); const created = addNode(node); editCardDetails(created); }
        catch (error) { toast(error.message, "error"); }
      });
      if (!isNewLink) {
        form.querySelector("[data-card-open-resource]")?.addEventListener("click", async () => {
          try { await flushCanvasSaves(); } catch { showStatus("Save failed · click to retry", true); return; }
          const onSaved = async () => { const item = findCollectionItem({ type: node.collectionType, id: node.recordId, databaseId: node.databaseId }); if (item) Object.assign(node, collectionItemCanvasPayload(item)); renderNodes(); queueSave(); editCardDetails(node); };
          void openItemInSheet({ type: node.collectionType, id: node.recordId, databaseId: node.databaseId }, onSaved);
        });
      }
      if (focusWriting && editorRoot) setTimeout(() => currentMarkdownBlockInput(editorRoot, true)?.focus(), 30);
      else if (isNewLink) form.querySelector<HTMLInputElement>("input").focus();
    };
    const showCanvasOverview = () => {
      selectedNodeId = null;
      selectedIds.clear();
      selectedEdgeId = null;
      inspector.innerHTML = '<div class="canvas-inspector-empty"><h3>Card details</h3><p>Select a card to edit its title and content.</p></div>';
    };
    container.querySelector(".canvas-viewport").addEventListener("click", event => {
      const badge = (event.target as HTMLElement).closest<HTMLElement>("[data-canvas-edit-template]");
      if (!badge) return;
      event.preventDefault(); event.stopImmediatePropagation();
      templateEditorModal(Number(badge.dataset.canvasEditTemplate));
    }, true);
    viewport.addEventListener("dblclick", event => {
      if (event.target.closest("[data-canvas-node], [data-canvas-edge], [data-canvas-collapse-edge]")) return;
      event.preventDefault();
      focusCardText(addNode({ type: "text", title: "Idea", text: "" }, canvasDropPoint(event)));
    });
    const createTemplateCard = async (templateId, point = null, paperId = null) => {
      const template = state.noteTemplates.find((item) => item.id === Number(templateId));
      if (!template) throw new Error("Card template not found");
      const projectId = Number(content.projectId || 0) || null;
      const existingPaperNote = paperId
        ? state.notes.find((item) => Number(item.paper_id) === Number(paperId))
        : null;
      if (existingPaperNote) {
        return addNode({ type: "note", noteId: existingPaperNote.id, templateId: template.id, title: existingPaperNote.title, color: template.color }, point);
      }
      const note = await api("/notes", {
        method: "POST",
        body: JSON.stringify({
          project_id: paperId ? null : projectId,
          paper_id: Number(paperId) || null,
          folder_id: null,
          template_id: template.id,
          template_context_project_id: projectId,
          title: template.name,
        }),
      });
      await refreshData();
      const created = addNode({
        type: "note",
        noteId: note.id,
        templateId: template.id,
        title: note.title,
        color: template.color,
      }, point);
      await refreshWorkspaceTreeOnly();
      toast(`${template.name} card created`);
      return created;
    };
    const createCanvasNote = async (point = null, openEditor = true) => {
      const projectId = Number(content.projectId || 0) || null;
      const title = "Note";
      const note = await api<Note>("/notes", {
        method: "POST",
        body: JSON.stringify({
          project_id: projectId,
          paper_id: null,
          folder_id: null,
          title,
          content: `# ${title}\n\n`,
        }),
      });
      await refreshData();
      const created = addNode({ type: "note", noteId: note.id, title: note.title, color: "#087e86" }, point);
      await refreshWorkspaceTreeOnly();
      if (openEditor) editCardDetails(created, false, true);
      return created;
    };
    const createCanvasDrawing = async () => {
      const projectId = Number(content.projectId || 0) || null;
      const siblings = state.notes.filter(
        (note) => (note.project_id || null) === projectId && !note.paper_id,
      );
      let title = "Drawing";
      let suffix = 2;
      while (siblings.some((note) => note.title.toLocaleLowerCase() === title.toLocaleLowerCase())) {
        title = `Drawing ${suffix}`;
        suffix += 1;
      }
      const drawing = emptyDrawing();
      const preview = drawingPreviewPng(drawing);
      const note = await api<Note>("/notes", {
        method: "POST",
        body: JSON.stringify({
          project_id: projectId,
          paper_id: null,
          folder_id: null,
          title,
          content: "",
          drawing,
          drawing_preview: preview,
        }),
      });
      await refreshData();
      const created = addNode({ type: "drawing", noteId: note.id, title: note.title, drawing, preview });
      await refreshWorkspaceTreeOnly();
      editCardDetails(created);
      return created;
    };
    const setZoom = (nextZoom: number, clientX?: number, clientY?: number) => {
      const rect = viewport.getBoundingClientRect();
      const anchorX = (clientX ?? rect.left + rect.width / 2) - rect.left;
      const anchorY = (clientY ?? rect.top + rect.height / 2) - rect.top;
      const worldX = (anchorX - panX) / zoom;
      const worldY = (anchorY - panY) / zoom;
      zoom = Math.max(0.08, Math.min(2, nextZoom));
      panX = anchorX - worldX * zoom;
      panY = anchorY - worldY * zoom;
      applyTransform();
    };
    const fitCanvas = () => {
      if (!content.nodes.length) {
        zoom = 1;
        panX = -80;
        panY = -80;
        return applyTransform();
      }
      const bounds = allNodes().reduce((result, node) => {
        const size = canvasNodeSize(node);
        const x = Number(node.x) || 0;
        const y = Number(node.y) || 0;
        result.minX = Math.min(result.minX, x);
        result.minY = Math.min(result.minY, y);
        result.maxX = Math.max(result.maxX, x + size.width);
        result.maxY = Math.max(result.maxY, y + size.height);
        return result;
      }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
      const width = Math.max(1, bounds.maxX - bounds.minX);
      const height = Math.max(1, bounds.maxY - bounds.minY);
      zoom = Math.max(0.08, Math.min(1.15,
        (viewport.clientWidth - 120) / width,
        (viewport.clientHeight - 140) / height,
      ));
      panX = viewport.clientWidth / 2 - (bounds.minX + width / 2) * zoom;
      panY = viewport.clientHeight / 2 - (bounds.minY + height / 2) * zoom;
      applyTransform();
    };
    const itemOnCanvas = (item, representation = "record") => {
      if (item.type === "note" || item.type === "paper") {
        const noteId = item.type === "note" ? item.id : state.notes.find(note => Number(note.paper_id) === Number(item.id))?.id;
        return content.nodes.find(node => node.type === "note" && Number(node.noteId) === Number(noteId));
      }
      return content.nodes.find(node => {
        if (item.type === "paper") return (node.collectionType === "paper" || ["paper", "pdf"].includes(node.type)) && String(node.recordId || node.paperId) === String(item.id) && (representation === "pdf" ? node.type === "pdf" : node.type === "paper");
        return (node.collectionType || node.type) === item.type && String(node.recordId) === String(item.id) && String(node.databaseId || item.databaseId) === String(item.databaseId);
      });
    };
    const importResource = async (item, point = null, representation = "record") => {
      if (!item) throw new Error("Resource not found");
      if (item.type === "paper") representation = "note";
      const existing = itemOnCanvas(item, representation);
      if (existing) { fitCanvas(); return existing; }
      let payload;
      if (item.type === "paper" && representation === "note") {
        const note = await loadReadingNote(item.source);
        await refreshData();
        payload = { type:"note", noteId:note.id, paperId:Number(item.id), templateId:note.template_id, title:note.title, color:note.template_color };
        if (content.projectId) {
          await api(`/papers/${item.id}/projects/${content.projectId}`, { method: 'POST' });
          await refreshData();
        }
      } else {
        payload = collectionItemCanvasPayload(item, representation);
        if (item.type === "paper" && representation === "record") payload = { ...payload, type:"paper", databaseId:"articles" };
      }
      await flushCanvasSaves();
      if (content.projectId && ["paper", "conference", "dataset"].includes(item.type) && representation !== "note") {
        await api(`/projects/${content.projectId}/resources`, { method:"POST", body:JSON.stringify({ resource_type:item.type, resource_id:item.id, database_id:null }) });
        await refreshData();
      }
      const position = point || { x:Math.max(0, ...content.nodes.map(node => Number(node.x) + canvasNodeSize(node).width)) + 280, y:360 };
      const created = addNode(payload, position);
      fitCanvas(); return created;
    };
    const collectionOnCanvas = (databaseId, scope) => content.nodes.find(node =>
      (node.type === "collection" && node.databaseId === databaseId && (node.scope || "all") === scope && (scope !== "project" || Number(node.projectId) === Number(content.projectId))) ||
      (node.type === "articles" && databaseId === "articles" && scope === "project" && Number(node.projectId) === Number(content.projectId)));
    const openCollections = () => {
      picker.classList.add("hidden");
      openCanvasCollectionPicker({
        projectId:Number(content.projectId) || null,
        hasCollection:(databaseId, scope) => Boolean(collectionOnCanvas(databaseId,scope)),
        hasItem:(item, representation) => Boolean(itemOnCanvas(item,representation)),
        addCollection:async (databaseId,scope) => {
          if (collectionOnCanvas(databaseId,scope)) return;
          const database = canvasCollections().find(item => item.id === databaseId);
          const right = Math.max(0,...content.nodes.map(node => Number(node.x) + canvasNodeSize(node).width));
          const created = addNode({ type:"collection", databaseId, scope, projectId:scope === "project" ? Number(content.projectId) : null, title:`${scope === "project" ? "Project · " : ""}${database.name}` }, { x:right+380,y:500 });
          const project = content.nodes.find(node => node.type === "project");
          if (project) content.edges.push({id:canvasUid("edge"),fromNode:project.id,toNode:created.id,label:"collection"});
          renderNodes(); queueSave(); fitCanvas();
        },
        addItem:async (item,representation) => {
          const created = await importResource(item,null,representation);
          if (created?.type === "note") editCardDetails(created,false,true);
        },
        createItem:async databaseId => {
          const onSaved = async record => {
            const item = collectionItems(databaseId).find(item => String(item.id) === String(record.id));
            await importResource(item);
          };
          const projectId = Number(content.projectId) || null;
          if (databaseId === "conferences") conferenceModal(null,{projectId,onSaved});
          else datasetModal(null,{projectId,onSaved});
        },
      });
    };
    const positionPicker = () => {
      if (!container.isConnected || picker.classList.contains("hidden")) return;
      const bounds = viewport.getBoundingClientRect();
      const parent = picker.offsetParent as HTMLElement;
      if (!parent) return;
      const origin = parent.getBoundingClientRect();
      const left = Math.max(bounds.left, 0) + 12;
      const top = Math.max(bounds.top, 0) + 12;
      const right = Math.min(bounds.right, window.innerWidth) - 12;
      const bottom = Math.min(bounds.bottom, window.innerHeight) - 12;
      const width = Math.max(0, right - left);
      const height = Math.max(0, bottom - top);
      picker.style.width = `${Math.min(pendingConnection ? 480 : 620, width)}px`;
      picker.style.maxHeight = `${Math.min(590, height)}px`;
      picker.style.transform = "none";
      picker.style.bottom = "auto";
      const desiredX = pendingConnection ? bounds.left + pendingConnection.x * zoom + panX + 16 : left + (width - picker.offsetWidth) / 2;
      const desiredY = pendingConnection ? bounds.top + pendingConnection.y * zoom + panY - 40 : bottom - picker.offsetHeight - 76;
      const x = Math.max(left, Math.min(right - picker.offsetWidth, desiredX));
      const y = Math.max(top, Math.min(bottom - picker.offsetHeight, desiredY));
      picker.style.left = `${x - origin.left - parent.clientLeft + parent.scrollLeft}px`;
      picker.style.top = `${y - origin.top - parent.clientTop + parent.scrollTop}px`;
    };
    const pickerObserver = new ResizeObserver(() => {
      if (!container.isConnected) { pickerObserver.disconnect(); return; }
      positionPicker();
    });
    pickerObserver.observe(viewport);
    pickerObserver.observe(picker);
    picker.addEventListener("toggle", positionPicker, true);
    const renderPicker = () => {
      const query = pickerSearch.value.trim().toLocaleLowerCase();
      const projectId = Number(content.projectId || 0) || null;
      const notePicker = pickerType === "notes" || pickerType === "connection";
      pickerTabs.classList.toggle("hidden", !notePicker);
      container.querySelectorAll("[data-canvas-picker-view]").forEach((button) =>
        button.classList.toggle("active", button.dataset.canvasPickerView === pickerView),
      );
      if (notePicker) {
        pickerTitle.textContent = pendingConnection ? "Connect to…" : "Add a note";
        pickerSearch.placeholder = pickerView === "tree" ? "Search in folders and projects…" : "Search templates…";
        const canvasNoteIds = new Set(content.nodes.filter((item) => item.type === "note").map((item) => Number(item.noteId)));
        const markup = pickerView === "tree"
          ? canvasNoteTreeMarkup(state.workspaceTree, query, canvasNoteIds, new Set(), false, canvasNoteTreeOpenPaths(state.workspaceTree, projectId))
          : canvasTemplatePickerMarkup(Boolean(pendingConnection), query);
        pickerResults.innerHTML = markup || `<p class="canvas-picker-empty">No matching note.</p>`;
        pickerResults._canvasItems = [];
        positionPicker();
        return;
      }
      pickerTitle.textContent = pickerType === "paper-template" ? "Choose an article" : "Add to canvas";
      pickerSearch.placeholder = "Search sources…";
      const paperItems = state.papers
        .filter((paper) => !projectId || paper.projects?.some((project) => project.id === projectId))
        .map((paper) => ({ key: `paper:${paper.id}`, title: paper.title, detail: (paper.authors || []).join(", ") || "Project article", color: "#499acd", item: { type: "template-paper", paperId: paper.id } }));
      const sourceItems = pickerType === "paper-template"
          ? paperItems
          : canvasPickerItems(pickerType);
      const items = sourceItems.filter((item) =>
        `${item.title} ${item.detail}`.toLocaleLowerCase().includes(query),
      );
      pickerResults.innerHTML = items.length
        ? items.slice(0, 40).map((item, index) => `<button data-canvas-picker-item="${index}" style="--picker-color:${escapeHtml(("color" in item && item.color) || "#087e86")}"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail)}</small></button>`).join("")
        : `<p>No resource available.</p>`;
      pickerResults._canvasItems = items;
      positionPicker();
    };
    const openPicker = (type, view = "templates") => {
      pickerType = type;
      pickerView = view;
      pendingConnection = null;
      picker.classList.remove("connection-picker");
      picker.style.left = "";
      picker.style.top = "";
      picker.style.bottom = "";
      picker.classList.remove("hidden");
      pickerSearch.value = "";
      renderPicker();
      pickerSearch.focus();
    };
    const connectPendingNode = (created) => {
      if (!pendingConnection || !created) return;
      const from = allNodes().find((item) => item.id === pendingConnection.fromNode);
      const size = canvasNodeSize(created);
      const fromPoint = canvasSidePoint(from, pendingConnection.fromSide);
      const targetPoint = { x: Number(created.x) + size.width / 2, y: Number(created.y) + size.height / 2 };
      content.edges.push({
        id: canvasUid("edge"),
        fromNode: pendingConnection.fromNode,
        fromSide: pendingConnection.fromSide,
        toNode: created.id,
        toSide: canvasDraftTargetSide(fromPoint, targetPoint),
        toEnd: "arrow",
        label: "",
        note: "",
        color: "#77746d",
      });
      pendingConnection = null;
      picker.classList.remove("connection-picker");
      renderNodes();
      queueSave();
    };
    container.querySelectorAll("[data-canvas-add]").forEach((button) =>
      button.addEventListener("click", () => {
        container.querySelector(".canvas-more-tools")?.removeAttribute("open");
        const type = button.dataset.canvasAdd;
        if (type === "collection") {
          void flushCanvasSaves().then(refreshData).then(openCollections).catch(error => toast(error.message,"error"));
          return;
        }
        if (type === "drawing") {
          void createCanvasDrawing().catch(error => toast(error.message, "error"));
          return;
        }
        if (type === "text") return focusCardText(addNode({ type: "text", title: "Idea", text: "" }));
        if (type === "link") return editCardDetails({ type: "link", title: "", url: "" }, true);
        if (type === "zone")
          return addNode({
            type: "zone",
            title: "New zone",
            description: "",
            tone: "teal",
          });
        openPicker(type, type === "notes" ? "templates" : "tree");
      }),
    );
    container.querySelectorAll("[data-canvas-shape]").forEach((button) =>
      button.addEventListener("click", () =>
        addNode({
          type: "shape",
          shape: button.dataset.canvasShape,
          text: "",
          tone: "teal",
        }),
      ),
    );
    container.querySelectorAll("[data-canvas-picker-view]").forEach((button) =>
      button.addEventListener("click", () => {
        pickerView = button.dataset.canvasPickerView;
        pickerSearch.value = "";
        renderPicker();
        pickerSearch.focus();
      }),
    );
    container.querySelector("[data-canvas-picker-close]").addEventListener("click", () => {
      pendingConnection = null;
      pendingTemplateId = null;
      picker.classList.add("hidden");
      picker.classList.remove("connection-picker");
      picker.style.left = "";
      picker.style.top = "";
    });
    pickerSearch.addEventListener("input", renderPicker);
    pickerResults.addEventListener("click", async (event) => {
      const clicked = event.target as Element;
      const noteTarget = clicked.closest<HTMLElement>("[data-canvas-note-id]");
      const assetTarget = clicked.closest<HTMLElement>("[data-canvas-asset-path]");
      const templateTarget = clicked.closest<HTMLElement>("[data-canvas-template-choice]");
      const blankTarget = clicked.closest<HTMLElement>("[data-canvas-blank-note]");
      const textTarget = clicked.closest<HTMLElement>("[data-canvas-connection-text]");
      const target = clicked.closest<HTMLElement>("[data-canvas-picker-item]");
      const item = pickerResults._canvasItems?.[Number(target?.dataset.canvasPickerItem)];
      if (!item && !noteTarget && !assetTarget && !templateTarget && !blankTarget && !textTarget) return;
      try {
        const point = pendingConnection
          ? { x: pendingConnection.x, y: pendingConnection.y }
          : null;
        let created;
        if (noteTarget) {
          const note = state.notes.find((entry) => entry.id === Number(noteTarget.dataset.canvasNoteId));
          if (!note) return;
          created = addNode({ type: "note", noteId: note.id, title: note.title, color: note.template_color || "#087e86" }, point);
        }
        else if (assetTarget) {
          const asset = findWorkspaceNode(assetTarget.dataset.canvasAssetPath);
          if (!asset) return;
          if (asset.kind === 'pdf' && asset.paper_id) {
            created = await importResource(findCollectionItem({ type: 'paper', id: asset.paper_id, databaseId: 'articles' }), point);
          } else {
            const assetType = ["image", "pdf", "video", "audio"].includes(asset.kind) ? asset.kind : "file";
            created = addNode({ type: assetType, path: asset.path, url: asset.url, title: asset.label || asset.name || "Asset" }, point);
          }
        }
        else if (blankTarget) created = await createCanvasNote(point, false);
        else if (textTarget) created = addNode({ type: "text", text: "" }, point);
        else if (templateTarget || item?.item.type === "template") {
          const templateId = Number(templateTarget?.dataset.canvasTemplateChoice || item.item.templateId);
          const template = state.noteTemplates.find((entry) => entry.id === templateId);
          if (template?.is_article_default) {
            pendingTemplateId = template.id;
            pickerType = "paper-template";
            pickerSearch.value = "";
            renderPicker();
            pickerSearch.focus();
            return;
          }
          created = await createTemplateCard(templateId, point);
        }
        else if (item?.item.type === "template-paper") created = await createTemplateCard(pendingTemplateId, point, item.item.paperId);
        else if (item?.item.type === "library-paper") created = await importResource(findCollectionItem({ type: 'paper', id: item.item.paperId, databaseId: 'articles' }), point);
        else created = addNode(item.item, point);
        connectPendingNode(created);
        picker.classList.add("hidden");
        picker.style.left = "";
        picker.style.top = "";
        picker.style.bottom = "";
        pendingTemplateId = null;
        if (created?.type === "note" && (blankTarget || templateTarget)) editCardDetails(created, false, true);
        if (created?.type === "text") focusCardText(created);
      } catch (error) {
        toast(error.message, "error");
      }
    });
    container.querySelector("[data-canvas-upload-image]").addEventListener("click", () => imageInput.click());
    imageInput.addEventListener("change", async () => {
      const file = imageInput.files?.[0];
      if (!file) return;
      const form = new FormData();
      form.append("canvas_path", path);
      form.append("file", file, file.name);
      try {
        const uploaded = await api("/workspace/canvas/image", { method: "POST", body: form });
        const image = addNode(uploaded);
        editCardDetails(image);
        await refreshData();
        toast("Image uploaded to canvas");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        imageInput.value = "";
      }
    });
    nodesLayer.addEventListener("input", (event) => {
      const text = event.target.closest("[data-canvas-text]");
      const zoneTitle = event.target.closest("[data-canvas-zone-title]");
      const zoneDescription = event.target.closest("[data-canvas-zone-description]");
      const shapeLabel = event.target.closest("[data-canvas-shape-label]");
      if (!text && !zoneTitle && !zoneDescription && !shapeLabel) return;
      const nodeId = text?.dataset.canvasText || zoneTitle?.dataset.canvasZoneTitle || zoneDescription?.dataset.canvasZoneDescription || shapeLabel?.dataset.canvasShapeLabel;
      const node = content.nodes.find((item) => item.id === nodeId);
      if (node && text) {
        node.text = text.value;
        if (selectedNodeId === node.id) {
          syncingCanvasText = true;
          try { setMarkdownBlockEditorContent(inspector.querySelector("#canvas-inspector-editor"), inspector.querySelector("#canvas-inspector-source"), node.text); }
          finally { syncingCanvasText = false; }
          if (inspectorDrafts.has(node.id)) inspectorDrafts.get(node.id).content = node.text;
        }
      }
      if (node && zoneTitle) {
        node.title = zoneTitle.value;
        if (selectedNodeId === node.id) {
          const title = inspector.querySelector<HTMLInputElement>('[name="title"]');
          if (title) title.value = node.title;
          const heading = inspector.querySelector("h2");
          if (heading) heading.textContent = node.title;
          if (inspectorDrafts.has(node.id)) inspectorDrafts.get(node.id).title = node.title;
        }
      }
      if (node && zoneDescription) node.description = zoneDescription.value;
      if (node && shapeLabel) node.text = shapeLabel.value;
      queueSave();
    });
    nodesLayer.addEventListener("click", async (event) => {
      if (Date.now() - lastDragEndedAt < 180) return;
      if (event.target.closest(".canvas-note-page summary")) return;
      const textStyleButton = event.target.closest("[data-canvas-text-style]");
      if (textStyleButton) {
        const node = content.nodes.find(item => item.id === textStyleButton.dataset.canvasTextStyle);
        if (node) editCardDetails(node);
        return;
      }
      const collectionItem = event.target.closest("[data-canvas-collection-item]");
      if (collectionItem) {
        try {
          const item = findCollectionItem(parseCollectionDragPayload(collectionItem.dataset.canvasCollectionItem));
          const created = await importResource(item);
          if (created?.type === "note") editCardDetails(created,false,true);
        } catch (error) { toast(error.message,"error"); }
        return;
      }
      const paperLink = event.target.closest("[data-canvas-open-paper]");
      if (paperLink) return openCollectionItem({ type: "paper", id: Number(paperLink.dataset.canvasOpenPaper) });
      const remove = event.target.closest("[data-canvas-delete-node]");
      if (remove) {
        // Removing a card of the selection removes the whole selection.
        const id = remove.dataset.canvasDeleteNode;
        return removeNodes(selectedIds.has(id) ? [...selectedIds] : [id]);
      }
      const card = event.target.closest("[data-canvas-node]");
      if (!card || event.target.closest("button, a, input, textarea, video, audio, iframe, .canvas-node-resize")) return;
      const node = content.nodes.find((item) => item.id === card.dataset.canvasNode);
      if (!node) return;
      // Images and shown canvases are only selected: they have no details to edit here.
      if (["image", "canvas"].includes(node.type) && !(event.ctrlKey || event.metaKey)) {
        selectedIds.clear(); selectedIds.add(node.id);
        paintSelection();
        return;
      }
      if (event.ctrlKey || event.metaKey) {
        if (selectedNodeId && !selectedIds.size) selectedIds.add(selectedNodeId);
        if (selectedIds.has(node.id)) selectedIds.delete(node.id); else selectedIds.add(node.id);
        paintSelection();
        return;
      }
      return editCardDetails(node);
    });
    nodesLayer.addEventListener("dblclick", (event) => {
      if (event.target.closest(".canvas-note-page summary")) return;
      const card = event.target.closest("[data-canvas-node]");
      if (!card || event.target.closest("button, a, input, textarea, video, audio, iframe, .canvas-node-resize")) return;
      // A shown canvas, or one of its cards, opens its source.
      const node = content.nodes.find((item) => item.id === (card.dataset.mirrorOf || card.dataset.canvasNode));
      if (node?.type === "canvas") return void openEmbeddedCanvas(node).catch(error => toast(error.message, "error"));
      if (node?.type === "pdf" && node.paperId) return previewPaperPdfModal(Number(node.paperId), Number(content.projectId) || null);
      if (node?.collectionType && node.recordId != null) return void openItemInSheet({ type: node.collectionType, id: node.recordId, databaseId: node.databaseId }, () => {
        const item = findCollectionItem({ type: node.collectionType, id: node.recordId, databaseId: node.databaseId });
        if (item) { Object.assign(node, collectionItemCanvasPayload(item)); renderNodes(); queueSave(); }
      });
      if (node?.type !== "note") return;
      event.preventDefault();
      editCardDetails(node, false, true);
    });
    const canvasDropPoint = (event, offset = 0) => {
      const bounds = viewport.getBoundingClientRect();
      return {
        x: (event.clientX - bounds.left - panX) / zoom + offset,
        y: (event.clientY - bounds.top - panY) / zoom + offset,
      };
    };
    const uploadCanvasDrop = async (file, point) => {
      const form = new FormData();
      form.append("canvas_path", path);
      const isImage = file.type?.startsWith("image/");
      const imageExtension = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/gif": ".gif",
        "image/webp": ".webp",
      }[file.type] || ".png";
      const uploadName = file.name || `screenshot-${Date.now()}${imageExtension}`;
      form.append("file", file, uploadName);
      const uploaded = await api(
        isImage ? "/workspace/canvas/image" : "/workspace/canvas/asset",
        { method: "POST", body: form },
      );
      const kind = mediaKind(uploaded.url || "") || uploaded.kind;
      const created = addNode({ ...uploaded, type: ["image", "pdf", "video", "audio"].includes(kind) ? kind : uploaded.type }, point);
      if (isImage) editCardDetails(created);
    };
    viewport.addEventListener("paste", async (event) => {
      if (event.target.closest("input, textarea, [contenteditable='true']")) return;
      const image = [...(event.clipboardData?.files || [])].find((file) =>
        file.type?.startsWith("image/"),
      );
      if (!image) {
        const text = event.clipboardData?.getData("text/plain")?.trim();
        if (!text) return;
        event.preventDefault();
        const url = canvasWebUrl(text);
        const node = addNode(url ? { type: "link", title: new URL(url).hostname, url } : { type: "text", title: "Idea", text });
        if (!url) focusCardText(node);
        return;
      }
      event.preventDefault();
      const center = {
        x: (-panX + viewport.clientWidth / 2) / zoom,
        y: (-panY + viewport.clientHeight / 2) / zoom,
      };
      try {
        await uploadCanvasDrop(image, center);
        await refreshData();
        toast("Screenshot pasted into canvas");
      } catch (error) {
        toast(error.message, "error");
      }
    });
    viewport.addEventListener("dragover", (event) => {
      const types = [...(event.dataTransfer?.types || [])];
      const internalDrag = ["workspace", "collection", "paper", "paper-folder", "note", "task", "project"].includes(
        editorSession.activeDragType,
      );
      if (
        !internalDrag &&
        !types.includes("Files") &&
        !types.includes("text/plain") &&
        !types.includes("application/x-kavot-workspace") &&
        !types.includes("application/x-kavot-collection") &&
        !types.includes("application/x-kavot-paper") &&
        !types.includes("application/x-kavot-note") &&
        !types.includes("application/x-kavot-project")
      ) return;
      event.preventDefault();
      event.stopPropagation();
      // A project drag only allows "copy": answering "link" would make the browser refuse the drop.
      event.dataTransfer.dropEffect = types.includes("Files") || types.includes("application/x-kavot-project") ? "copy" : "link";
      viewport.classList.add("is-file-drop");
    });
    viewport.addEventListener("dragleave", (event) => {
      if (!viewport.contains(event.relatedTarget)) viewport.classList.remove("is-file-drop");
    });
    // Dropping a project or another canvas adds a card that shows it live, never a copy.
    const embedCanvas = (item: { projectId?: number; canvasPath?: string; title: string }, point) => {
      const sourcePath = canvasEmbedPath(item);
      if (sourcePath === path) throw new Error("A canvas cannot be shown inside itself");
      if (content.nodes.some(node => node.type === "canvas" && canvasEmbedPath(node) === sourcePath))
        throw new Error("This canvas is already shown here");
      addNode({ type: "canvas", ...item }, point);
      toast(`${item.title} shown on this canvas`);
    };
    // Edits made in this window arrive at once; changes from elsewhere (disk, agents, sync) are polled.
    const onCanvasChanged = (event: Event) => {
      if (!container.isConnected) return window.removeEventListener("kavot:canvas-changed", onCanvasChanged);
      const changed = (event as CustomEvent).detail?.path;
      if (changed !== path && embeddedCanvasPaths().includes(changed)) refreshCanvasEmbeds();
    };
    window.addEventListener("kavot:canvas-changed", onCanvasChanged);
    const reloadCanvasEmbeds = () => {
      for (const sourcePath of embeddedCanvasPaths()) {
        if (!canvasEditedHere(sourcePath)) void loadCanvasEmbed(sourcePath).then(changed => { if (changed) refreshCanvasEmbeds(); });
      }
    };
    const embedPoll = setInterval(() => {
      if (!container.isConnected) return clearInterval(embedPoll);
      if (document.hidden) return;
      if (embedRefreshPending) refreshCanvasEmbeds();
      reloadCanvasEmbeds();
    }, 3000);
    // Opening this canvas always reads the shown canvases again: they may have changed while it was closed.
    reloadCanvasEmbeds();
    const onVisible = () => {
      if (!container.isConnected) return document.removeEventListener("visibilitychange", onVisible);
      if (!document.hidden) reloadCanvasEmbeds();
    };
    document.addEventListener("visibilitychange", onVisible);
    viewport.addEventListener("drop", async (event) => {
      const files = [...(event.dataTransfer?.files || [])];
      let transfer =
        event.dataTransfer?.getData("application/x-kavot-project") ||
        event.dataTransfer?.getData("application/x-kavot-workspace") ||
        event.dataTransfer?.getData("application/x-kavot-collection") ||
        event.dataTransfer?.getData("application/x-kavot-note") ||
        event.dataTransfer?.getData("application/x-kavot-paper") ||
        event.dataTransfer?.getData("text/plain") ||
        editorSession.activeDragPayload ||
        "";
      if (editorSession.activeDragType === "task" && !transfer.startsWith("collection:"))
        transfer = collectionDragPayload("task", Number(editorSession.activeDragPayload), "tasks");
      if (editorSession.activeDragType === "paper" && !transfer.startsWith("collection:"))
        transfer = collectionDragPayload(
          "paper",
          Number(String(editorSession.activeDragPayload).replace("paper:", "")),
          "articles",
        );
      if (transfer.startsWith('paper-folder:')) {
        transfer = `workspace:notes/library/folder-${Number(transfer.slice(13))}`;
      }
      const collectionReference = parseCollectionDragPayload(transfer);
      const noteReference = transfer.startsWith("note:")
        ? Number(transfer.slice(5))
        : null;
      const projectReference = transfer.startsWith("project:") ? Number(transfer.slice(8)) : null;
      if (
        !files.length &&
        !projectReference &&
        !transfer.startsWith("database:") &&
        !transfer.startsWith("workspace:") &&
        !noteReference &&
        !canvasWebUrl(transfer) &&
        !collectionReference
      ) return;
      event.preventDefault();
      event.stopPropagation();
      viewport.classList.remove("is-file-drop");
      try {
        if (files.length) {
          for (const [index, file] of files.entries())
            await uploadCanvasDrop(file, canvasDropPoint(event, index * 24));
          await refreshData();
          toast(`${files.length} reference${files.length === 1 ? "" : "s"} added to canvas`);
          return;
        }
        if (projectReference) {
          const project = state.projects.find(item => item.id === projectReference);
          if (!project?.canvas_path) throw new Error("Project not found");
          embedCanvas({ projectId: project.id, title: project.name }, canvasDropPoint(event));
          return;
        }
        if (transfer.startsWith('database:')) {
          const database = state.databases.find(item => item.id === transfer.slice(9));
          if (database) addNode({ type: 'collection', databaseId: database.id, title: database.name, scope: 'project', projectId: content.projectId }, canvasDropPoint(event));
          return;
        }
        const webUrl = canvasWebUrl(transfer);
        if (webUrl) { addNode({ type: "link", title: new URL(webUrl).hostname, url: webUrl }, canvasDropPoint(event)); return; }
        if (collectionReference) {
          const item = findCollectionItem(collectionReference);
          const created = await importResource(item, canvasDropPoint(event));
          if (created) toast("Resource added to canvas");
          return;
        }
        if (noteReference) {
          const note = state.notes.find((item) => item.id === noteReference);
          if (!note) throw new Error("Note not found");
          if (content.nodes.some((node) => Number(node.noteId) === noteReference))
            throw new Error("This note is already present on the canvas");
          addNode(
            {
              type: "note",
              noteId: note.id,
              title: note.title,
              color: note.template_color || "#087e86",
            },
            canvasDropPoint(event),
          );
          toast("Note linked to the project canvas");
          return;
        }
        const dropped = findWorkspaceNode(transfer.slice(10));
        if (!dropped) return;
        if (dropped.kind === 'canvas') {
          const title = dropped.label || String(dropped.name).replace(/\.canvas$/, "");
          embedCanvas(dropped.project_id ? { projectId: Number(dropped.project_id), title } : { canvasPath: dropped.path, title }, canvasDropPoint(event));
          return;
        }
        if (dropped.kind === 'directory') {
          const files = new Map<string, any>();
          const collect = (node) => {
            if (node.kind === 'directory') (node.children || []).forEach(collect);
            else if (node.note_id || node.kind === 'pdf') files.set(node.note_id ? `note:${node.note_id}` : node.path, node);
          };
          collect(dropped);
          let added = 0;
          for (const file of files.values()) {
            if (content.nodes.some(node => file.note_id ? Number(node.noteId) === Number(file.note_id) : node.path === file.path || (file.paper_id && node.type === 'pdf' && Number(node.paperId) === Number(file.paper_id)))) continue;
            const point = canvasDropPoint(event);
            point.x += (added % 3) * 380;
            point.y += Math.floor(added / 3) * 400;
            addNode(file.note_id ? { type: 'note', noteId: file.note_id, title: file.label || file.name }
              : { type: 'pdf', path: file.path, paperId: file.paper_id, url: file.url, title: file.label || file.name }, point);
            added++;
          }
          if (added) fitCanvas();
          toast(added ? `${added} documents added to the canvas` : 'No new documents to add');
          return;
        }
        const item = dropped.note_id
          ? { type: "note", noteId: dropped.note_id, title: dropped.label || dropped.name }
          : {
              type: ["image", "pdf", "video", "audio"].includes(dropped.kind) ? dropped.kind : "file",
              path: dropped.path,
              paperId: dropped.paper_id,
              url: dropped.url,
              title: dropped.label || dropped.name,
            };
        if (
          dropped.note_id &&
          content.nodes.some((node) => Number(node.noteId) === Number(dropped.note_id))
        ) throw new Error("This note is already present on the canvas");
        if (
          !dropped.note_id &&
          content.nodes.some((node) => node.path && node.path === dropped.path)
        ) throw new Error("This file is already present on the canvas");
        addNode(item, canvasDropPoint(event));
        toast("Reference linked to the project canvas");
      } catch (error) {
        toast(error.message, "error");
      }
    });
    // Move a card, or the whole selection when the card belongs to it; a zone carries what it contains.
    const startNodeDrag = (element: HTMLElement, captureTarget: HTMLElement, pointerId: number, startX: number, startY: number, immediate = false) => {
      // A card of a shown canvas moves its whole frame; a frame carries the cards it shows.
      const node = content.nodes.find((item) => item.id === (element.dataset.mirrorOf || element.dataset.canvasNode));
      if (!node) return;
      const moving = selectedIds.has(node.id) && selectedIds.size > 1 ? content.nodes.filter(item => selectedIds.has(item.id))
        : node.type === "zone" ? canvasMovementNodes(node, content.nodes, content.edges) : [node];
      const frames = new Set(moving.filter(item => item.type === "canvas").map(item => item.id));
      const members = [...moving, ...mirrors.nodes.filter(item => frames.has(item.mirrorOf))]
        .map(item => ({ node: item, x: Number(item.x) || 0, y: Number(item.y) || 0 }));
      const elements = new Map([...(nodesLayer as HTMLElement).querySelectorAll<HTMLElement>("[data-canvas-node]")].map(item => [item.dataset.canvasNode, item]));
      let moved = immediate;
      if (immediate) nodesLayer.classList.add("is-dragging-nodes");
      try { captureTarget.setPointerCapture(pointerId); } catch { /* pointer already released */ }
      const move = (moveEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        const dx = Math.round((moveEvent.clientX - startX) / zoom);
        const dy = Math.round((moveEvent.clientY - startY) / zoom);
        moved ||= Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY) > 3;
        if (!moved) return;
        moveEvent.preventDefault();
        members.forEach(member => {
          member.node.x = member.x + dx;
          member.node.y = member.y + dy;
          const memberElement = elements.get(member.node.id);
          if (memberElement) { memberElement.style.left = `${member.node.x}px`; memberElement.style.top = `${member.node.y}px`; }
        });
        renderEdges();
      };
      const up = (upEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        captureTarget.removeEventListener("pointermove", move);
        captureTarget.removeEventListener("pointerup", up);
        captureTarget.removeEventListener("pointercancel", up);
        nodesLayer.classList.remove("is-dragging-nodes");
        if (moved) { lastDragEndedAt = Date.now(); queueSave(); }
      };
      captureTarget.addEventListener("pointermove", move);
      captureTarget.addEventListener("pointerup", up);
      captureTarget.addEventListener("pointercancel", up);
    };
    // Parts of a card with their own click (note pages, fields, buttons, links, media)
    // keep it: holding the left button still for a moment picks the card (or its selection) up instead.
    const holdToDragAreas = ".canvas-note-sheet, button, a, summary, input, textarea, select, video, audio, [contenteditable='true']";
    nodesLayer.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;
      const element = target.closest<HTMLElement>("[data-canvas-node]");
      const holdArea = target.closest<HTMLElement>(holdToDragAreas);
      if (!element || !holdArea || !element.contains(holdArea) || target.closest(".canvas-node-resize, [data-canvas-connector]")) return;
      if (holdArea.matches("input, textarea, [contenteditable='true']") && document.activeElement === holdArea) return;
      const startX = event.clientX, startY = event.clientY, pointerId = event.pointerId;
      const cancel = () => {
        clearTimeout(timer);
        window.removeEventListener("pointermove", watch);
        window.removeEventListener("pointerup", cancel);
        window.removeEventListener("pointercancel", cancel);
      };
      const watch = (moveEvent) => {
        if (moveEvent.pointerId === pointerId && Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY) > 4) cancel();
      };
      const timer = setTimeout(() => {
        cancel();
        if (holdArea.matches("input, textarea, [contenteditable='true']")) holdArea.blur();
        window.getSelection()?.removeAllRanges();
        startNodeDrag(element, element, pointerId, startX, startY, true);
      }, 280);
      window.addEventListener("pointermove", watch);
      window.addEventListener("pointerup", cancel);
      window.addEventListener("pointercancel", cancel);
    });
    // The release that ends a drag must not also press the button or follow the link under it.
    nodesLayer.addEventListener("click", event => {
      if (Date.now() - lastDragEndedAt >= 180) return;
      event.preventDefault();
      event.stopPropagation();
    }, true);
    nodesLayer.addEventListener("dragstart", event => {
      if (nodesLayer.classList.contains("is-dragging-nodes")) event.preventDefault();
    });
    nodesLayer.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest(".canvas-note-sheet")) return;
      if (!event.target.closest("input, textarea, a, video, audio, iframe"))
        viewport.focus({ preventScroll: true });
      const connector = event.target.closest("[data-canvas-connector]");
      if (connector) {
        event.preventDefault();
        event.stopPropagation();
        const sourceElement = connector.closest("[data-canvas-node]");
        const fromNode = sourceElement.dataset.canvasNode;
        const fromSide = connector.dataset.canvasConnector;
        sourceElement.classList.add("is-connecting");
        nodesLayer.classList.add("is-connecting");
        connector.setPointerCapture(event.pointerId);
        const linkable = allNodes();
        const origin = canvasSidePoint(linkable.find((node) => node.id === fromNode), fromSide);
        connectionDraft = {
          nodes: linkable,
          fromNode,
          fromSide,
          x: origin.x,
          y: origin.y,
          toNode: null,
          toSide: null,
        };
        let targetConnector = null;
        const moveConnection = (moveEvent) => {
          targetConnector?.classList.remove("is-connection-target");
          const candidate = document
            .elementFromPoint(moveEvent.clientX, moveEvent.clientY)
            ?.closest?.("[data-canvas-connector]");
          const candidateNode = (candidate?.closest("[data-canvas-node]") as HTMLElement)?.dataset.canvasNode;
          targetConnector = candidate && candidateNode !== fromNode ? candidate : null;
          targetConnector?.classList.add("is-connection-target");
          const bounds = viewport.getBoundingClientRect();
          connectionDraft.x = (moveEvent.clientX - bounds.left - panX) / zoom;
          connectionDraft.y = (moveEvent.clientY - bounds.top - panY) / zoom;
          connectionDraft.toNode = targetConnector
            ?.closest("[data-canvas-node]")?.dataset.canvasNode || null;
          connectionDraft.toSide = targetConnector?.dataset.canvasConnector || null;
          renderEdges();
        };
        const finishConnection = () => {
          const completed = connectionDraft;
          if (
            completed?.toNode &&
            !content.edges.some(
              (edge) =>
                edge.fromNode === completed.fromNode &&
                edge.fromSide === completed.fromSide &&
                edge.toNode === completed.toNode &&
                edge.toSide === completed.toSide,
            )
          ) {
            content.edges.push({
              id: canvasUid("edge"),
              fromNode: completed.fromNode,
              fromSide: completed.fromSide,
              toNode: completed.toNode,
              toSide: completed.toSide,
              toEnd: "arrow",
              label: "",
              note: "",
              color: "#77746d",
            });
            queueSave();
          } else if (completed && !completed.toNode) {
            pendingConnection = { ...completed };
            pickerType = "connection";
            pickerView = "templates";
            picker.classList.add("connection-picker");
            picker.classList.remove("hidden");
            pickerSearch.value = "";
            renderPicker();
            pickerSearch.focus();
          }
          targetConnector?.classList.remove("is-connection-target");
          sourceElement.classList.remove("is-connecting");
          nodesLayer.classList.remove("is-connecting");
          connector.removeEventListener("pointermove", moveConnection);
          connectionDraft = null;
          renderNodes();
        };
        connector.addEventListener("pointermove", moveConnection);
        connector.addEventListener("pointerup", finishConnection, { once: true });
        connector.addEventListener("pointercancel", finishConnection, { once: true });
        renderEdges();
        return;
      }
      const resizeHandle = event.target.closest(".canvas-node-resize");
      if (resizeHandle) {
        const element = resizeHandle.closest("[data-canvas-node]");
        const node = content.nodes.find((item) => item.id === element.dataset.canvasNode);
        const minimum = canvasNodeMinimumSize(node);
        const startX = event.clientX;
        const startY = event.clientY;
        const size = canvasNodeSize(node);
        resizeHandle.setPointerCapture(event.pointerId);
        const resize = (moveEvent) => {
          node.width = Math.max(minimum.width, Math.round(size.width + (moveEvent.clientX - startX) / zoom));
          node.height = Math.max(minimum.height, Math.round(size.height + (moveEvent.clientY - startY) / zoom));
          element.style.width = `${node.width}px`;
          element.style.height = `${node.height}px`;
          renderEdges();
        };
        const finishResize = () => {
          resizeHandle.removeEventListener("pointermove", resize);
          queueSave();
        };
        resizeHandle.addEventListener("pointermove", resize);
        resizeHandle.addEventListener("pointerup", finishResize, { once: true });
        resizeHandle.addEventListener("pointercancel", finishResize, { once: true });
        return;
      }
      const header = event.target.closest(".canvas-node-header") || event.target.closest("[data-canvas-node]");
      if (!header || event.target.closest(holdToDragAreas)) return;
      event.preventDefault();
      startNodeDrag(header.closest("[data-canvas-node]"), header, event.pointerId, event.clientX, event.clientY);
    });
    const toggleConnection = (target) => {
      const edge = content.edges.find(item => item.id === target.dataset.canvasCollapseEdge);
      if (!edge) return;
      edge.collapsed = !edge.collapsed;
      renderNodes();
      queueSave();
      [...edgesLayer.querySelectorAll("[data-canvas-collapse-edge]")].find(element => element.dataset.canvasCollapseEdge === edge.id)?.focus();
    };
    edgesLayer.addEventListener("keydown", event => {
      const toggle = event.target.closest("[data-canvas-collapse-edge]");
      if (!toggle || !["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      toggleConnection(toggle);
    });
    edgesLayer.addEventListener("click", (event) => {
      const toggle = event.target.closest("[data-canvas-collapse-edge]");
      if (toggle) { event.preventDefault(); event.stopPropagation(); toggleConnection(toggle); return; }
      const edgeElement = event.target.closest("[data-canvas-edge]");
      if (!edgeElement) return;
      const edge = content.edges.find((item) => item.id === edgeElement.dataset.canvasEdge);
      if (!edge) return;
      selectedEdgeId = edge.id;
      const from = content.nodes.find((item) => item.id === edge.fromNode);
      const to = content.nodes.find((item) => item.id === edge.toNode);
      openModal(`<header class="modal-header"><h2>Annotated relation</h2><p>${escapeHtml(from?.title || "Source")} → ${escapeHtml(to?.title || "Target")}</p></header><div class="modal-body"><form id="canvas-relation-form" class="form-grid"><div class="form-field full"><label>Connection label</label><input name="label" maxlength="120" value="${escapeHtml(edge.label || "")}" placeholder="supports, contradicts, depends on…"></div><div class="form-field full"><label>Relation note</label><textarea name="note" maxlength="4000" placeholder="Explain why these elements are connected…">${escapeHtml(edge.note || "")}</textarea></div><div class="form-field"><label>Color</label><input name="color" type="color" value="${escapeHtml(/^#[0-9a-f]{6}$/i.test(edge.color || "") ? edge.color : "#77746d")}"></div><div class="form-actions relation-form-actions"><button type="button" class="button" id="ask-canvas-relation">Explain this relation</button><button type="button" class="button button-danger" id="delete-canvas-relation">Delete relation</button><button type="button" class="button" data-close-modal>Cancel</button><button class="button button-primary">Save relation</button></div></form></div>`);
      document.querySelector('#ask-canvas-relation').addEventListener('click', () => { closeModal(); suggestToAgent('Explain this directed, annotated relation using the relevant notes and sources.'); });
      document.querySelector("#delete-canvas-relation").addEventListener("click", () => {
        content.edges = content.edges.filter((item) => item.id !== edge.id);
        closeModal();
        renderNodes();
        queueSave();
      });
      document.querySelector("#canvas-relation-form").addEventListener("submit", (submitEvent) => {
        submitEvent.preventDefault();
        const form = new FormData(submitEvent.currentTarget as HTMLFormElement);
        edge.label = String(form.get("label") || "").trim();
        edge.note = String(form.get("note") || "").trim();
        edge.color = String(form.get("color") || "#77746d");
        closeModal();
        renderEdges();
        queueSave();
      });
    });
    container.querySelectorAll("[data-canvas-zoom]").forEach((button) =>
      button.addEventListener("click", () => {
        if (button.dataset.canvasZoom === "fit") {
          fitCanvas();
        } else setZoom(zoom + (button.dataset.canvasZoom === "in" ? 0.1 : -0.1));
      }),
    );
    viewport.addEventListener("wheel", (event) => {
      if (!event.ctrlKey && !event.metaKey && event.target.closest("textarea, .canvas-note-preview, .canvas-note-sheet")) return;
      event.preventDefault();
      setZoom(zoom * Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
    }, { passive: false });
    // Right (or middle) button drag pans anywhere; the context menu only opens on a still click.
    let panMoved = false;
    viewport.addEventListener("pointerdown", (event) => {
      if (![1, 2].includes(event.button) || viewport.classList.contains("is-panning") ||
        event.target.closest("input, textarea, select, [contenteditable='true'], .canvas-note-sheet")) return;
      if (event.button === 1) event.preventDefault();
      const startX = event.clientX;
      const startY = event.clientY;
      const originX = panX;
      const originY = panY;
      panMoved = false;
      viewport.setPointerCapture(event.pointerId);
      const move = (moveEvent) => {
        if (!panMoved && Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY) < 4) return;
        panMoved = true;
        viewport.classList.add("is-panning");
        panX = originX + moveEvent.clientX - startX;
        panY = originY + moveEvent.clientY - startY;
        applyTransform();
      };
      const up = () => {
        viewport.classList.remove("is-panning");
        viewport.removeEventListener("pointermove", move);
        viewport.removeEventListener("pointerup", up);
        viewport.removeEventListener("pointercancel", up);
        if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
      };
      viewport.addEventListener("pointermove", move);
      viewport.addEventListener("pointerup", up);
      viewport.addEventListener("pointercancel", up);
    });
    viewport.addEventListener("contextmenu", event => {
      if (!panMoved) return;
      panMoved = false;
      event.preventDefault();
      event.stopPropagation();
    }, true);
    // Left-drag on the background draws a selection rectangle; Ctrl keeps the current selection.
    viewport.addEventListener("pointerdown", (event) => {
      // Empty stage/layer elements cover much of the background too.
      if (event.button !== 0 || viewport.classList.contains("is-panning") ||
        event.target.closest("[data-canvas-node], [data-canvas-edge], [data-canvas-collapse-edge], button, a, input, textarea, [contenteditable='true']")) return;
      event.preventDefault();
      viewport.focus({ preventScroll: true });
      const bounds = viewport.getBoundingClientRect();
      const startX = event.clientX - bounds.left;
      const startY = event.clientY - bounds.top;
      const additive = event.ctrlKey || event.metaKey;
      const initial = new Set(additive ? [...selectedIds, ...(selectedNodeId ? [selectedNodeId] : [])] : []);
      const marquee = document.createElement("div");
      marquee.className = "canvas-marquee";
      let dragged = false;
      viewport.setPointerCapture(event.pointerId);
      const move = (moveEvent) => {
        const x = moveEvent.clientX - bounds.left;
        const y = moveEvent.clientY - bounds.top;
        if (!dragged && Math.abs(x - startX) + Math.abs(y - startY) < 4) return;
        if (!dragged) { dragged = true; viewport.append(marquee); }
        const left = Math.min(x, startX), top = Math.min(y, startY);
        const width = Math.abs(x - startX), height = Math.abs(y - startY);
        Object.assign(marquee.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
        const area = { x: (left - panX) / zoom, y: (top - panY) / zoom, right: (left + width - panX) / zoom, bottom: (top + height - panY) / zoom };
        selectedIds.clear();
        initial.forEach(id => selectedIds.add(id));
        visibleNodes().forEach(node => {
          const size = canvasNodeSize(node);
          const x0 = Number(node.x) || 0, y0 = Number(node.y) || 0;
          if (x0 < area.right && x0 + size.width > area.x && y0 < area.bottom && y0 + size.height > area.y) selectedIds.add(node.id);
        });
        paintSelection();
      };
      const up = () => {
        marquee.remove();
        viewport.removeEventListener("pointermove", move);
        viewport.removeEventListener("pointerup", up);
        viewport.removeEventListener("pointercancel", up);
        if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
        if (!dragged && !additive) { selectedIds.clear(); paintSelection(); }
        if (dragged) lastDragEndedAt = Date.now();
      };
      viewport.addEventListener("pointermove", move);
      viewport.addEventListener("pointerup", up);
      viewport.addEventListener("pointercancel", up);
    });
    renderNodes();
    fitCanvas();
  });
}

export async function flushCanvasSaves() {
  await flushInlineDrawings();
  await Promise.all([...canvasDetailSaves.values()].map(entry => { clearTimeout(entry.timer); return entry.save(); }));
  await Promise.all([...canvasDetailRequests.values()]);
  const pending = [...canvasSaveTimers.values()];
  await Promise.all(pending.map(item => {
    clearTimeout(item.timer);
    return item.save();
  }));
  await Promise.all([...canvasSaveRequests.values()]);
}
