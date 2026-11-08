import { flushCanvasSaves } from './saves';

// The side inspector (note preview and quick edit): its default and largest width, in pixels.
const INSPECTOR_WIDTH = 600, INSPECTOR_MAX_WIDTH = 960;
const INSPECTOR_WIDTH_KEY = "kavot-canvas-inspector-width-v2";

/** Binds the canvas side inspector: open/close toggle and the resizable width. */
export function bindCanvasInspector(container: HTMLElement, inspector: HTMLElement, renderMinimap: () => void) {
  const workbench = container.querySelector(".canvas-workbench") as HTMLElement;
  const resizeHandle = container.querySelector("[data-canvas-inspector-resizer]") as HTMLElement;
  const sidebarToggle = container.querySelector("[data-canvas-inspector-toggle]") as HTMLButtonElement;
  // A wide inspector by default: a note opened there can be read and edited without expanding it.
  // The key changed with the default, so widths saved for the former narrow panel no longer apply.
  const storedWidth = Number(localStorage.getItem(INSPECTOR_WIDTH_KEY));
  let preferredWidth = Number.isFinite(storedWidth) && storedWidth > 0 ? storedWidth : INSPECTOR_WIDTH;
  const resizeBounds = () => {
    const max = Math.min(INSPECTOR_MAX_WIDTH, workbench.clientWidth - Math.min(180, workbench.clientWidth * .35));
    return { min: Math.min(280, max), max };
  };
  const setInspectorWidth = (width: number, persist = false) => {
    const { min, max } = resizeBounds();
    const actual = Math.round(Math.max(min, Math.min(max, width)));
    container.style.setProperty("--canvas-inspector-width", `${actual}px`);
    resizeHandle.setAttribute("aria-valuemin", String(Math.round(min)));
    resizeHandle.setAttribute("aria-valuemax", String(Math.round(max)));
    resizeHandle.setAttribute("aria-valuenow", String(actual));
    if (persist) { preferredWidth = actual; localStorage.setItem(INSPECTOR_WIDTH_KEY, String(actual)); }
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
  resizeHandle.addEventListener("dblclick", () => { setInspectorWidth(INSPECTOR_WIDTH, true); renderMinimap(); });
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
  return { openInspector };
}
