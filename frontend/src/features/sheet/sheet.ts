/** Side panel for editing one record (task, event) next to the page, instead of a modal. */
import { state } from '../../app/state';

export type SheetHandle = {
  /** Asked before the panel closes or shows another record; false keeps it open. */
  beforeClose?: () => Promise<boolean>;
  cleanup?: () => void;
};
export type SheetSpec = {
  /** Same key: the record is already open, nothing to rebuild. */
  key: string;
  title: string;
  label: string;
  mount: (body: HTMLElement, sheet: { close: (force?: boolean) => Promise<boolean>; setTitle: (title: string) => void }) => SheetHandle | void;
  /** Opens the record full size in a new tab of the panel's pane; the panel closes first. */
  openInTab?: (pane: string) => void | Promise<void>;
  /** The editor pane the panel belongs to ("primary", "secondary"): it stays over that view, not over the whole window. Set by openSheet. */
  pane?: string;
};

// The panel opens in the pane the user was working in: the last element pressed or focused.
let lastTarget: Element | null = null;
if (typeof document !== 'undefined') {
  const remember = (event: Event) => { if (event.target instanceof Element) lastTarget = event.target; };
  document.addEventListener('pointerdown', remember, true);
  document.addEventListener('focusin', remember, true);
}

/** The editor pane holding `element`, or the focused pane. */
export function paneOf(element: Element | null | undefined): HTMLElement | null {
  const own = element?.closest<HTMLElement>('#main-content [data-workspace-pane]');
  if (own) return own;
  return document.querySelector<HTMLElement>(`#main-content [data-workspace-pane="${state.activeNotePane === 'secondary' ? 'secondary' : 'primary'}"]`);
}

let current: { spec: SheetSpec; handle: SheetHandle } | null = null;
const listeners = new Set<(spec: SheetSpec | null) => void>();

export function subscribeSheet(listener: (spec: SheetSpec | null) => void) {
  listeners.add(listener);
  listener(current?.spec || null);
  return () => { listeners.delete(listener); };
}

function emit(spec: SheetSpec | null) { listeners.forEach(listener => listener(spec)); }

export function currentSheet() { return current?.spec || null; }

/** Show a record in the side panel; the open one may ask to save first. */
export async function openSheet(spec: SheetSpec) {
  if (current?.spec.key === spec.key) return true;
  if (current && !await closeSheet()) return false;
  spec.pane = paneOf(lastTarget?.isConnected ? lastTarget : document.activeElement)?.dataset.workspacePane;
  current = { spec, handle: {} };
  emit(spec);
  return true;
}

export async function closeSheet(force = false) {
  if (!current) return true;
  if (!force && current.handle.beforeClose && !await current.handle.beforeClose()) return false;
  const closing = current;
  current = null;
  closing.handle.cleanup?.();
  emit(null);
  return true;
}

/** Called by the panel once its body exists. */
export function mountSheet(spec: SheetSpec, body: HTMLElement, setTitle: (title: string) => void) {
  if (current?.spec !== spec) return;
  current.handle = spec.mount(body, { close: closeSheet, setTitle }) || {};
}
