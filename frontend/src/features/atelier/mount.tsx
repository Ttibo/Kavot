import type { Root } from 'react-dom/client';

/** The editor engine draws placeholders in its panes (Atelier, documents) and in the project sidebar; each gets its own
 * React root. Elements kept across a redraw keep their root; roots of removed ones are unmounted. */
const roots = new Map<HTMLElement, Root | null>();
let modules: Promise<[typeof import('react-dom/client'), typeof import('./AtelierPane'), typeof import('./ProjectSidebar'), typeof import('./WorkspaceDocument')]> | null = null;

function sync(container: HTMLElement) {
  for (const [host, root] of roots) {
    if (host.isConnected) continue;
    roots.delete(host);
    // Unmounting during the editor's own render would warn; defer it.
    if (root) setTimeout(() => root.unmount());
  }
  container.querySelectorAll<HTMLElement>('.atelier-host, .atelier-sidebar-host, .atelier-document-host').forEach(host => {
    if (roots.has(host)) return;
    roots.set(host, null);
    modules ||= Promise.all([import('react-dom/client'), import('./AtelierPane'), import('./ProjectSidebar'), import('./WorkspaceDocument')]);
    void modules.then(([{ createRoot }, { AtelierPane }, { ProjectSidebar }, { WorkspaceDocument }]) => {
      if (!host.isConnected || roots.get(host) !== null) return;
      const root = createRoot(host);
      roots.set(host, root);
      const projectId = Number(host.dataset.atelierProject);
      root.render(host.classList.contains('atelier-document-host') ? <WorkspaceDocument path={host.dataset.documentPath || ''} url={host.dataset.documentUrl || ''}/>
        : host.classList.contains('atelier-sidebar-host') ? <ProjectSidebar projectId={projectId}/>
        : <AtelierPane projectId={projectId} section={(host.dataset.atelierSection || 'project') as any}
            pane={host.dataset.atelierPane === 'secondary' ? 'secondary' : 'primary'}/>);
    });
  });
}

export function watchAtelierHosts(container: HTMLElement) {
  new MutationObserver(() => sync(container)).observe(container, { childList: true, subtree: true });
  sync(container);
}
