/** What an editor tab can hold, and how each kind presents itself (icon, label, the pane it draws).
 *
 * The editor engine (features/documents/workspace) draws notes, Markdown, canvases and PDF articles itself.
 * Every other kind is a React tab: the engine only draws a placeholder (`reactTabPane`), and `mount.tsx`
 * renders the component registered for that kind into it. To add a kind of tab: describe its resource here
 * (`reactTabKind` and `tabIcon`), and register its component in `mount.tsx`. See frontend/TABS.md. */
import { canonicalView, isPage, pages } from '../pages';

export type ReactTabKind = 'view' | 'atelier' | 'document';

const OFFICE_DOCUMENT = /\.(docx|xlsx|xlsm|pptx|csv|tsv)$/i;

/** The React kind of a tab's resource, or null when the editor engine draws it. */
export function reactTabKind(resource: any): ReactTabKind | null {
  if (resource?.type === 'view') return 'view';
  if (resource?.type === 'atelier') return 'atelier';
  const path = String(resource?.path || '');
  // Office files, tables, and PDF files that are not library articles (those open in the reader).
  if (OFFICE_DOCUMENT.test(path) || (/\.pdf$/i.test(path) && !Number(resource?.paperId || resource?.paper_id || 0))) return 'document';
  return null;
}

/** What the component of a React tab receives. */
function reactTabProps(kind: ReactTabKind, resource: any, pane: string) {
  if (kind === 'view') return { view: resource.view, collectionId: resource.collectionId || undefined };
  if (kind === 'atelier') return { projectId: Number(resource.projectId), section: resource.section || 'project', folder: resource.folderId || undefined, pane };
  return { path: String(resource.path), url: resource.url || `/api/workspace/file?path=${encodeURIComponent(resource.path)}` };
}

const attribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The placeholder of a React tab in a pane, or null for the kinds the editor engine draws. */
export function reactTabPane(resource: any, pane: string): string | null {
  const kind = reactTabKind(resource);
  if (!kind) return null;
  const props = attribute(JSON.stringify(reactTabProps(kind, resource, pane)));
  return `<section class="secondary-resource-pane react-tab-pane" data-${pane}-path="${attribute(String(resource.path || ''))}" data-pane-drop="${pane}">`
    + `<div class="react-tab" data-tab-kind="${kind}" data-tab-props="${props}"></div></section>`;
}

const ATELIER_ICONS: Record<string, string> = { project: 'home', code: 'code', agents: 'agents', tasks: 'tasks' };

/** The label of a tab in the tab bar. */
export function tabLabel(tab: any, notes: any[] = []): string {
  if (tab?.type === 'empty') return 'New tab';
  if (tab?.type === 'note') return notes.find(note => note.id === Number(tab.noteId))?.title || 'Note';
  return tab?.resource?.title || tab?.resource?.path?.split('/').pop() || 'Document';
}

/** The icon of a tab in the tab bar. */
export function tabIcon(tab: any, notes: any[] = []): string {
  if (tab?.type === 'note') return notes.find(note => note.id === Number(tab.noteId))?.drawing ? 'canvas' : 'notes';
  const resource = tab?.resource;
  if (resource?.type === 'view') return isPage(resource.view) ? pages[resource.view].icon : 'panel';
  if (resource?.type === 'atelier') return ATELIER_ICONS[resource.section] || 'code';
  return resource?.type === 'canvas' ? 'canvas' : 'notes';
}

/** The title of the page a view resource shows: a custom collection is named after itself. */
export function viewTitle(view: string, collectionName?: string) {
  const id = canonicalView(view);
  if (id === 'database' && collectionName) return collectionName;
  return isPage(id) ? pages[id].title : id;
}
