import { escapeHtml, state } from '../../../app/state';
import { api } from '../../../services/api';
import { findWorkspaceNode, interfaceIcon, replaceActiveWorkspaceTab, rerenderNotesContext, workspaceResourcePayload, workspaceResourceTab } from '../workspace';
import { canvasHiddenNodes } from './model';
import { canvasSaveTimers, canvasSaveRequests, flushCanvasSaves } from './saves';
import { canvasNodeSize } from './geometry';

type WebPreview = { available: boolean; title: string; description: string; image?: string };

export const webPreviews = new Map<string, WebPreview>();

const webPreviewRequests = new Map<string, Promise<void>>();

export async function loadWebPreview(url: string) {
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
export function loadCanvasEmbed(path: string): Promise<boolean> {
  if (!canvasEmbedRequests.has(path)) canvasEmbedRequests.set(path, fetch(`/api/workspace/file?path=${encodeURIComponent(path)}`, { cache: "no-store" })
    .then(response => response.ok ? response.json() : { missing: true }).catch(() => null).then(content => {
      if (!content || typeof content !== "object") return false;
      const changed = JSON.stringify(canvasEmbeds.get(path)) !== JSON.stringify(content);
      canvasEmbeds.set(path, content);
      return changed;
    }).finally(() => canvasEmbedRequests.delete(path)));
  return canvasEmbedRequests.get(path);
}

export function canvasEmbedPath(node): string | null {
  if (node.projectId) return state.projects.find(item => item.id === Number(node.projectId))?.canvas_path || null;
  return node.canvasPath || null;
}

function openCanvasResources() {
  return [state.primaryResource, state.secondaryResource,
    ...state.workspaceTabs.primary.map(tab => tab.resource), ...state.workspaceTabs.secondary.map(tab => tab.resource)];
}

/** A canvas being edited in this window: its editor is shown, or its edits are not saved yet. */
export function canvasEditedHere(path: string) {
  return Boolean(document.querySelector(`[data-canvas-path="${CSS.escape(path)}"]`) || canvasSaveTimers.has(path) || canvasSaveRequests.has(path));
}

/** A canvas being edited here shows its latest edits; any other is read from disk, never from a stale tab. */
export function canvasEmbedSource(path: string) {
  const open = canvasEditedHere(path)
    ? openCanvasResources().find(resource => resource?.path === path && resource.content && typeof resource.content === "object")
    : null;
  return open?.content || canvasEmbeds.get(path);
}

export async function openEmbeddedCanvas(node) {
  await flushCanvasSaves();
  if (node.projectId) {
    const { openProjectArea } = await import("../../projects/navigation");
    return openProjectArea(Number(node.projectId), "canvas");
  }
  const target = findWorkspaceNode(node.canvasPath);
  if (!target) throw new Error("This canvas no longer exists");
  const pane = state.activeNotePane === "secondary" && state.workspaceTabs.secondary.length ? "secondary" : "primary";
  replaceActiveWorkspaceTab(pane, workspaceResourceTab(await workspaceResourcePayload(target)));
  await rerenderNotesContext();
}

// A shown canvas is a frame holding the source's own cards at full size, so each can be linked from here.
export const EMBED_PADDING = 40;

const EMBED_HEADER = 72;

/** The source's cards and links placed in the frame; ids are `<frame id>~<source id>`, stable across reloads. */
export function canvasEmbedMirror(embed) {
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

export function canvasEmbedPreview(node) {
  // A canvas shown inside a shown canvas stays a plain card: no endless nesting.
  if (node.mirrorOf) return `<p class="canvas-embed-empty">${interfaceIcon("canvas")} Canvas</p>`;
  const path = canvasEmbedPath(node);
  const source = path ? canvasEmbedSource(path) : { missing: true };
  const message = source?.missing ? "This canvas no longer exists." : !source ? "Loading canvas…" : !(source.nodes || []).length ? "This canvas is empty." : "";
  return `<div class="canvas-embed" data-canvas-embed="${escapeHtml(path || "")}" title="Double-click to open this canvas">${message ? `<p class="canvas-embed-empty">${escapeHtml(message)}</p>` : ""}</div>`;
}
