import { Suspense } from 'react';
import { useRuntime } from '../app/runtime';
import { isPage, pages } from '../app/pages';
import { PageErrorBoundary, pageComponents } from '../app/pageComponents';

/** A page of the application in an editor tab (see app/pages.ts). */
export function PaneView({ view, collectionId }: { view: string; collectionId?: string }) {
  useRuntime();
  if (!isPage(view)) return null;
  const Page = pageComponents[view];
  return <div className={`pane-view ${pages[view].layout || ''}`} data-pane-view={view}>
    <PageErrorBoundary key={`${view}:${collectionId || ''}`}><Suspense fallback={<p role="status">Loading…</p>}>
      <Page {...(view === 'database' ? { collectionId } : {})}/>
    </Suspense></PageErrorBoundary>
  </div>;
}
