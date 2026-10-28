/** Side panel for editing one record (task, event) next to the page, instead of a modal. */

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
};

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
