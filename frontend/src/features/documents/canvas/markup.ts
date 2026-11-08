import { canvasTextCss } from './text';
import { mediaPreview } from '../mediaPreview';
import { workspaceColor } from '../../../styles/palette';
import { escapeHtml, noteAssetBase, renderMarkdown, state, truncate } from '../../../app/state';
import { interfaceIcon, noteContextLabel } from '../workspace';
import { iconPaths } from '../../../components/Icon';
import { findCollectionItem } from '../../collections/catalog';
import { canvasWebUrl, canvasTemplateIcon } from './model';
import { hydrateEmbeds } from '../embeds';
import { webPreviews, canvasEmbedPreview } from './embeds';
import { canvasNodeSize, canvasSideNames, canvasShapeNames, canvasSidePoint, canvasDefaultEdgeSides, canvasSideControlPoint, canvasEdgeGeometry, canvasEdgePath, canvasDraftTargetSide } from './geometry';

// The inspector's header buttons use the icons of the other side panels, so all look alike.
export const panelIcon = (name: string) => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${iconPaths[name]}"/></svg>`;

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

function canvasWorkspaceResources(kinds, nodes = state.workspaceTree, output = []) {
  (nodes || []).forEach((node) => {
    if (kinds.includes(node.kind)) output.push(node);
    canvasWorkspaceResources(kinds, node.children || [], output);
  });
  return output;
}

export function canvasNoteTreeMarkup(nodes, query = "", canvasNoteIds = new Set(), seenNoteIds = new Set(), ancestorMatches = false, openPaths = new Set<string>()) {
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

export function canvasTemplatePickerMarkup(includeText = false, query = "") {
  const templates = state.noteTemplates.filter((template) =>
    !template.archived && `${template.name} ${template.title_template || ""}`.toLocaleLowerCase().includes(query),
  ).map((template) =>
    `<button class="canvas-picker-template" data-canvas-template-choice="${template.id}" style="--picker-color:${escapeHtml(workspaceColor(template.color || "#087e86"))}">${interfaceIcon(canvasTemplateIcon(template))}<span><strong>${escapeHtml(template.name)}</strong><small>${escapeHtml(template.title_template || "Create from template")}</small></span></button>`,
  ).join("");
  return `<div class="canvas-picker-quick-actions"><button data-canvas-blank-note style="--picker-color:#087e86">${interfaceIcon("plus")}<span><strong>Blank note</strong><small>Create a new empty note</small></span></button>${includeText ? `<button data-canvas-connection-text style="--picker-color:#d4a850">${interfaceIcon("text")}<span><strong>Text card</strong><small>Add free text without creating a note</small></span></button>` : ""}</div><div class="canvas-picker-section-title">Templates</div><div class="canvas-picker-template-grid">${templates || "<p>No template available.</p>"}</div>`;
}

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

export function releaseNoteSheets(root: ParentNode) {
  root.querySelectorAll<HTMLElement>("[data-canvas-note-sheet]").forEach(sheet => { noteSheetObserver?.unobserve(sheet); observedSheets.delete(sheet); });
}

// Sheets of closed canvases are released, so the observer never keeps detached cards alive.
const observedSheets = new Set<HTMLElement>();
export function fitNoteSheets(root: ParentNode) {
  for (const sheet of observedSheets)
    if (!sheet.isConnected) { noteSheetObserver?.unobserve(sheet); observedSheets.delete(sheet); }
  root.querySelectorAll<HTMLElement>("[data-canvas-note-sheet]").forEach(sheet => {
    // Script blocks and collection views show their live interface, not their source.
    hydrateEmbeds(sheet.querySelector<HTMLElement>(":scope > .canvas-note-page"));
    applyNotePageLayout(sheet);
    if (noteSheetObserver && !observedSheets.has(sheet)) { noteSheetObserver.observe(sheet); observedSheets.add(sheet); }
  });
}

export function canvasNodePreview(node) {
  // Collection frames were retired: an old one only says so, and can be removed from the canvas.
  if (node.type === "articles" || node.type === "collection") return `<div class="canvas-collection-preview"><p>Collection views were retired. Add the articles or tasks you need as cards, then remove this one.</p></div>`;
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
export function canvasNodeProtected(node, hostProjectId): boolean {
  if (!hostProjectId) return false;
  if (node.type === "project") return !node.projectId || Number(node.projectId) === Number(hostProjectId);
  const note = node.noteId != null ? state.notes.find(item => Number(item.id) === Number(node.noteId)) : null;
  return note?.system_kind === "project_home" && Number(note.project_id) === Number(hostProjectId);
}

export function canvasNodeMarkup(node, hostProjectId = null) {
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

export function canvasEdgeMarkup(edge, nodes, edges = []) {
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

export function canvasDraftEdgeMarkup(connection) {
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
          ${tool("link", "link", "Link", "Add web link")}${tool("zone", "zone", "Zone", "Add zone")}${tool("item", "papers", "Article / task", "Add an article or a task")}
          <button data-canvas-group hidden aria-label="Group the selection into a zone" title="Group into a zone (Ctrl+G)">${interfaceIcon("zone")}<span>Group</span></button>
          <button data-canvas-delete-selection hidden aria-label="Remove the selected cards from the canvas" title="Remove the selected cards (Delete)">${interfaceIcon("trash")}<span>Remove</span></button>
          <span class="canvas-toolbar-separator"></span>
          <button class="canvas-save-state" aria-label="Canvas save status; click to retry" title="Saved" aria-live="polite">Saved</button>
          <button data-canvas-inspector-toggle aria-label="Toggle card details" aria-expanded="false" title="Card details">${interfaceIcon("edit")}</button>
        </div>

        <div class="canvas-navigation-dock"><div class="canvas-minimap"><svg data-canvas-minimap role="img" aria-label="Canvas overview; click to navigate"></svg></div><div class="canvas-zoom-tools"><button data-canvas-zoom="out" aria-label="Zoom out">${interfaceIcon("zoomout")}</button><output data-canvas-zoom-label>100 %</output><button data-canvas-zoom="in" aria-label="Zoom in">${interfaceIcon("zoomin")}</button><button data-canvas-zoom="fit" aria-label="Fit canvas" title="Fit canvas">${interfaceIcon("fit")}</button></div></div>
      </div>
      <div class="canvas-inspector-resizer" data-canvas-inspector-resizer role="separator" aria-label="Resize card details" aria-orientation="vertical" tabindex="0" title="Drag to resize · double-click to reset"></div>
      <aside class="canvas-inspector" aria-label="Card details"><div class="canvas-inspector-bar"><strong>Card details</strong><button type="button" class="icon-button" data-canvas-inspector-close aria-label="Close card details" title="Close">${panelIcon("close")}</button></div><div data-canvas-inspector-content><div class="canvas-inspector-empty"><h3>Your thinking, in detail</h3><p>Select a card to edit its title and content.</p></div></div></aside>
    </div>
  </section>`;
}

export function canvasPickerItems(type) {
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
