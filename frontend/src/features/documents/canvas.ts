import { changedSinceBase, setEditorBase } from './editorBase';
import { canvasTextControls } from './canvas/text';
import { renderPdfPreviews } from './pdf/preview';
import { mediaKind } from './mediaPreview';
import { showContextMenu } from '../../components/contextMenu';
import { registerAgentContext, suggestToAgent, suggestions } from '../externalAgents/context';
import { escapeHtml, noteAssetBase, state } from '../../app/state';
import { api } from '../../services/api';
import { flushSecondaryNoteAutosave, flushWorkspaceMarkdownSaves, findWorkspaceNode, refreshRelationalNotes, refreshWorkspaceTreeOnly, reloadNoteForOpen, replaceActiveWorkspaceTab, rerenderNotesContext, workspaceNoteTab } from './workspace';
import { collectionDragPayload, collectionItemCanvasPayload, findCollectionItem, openCollectionItem, parseCollectionDragPayload } from '../collections/catalog';
import { refreshData, toast } from '../../app/navigation';
import { bindMarkdownBlockEditor, currentMarkdownBlockInput, markdownBlockEditorMarkup, setMarkdownBlockEditorContent } from './markdown';
import { closeModal, openModal, templateEditorModal } from '../../components/dialogs/controller';
import { previewPaperPdfModal } from '../library/documents';
import { canvasHiddenNodes, migrateCanvasBranchFolds, canvasWebUrl, canvasMovementNodes, canvasNoteTreeOpenPaths } from './canvas/model';
import { openItemInSheet } from '../collections/itemSheet';
import { bindNoteReferences, noteReferencePickerMarkup } from './references';
import { editorSession } from '../../app/editorSession';
import { openCanvasItemPicker } from './canvas/itemPicker';
import { loadReadingNote } from '../library/documents';
import { drawingPreviewPng, emptyDrawing, openDrawingEditor } from './drawing';
import { webPreviews, loadWebPreview, loadCanvasEmbed, canvasEmbedPath, canvasEditedHere, canvasEmbedSource, openEmbeddedCanvas, EMBED_PADDING, canvasEmbedMirror } from './canvas/embeds';
import { panelIcon, canvasNoteTreeMarkup, canvasTemplatePickerMarkup, releaseNoteSheets, fitNoteSheets, canvasNodePreview, canvasNodeProtected, canvasNodeMarkup, canvasEdgeMarkup, canvasDraftEdgeMarkup, canvasPickerItems } from './canvas/markup';
import { canvasSaveTimers, canvasSaveRequests, canvasDetailSaves, canvasDetailRequests, flushCanvasSaves } from './canvas/saves';
import { oncePerFrame } from './domLifecycle';
import { bindCanvasInspector } from './canvas/inspector';
import { canvasUid, canvasNodeMinimumSize, canvasNodeSize, canvasSidePoint, canvasDefaultEdgeSides, canvasDraftTargetSide, CANVAS_OVERVIEW_ZOOM } from './canvas/geometry';

export { refreshCanvasTemplatePresentation, canvasEditorMarkup } from './canvas/markup';
export { hasCanvasDrafts, removeNoteFromOpenCanvases, flushCanvasSaves } from './canvas/saves';

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
    const { openInspector } = bindCanvasInspector(container, inspector, () => renderMinimap());
    const inspectorDrafts = new Map();
    // The version of each card's note its inspector edits from, kept with an unsaved draft: saves send it.
    const inspectorBases = new Map<string, string | undefined>();
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
    // Panning and dragging fire many pointer moves per frame: redraw the minimap and links once per frame.
    const scheduleMinimap = oncePerFrame(() => renderMinimap());
    const scheduleEdges = oncePerFrame(() => renderEdges());
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
      scheduleMinimap();
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
      releaseNoteSheets(nodesLayer);
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
      const markup = `<${panelTag} id="${isNewLink ? "canvas-new-link-form" : "canvas-details-form"}" class="form-grid"><header class="canvas-inspector-bar"><label class="form-field full canvas-detail-title"><span class="sr-only">Title</span><input aria-label="Title" name="title" required maxlength="240" value="${escapeHtml(draft?.title ?? note?.title ?? node.title ?? "")}"></label>${!isNewLink && (note || node.collectionType) ? `<button type="button" class="icon-button" data-canvas-open-tab aria-label="Open full size in a new tab" title="Open in a new tab">${panelIcon("open")}</button>` : ""}<button type="button" class="icon-button" data-canvas-inspector-close aria-label="Close card details" title="Close">${panelIcon("close")}</button></header>${isNewLink ? "<h2>Add web link</h2>" : '<button type="button" class="canvas-detail-save-state" data-detail-save-state hidden aria-live="polite">Saved automatically</button>'}${node.type === "link" ? `<label class="form-field full">Web address<input name="url" type="url" required placeholder="https://…" value="${escapeHtml(node.url || "")}"></label>` : ""}${node.type === "image" ? `<img class="canvas-inspector-image" src="${escapeHtml(node.url || "")}" alt="${escapeHtml(node.title || "Image")}">` : node.type === "link" && !isNewLink ? canvasNodePreview(node) : ""}${node.collectionType ? `<button type="button" class="button button-small" data-card-open-resource>Edit ${escapeHtml(node.collectionType)} record ↗</button>` : ""}${node.type === "text" ? canvasTextControls(node) : ""}${noteEditor}${isNewLink ? '<div class="form-actions"><button class="button button-primary">Add link</button></div>' : ""}</${panelTag}>`;
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
        if (note && !draft) { setEditorBase(source, note.content); inspectorBases.set(node.id, note.content_hash); }
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
              // Changed elsewhere since the inspector opened (an agent, another window): never write over it.
              const latest = state.notes.find(item => item.id === note.id);
              const reload = async () => {
                canvasDetailSaves.delete(detailKey); inspectorDrafts.delete(node.id);
                const fresh = await api<Note>(`/notes/${note.id}`);
                Object.assign(note, fresh);
                if (latest && latest !== note) Object.assign(latest, fresh);
                inspectorBases.set(node.id, fresh.content_hash);
                if (source?.isConnected && editorRoot) setMarkdownBlockEditorContent(editorRoot, source, fresh.content, null, null, true);
                showStatus("Changed elsewhere · reloaded");
                toast("This note was changed by an agent or elsewhere: the card now shows that version.", "error");
              };
              if (latest && data.content !== latest.content && changedSinceBase(source, latest.content)) return reload();
              let saved: Note;
              try {
                saved = await api<Note>(`/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ title, content: data.content, expected_hash: inspectorBases.get(node.id) ?? note.content_hash }) });
              } catch (error) {
                if ((error as { status?: number }).status === 409) return reload();
                throw error;
              }
              setEditorBase(source, saved.content);
              inspectorBases.set(node.id, saved.content_hash);
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
        form.querySelector("[data-canvas-open-tab]")?.addEventListener("click", async () => {
          try { await flushCanvasSaves(); } catch { showStatus("Save failed · click to retry", true); return; }
          // Full size, in a new tab of the pane holding this canvas.
          const pane = (container.closest("[data-workspace-pane]") as HTMLElement | null)?.dataset.workspacePane || "primary";
          if (note) {
            const fresh = await reloadNoteForOpen(note.id);
            if (fresh) { replaceActiveWorkspaceTab(pane, workspaceNoteTab(fresh), true); rerenderNotesContext(); }
            return;
          }
          const { openCollectionInNotes } = await import("../collections/noteEditor");
          await openCollectionInNotes({ type: node.collectionType, id: node.recordId, databaseId: node.databaseId }, { newTab: true, pane });
        });
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
    const openItemPicker = () => {
      picker.classList.add("hidden");
      openCanvasItemPicker({
        projectId: Number(content.projectId) || null,
        hasItem: (item, representation) => Boolean(itemOnCanvas(item, representation)),
        addItem: async (item, representation) => {
          const created = await importResource(item, null, representation);
          if (created?.type === "note") editCardDetails(created, false, true);
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
        if (type === "item") {
          void flushCanvasSaves().then(refreshData).then(openItemPicker).catch(error => toast(error.message,"error"));
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
        scheduleEdges();
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
          scheduleEdges();
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
          scheduleEdges();
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
