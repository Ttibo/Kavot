/** Helpers shared by the global event handlers of the application (see index.ts). */
import { toast } from '../navigation';
import { flushCurrentNoteAutosave, flushSecondaryNoteAutosave, flushWorkspaceMarkdownSaves } from '../../features/documents/workspace';
import { flushCanvasSaves } from '../../features/documents/canvas';

/** A delegated handler: the element matched by its selector, and the event. */
export type Route<E extends Event = MouseEvent> = {
  selector: string;
  run: (element: HTMLElement, event: E) => unknown;
  /** The route is skipped (the next ones are tried) when this returns false. */
  when?: (element: HTMLElement, event: E) => boolean;
};

/** Runs the first route whose selector matches the event target (or one of its ancestors). */
export function dispatch<E extends Event>(routes: Route<E>[], event: E) {
  const target = event.target as Element | null;
  if (!target?.closest) return;
  for (const route of routes) {
    const element = target.closest<HTMLElement>(route.selector);
    if (element && (!route.when || route.when(element, event))) return route.run(element, event);
  }
}

export const idOrNull = (value: unknown) => Number(value || 0) || null;

export const showError = (error: unknown) => toast((error as Error).message, 'error');

export function removeClasses(selector: string, ...classes: string[]) {
  document.querySelectorAll(selector).forEach((item) => item.classList.remove(...classes));
}

/** Highlights a single element while dragging: only the previous and the new targets are touched, so a drag
 * over a long tree does not restyle every row on each dragover event. */
export function highlighter(className: string) {
  let current: Element | null = null;
  return {
    set(element: Element | null) {
      if (element === current) return;
      current?.classList.remove(className);
      element?.classList.add(className);
      current = element;
    },
    reset() { current = null; },
  };
}

/** The project of the notes layout an element is in. */
export const layoutProjectId = (element: Element) =>
  idOrNull(element.closest<HTMLElement>('.notes-layout')?.dataset.notesProject);

/** Opening a link or a note saves the notes being written first. */
export async function flushNoteEditors() {
  await flushCurrentNoteAutosave();
  await flushSecondaryNoteAutosave();
}

/** Moving or deleting documents saves every open editor first. */
export async function flushOpenEditors() {
  await flushNoteEditors();
  await flushWorkspaceMarkdownSaves();
  await flushCanvasSaves();
}

/** Ctrl/Cmd+click (or an explicit "new tab" command) opens in a new tab. */
export const wantsNewTab = (element: HTMLElement, event: MouseEvent) =>
  element.dataset.openInNewTab === 'true' || (event.button === 0 && (event.ctrlKey || event.metaKey));
