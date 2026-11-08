/**
 * One shared MutationObserver tells editors when their element left the page.
 * Each editor watching document.body on its own multiplied the work done on every DOM change
 * (every keystroke in a rich editor mutates the DOM).
 */
const watched = new Map<Element, Set<() => void>>();
let observer: MutationObserver | null = null;

function check(records: MutationRecord[]) {
  if (!records.some(record => record.removedNodes.length)) return;
  for (const [element, callbacks] of watched) {
    if (element.isConnected) continue;
    watched.delete(element);
    callbacks.forEach(callback => callback());
  }
  if (!watched.size) { observer?.disconnect(); observer = null; }
}

/** Runs `callback` once, after `element` is removed from the document. Returns a cancel function. */
export function onDisconnect(element: Element, callback: () => void): () => void {
  let callbacks = watched.get(element);
  if (!callbacks) watched.set(element, callbacks = new Set());
  callbacks.add(callback);
  if (!observer) {
    observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
  }
  return () => {
    callbacks!.delete(callback);
    if (!callbacks!.size) watched.delete(element);
  };
}

/** Wraps `render` so calls made within one frame run it once, before the next paint. */
export function oncePerFrame(render: () => void): () => void {
  let frame = 0;
  return () => {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); });
  };
}
