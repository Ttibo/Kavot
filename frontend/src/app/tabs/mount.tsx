import type { ComponentType } from 'react';
import type { Root } from 'react-dom/client';
import type { ReactTabKind } from './kinds';
import '../../styles/components/tabs.css';

/** The component each React tab kind renders (see kinds.ts), loaded with its first tab. */
const components: Record<ReactTabKind, () => Promise<ComponentType<any>>> = {
  view: () => import('../../components/PaneView').then(module => module.PaneView),
  atelier: () => import('../../features/atelier/AtelierPane').then(module => module.AtelierPane),
  document: () => import('../../features/atelier/WorkspaceDocument').then(module => module.WorkspaceDocument),
};

/** The editor engine redraws its panes; each React tab placeholder gets its own root. A placeholder kept across
 * a redraw keeps its root (and the state of its component); roots of removed ones are unmounted. */
const roots = new Map<HTMLElement, Root | null>();
let client: Promise<typeof import('react-dom/client')> | null = null;

function sync(container: HTMLElement) {
  for (const [host, root] of roots) {
    if (host.isConnected) continue;
    roots.delete(host);
    // Unmounting during the editor's own render would warn; defer it.
    if (root) setTimeout(() => root.unmount());
  }
  container.querySelectorAll<HTMLElement>('.react-tab').forEach(host => {
    if (roots.has(host)) return;
    roots.set(host, null);
    const kind = host.dataset.tabKind as ReactTabKind;
    const load = components[kind];
    if (!load) return console.error(`Unknown tab kind: ${kind}`);
    client ||= import('react-dom/client');
    void Promise.all([client, load()]).then(([{ createRoot }, Tab]) => {
      if (!host.isConnected || roots.get(host) !== null) return;
      const root = createRoot(host);
      roots.set(host, root);
      root.render(<Tab {...JSON.parse(host.dataset.tabProps || '{}')}/>);
    });
  });
}

export function watchReactTabs(container: HTMLElement) {
  new MutationObserver(() => sync(container)).observe(container, { childList: true, subtree: true });
  sync(container);
}
