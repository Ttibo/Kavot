/**
 * Live blocks stored as inert HTML inside a note:
 * - script blocks (HTML/CSS/JS) run in an isolated, opaque-origin iframe;
 * - collection views render a collection as a table, list, gallery or kanban.
 * The document only keeps data attributes and <pre> text, so exported files stay inert.
 */
import "../../../styles/features/embeds.css";
import { parseConfig, type Layout } from "./collectionData";
import { mountCollectionView } from "./collectionView";
import { mountScript } from "./scriptBlock";
import { scriptFromElement } from "./scriptRuntime";

export { defaultConfig, serializeCollection } from "./collectionData";
export { CollectionView, openCollectionConfig } from "./collectionView";
export { ScriptBlock, openScriptEditor, openScriptLibrary } from "./scriptBlock";
export { emptyScript } from "./scriptRuntime";
export { scriptExamples } from "../scriptExamples";

/** Replace a stored placeholder with a fresh host element that keeps its id. */
function replaceWithHost(element: HTMLElement) {
  const host = document.createElement("div");
  if (element.id) host.id = element.id;
  element.replaceWith(host);
  return host;
}

/** Turn the embed placeholders of rendered, read-only HTML into live views. */
export function hydrateEmbeds(container: HTMLElement | null, noteTitle?: () => string) {
  if (!container) return;
  container.querySelectorAll<HTMLElement>('div[data-type="script-block"]').forEach(element => {
    const script = scriptFromElement(element);
    mountScript(replaceWithHost(element), script, { editable: () => false, noteTitle });
  });
  container.querySelectorAll<HTMLElement>('div[data-type="collection-view"]').forEach(element => {
    const collection = element.getAttribute("data-collection") || "tasks";
    const attrs = {
      collection,
      layout: (element.getAttribute("data-layout") || "table") as Layout,
      config: parseConfig(element.getAttribute("data-config"), collection),
    };
    mountCollectionView(replaceWithHost(element), attrs, { editable: () => false });
  });
}
