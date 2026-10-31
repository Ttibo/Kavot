import type { PageId } from './pages';

/** The editor engine and the React components share the state; this tells the components it changed. */
let revision = 0;
const listeners = new Set<() => void>();
export const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const snapshot = () => revision;
export function publish() { revision++; listeners.forEach(listener => listener()); }

/** A page asked to reload its data (its calendar, its dashboard): the tabs showing it refresh. */
const pageVersions: Partial<Record<PageId, number>> = {};
export const viewVersion = (page: PageId) => pageVersions[page] || 0;
export function showView(page: PageId) { pageVersions[page] = viewVersion(page) + 1; publish(); }

/** Before the editor engine redraws the main area. */
export function prepareEditor() { publish(); }
