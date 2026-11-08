/**
 * Live blocks stored as inert HTML inside a note:
 * - script blocks (HTML/CSS/JS) run in an isolated, opaque-origin iframe.
 * The document only keeps data attributes and <pre> text, so exported files stay inert.
 */
import "../../../styles/features/embeds.css";
import { mountScript } from "./scriptBlock";
import { scriptFromElement } from "./scriptRuntime";

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
  // Collection views were retired: an old one is left out of the reading view.
  container.querySelectorAll<HTMLElement>('div[data-type="collection-view"]').forEach(element => element.remove());
}
