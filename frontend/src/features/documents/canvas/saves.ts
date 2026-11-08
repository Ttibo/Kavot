import { state } from '../../../app/state';
import { flushInlineDrawings } from '../drawing';

export const canvasSaveTimers = new Map();

export const canvasSaveRequests = new Map<string, Promise<unknown>>();

// Keep pending inspector edits alive when cards or views change.
export const canvasDetailSaves = new Map<string, { timer: ReturnType<typeof setTimeout>; save: () => Promise<void>; failed?: boolean }>();

export const canvasDetailRequests = new Map<string, Promise<void>>();

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
