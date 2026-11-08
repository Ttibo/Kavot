/** The pages of the application. Every page opens as a tab of the editor, never over the whole window.
 *
 * To add a page: give it an entry here, its component in `pageComponents.tsx`, and (if it belongs in the
 * navigation) a row in the sidebar. Titles, icons, the tab bar, the new-tab launcher, the agent context
 * and navigation all read this registry. See frontend/TABS.md. */

export type PageId = 'papers' | 'chat' | 'terminal' | 'tasks' | 'calendar' | 'trash';

export type Page = {
  title: string;
  icon: string;
  /** Layout class the page's container gets (full-height boards, the home grid). */
  layout?: string;
  /** Offered by the new-tab launcher, in this order. */
  launcher?: number;
};

export const pages: Record<PageId, Page> = {
  papers: { title: 'Library', icon: 'papers', launcher: 1 },
  chat: { title: 'Agents', icon: 'agents', launcher: 2 },
  // The agent CLIs in a terminal, with all their own options (advanced; opened from the Agents page).
  terminal: { title: 'Terminal', icon: 'code', launcher: 5 },
  tasks: { title: 'Tasks', icon: 'tasks', layout: 'tasks-mode', launcher: 3 },
  calendar: { title: 'Calendar', icon: 'calendar', layout: 'calendar-mode', launcher: 4 },
  trash: { title: 'Trash', icon: 'trash' },
};

export const isPage = (id: unknown): id is PageId => typeof id === 'string' && Object.hasOwn(pages, id);

/** Older names a link or a saved session may still use. */
const aliases: Record<string, string> = {
  agents: 'chat', discovery: 'papers', 'article-watch': 'papers', watchers: 'papers',
  projects: 'notes', dashboard: 'notes', workflows: 'notes', conferences: 'notes', datasets: 'notes', database: 'notes',
};
export const canonicalView = (view: string) => aliases[view] || view;

export const launcherPages = (Object.keys(pages) as PageId[])
  .filter(id => pages[id].launcher).sort((a, b) => pages[a].launcher! - pages[b].launcher!);
