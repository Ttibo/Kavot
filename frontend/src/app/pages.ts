/** The pages of the application. Every page opens as a tab of the editor, never over the whole window.
 *
 * To add a page: give it an entry here, its component in `pageComponents.tsx`, and (if it belongs in the
 * navigation) a row in the sidebar. Titles, icons, the tab bar, the new-tab launcher, the agent context
 * and navigation all read this registry. See frontend/TABS.md. */

export type PageId = 'dashboard' | 'chat' | 'tasks' | 'calendar' | 'watchers' | 'workflows'
  | 'papers' | 'conferences' | 'datasets' | 'database' | 'trash';

export type Page = {
  title: string;
  icon: string;
  /** Layout class the page's container gets (full-height boards, the home grid). */
  layout?: string;
  /** Offered by the new-tab launcher, in this order. */
  launcher?: number;
};

export const pages: Record<PageId, Page> = {
  dashboard: { title: 'Home', icon: 'home', layout: 'overview-mode', launcher: 1 },
  chat: { title: 'Agents', icon: 'agents', launcher: 2 },
  tasks: { title: 'Tasks', icon: 'tasks', layout: 'tasks-mode', launcher: 3 },
  calendar: { title: 'Calendar', icon: 'calendar', layout: 'calendar-mode', launcher: 4 },
  watchers: { title: 'Watchers', icon: 'sparkle' },
  workflows: { title: 'Workflows', icon: 'workflow' },
  papers: { title: 'Library', icon: 'papers', launcher: 5 },
  conferences: { title: 'Conferences', icon: 'conferences' },
  datasets: { title: 'Datasets', icon: 'database' },
  // A custom collection: one page per collection, named after it.
  database: { title: 'Collection', icon: 'database' },
  trash: { title: 'Trash', icon: 'trash' },
};

export const isPage = (id: unknown): id is PageId => typeof id === 'string' && Object.hasOwn(pages, id);

/** Older names a link or a saved session may still use. */
const aliases: Record<string, string> = { discovery: 'papers', 'article-watch': 'watchers', projects: 'notes' };
export const canonicalView = (view: string) => aliases[view] || view;

export const launcherPages = (Object.keys(pages) as PageId[])
  .filter(id => pages[id].launcher).sort((a, b) => pages[a].launcher! - pages[b].launcher!);
