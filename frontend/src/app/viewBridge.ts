export type ViewName = 'dashboard' | 'projects' | 'papers' | 'watchers' | 'workflows' | 'chat' | 'tasks' | 'calendar' | 'conferences' | 'datasets' | 'database' | 'settings' | 'trash';
type Renderer = (view: ViewName) => void;
let renderer: Renderer | undefined;
let editor: (() => void) | undefined;
let revision = 0;
const viewVersions: Partial<Record<ViewName, number>> = {};
export const viewVersion = (view: ViewName) => viewVersions[view] || 0;
const listeners = new Set<() => void>();
export const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const snapshot = () => revision;
export function publish() { revision++; listeners.forEach(listener => listener()); }
export function connectViews(render: Renderer, prepare: () => void) { renderer = render; editor = prepare; }
export function showView(view: ViewName) { viewVersions[view] = viewVersion(view) + 1; renderer?.(view); publish(); }
export function prepareEditor() { editor?.(); publish(); }
