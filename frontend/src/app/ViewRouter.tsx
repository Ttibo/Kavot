import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { connectViews, type ViewName } from './viewBridge';
import { EmptyState } from '../components/common';
const DashboardView = lazy(() => import('../views/DashboardView').then(module => ({ default: module.DashboardView })));
const ProjectsView = lazy(() => import('../views/ProjectsView').then(module => ({ default: module.ProjectsView })));
const TasksView = lazy(() => import('../views/TasksView').then(module => ({ default: module.TasksView })));
const LibraryView = lazy(() => import('../views/LibraryView').then(module => ({ default: module.LibraryView })));
const ChatView = lazy(() => import('../views/ChatView').then(module => ({ default: module.ChatView })));
const WatchersView = lazy(() => import('../views/WatchersView').then(module => ({ default: module.WatchersView })));
const WorkflowsView = lazy(() => import('../views/WorkflowsView').then(module => ({ default: module.WorkflowsView })));
const CalendarView = lazy(() => import('../views/CalendarView').then(module => ({ default: module.CalendarView })));
const ConferencesView = lazy(() => import('../views/ResearchViews').then(module => ({ default: module.ConferencesView })));
const DatasetsView = lazy(() => import('../views/ResearchViews').then(module => ({ default: module.DatasetsView })));
const CollectionsView = lazy(() => import('../views/CollectionsView').then(module => ({ default: module.CollectionsView })));
const SettingsView = lazy(() => import('../views/SettingsView').then(module => ({ default: module.SettingsView })));
const TrashView = lazy(() => import('../views/TrashView').then(module => ({ default: module.TrashView })));
const views = { dashboard: DashboardView, projects: ProjectsView, tasks: TasksView, papers: LibraryView, watchers: WatchersView, workflows: WorkflowsView, chat: ChatView, calendar: CalendarView, conferences: ConferencesView, datasets: DatasetsView, database: CollectionsView, settings: SettingsView, trash: TrashView };
class ViewErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('View failed', error, info.componentStack); }
  render() { return this.state.error ? <EmptyState icon="!" title="Unable to display this view">{this.state.error}</EmptyState> : this.props.children; }
}
/** Explicit DOM ownership: React owns management views; the editor engine owns
 * its content only after the React view root has been unmounted. */
export function attachViewRouter(main: HTMLElement) {
  let root: Root | undefined;
  let current: ViewName | undefined;
  connectViews(view => {
    const View = views[view];
    const modes: Partial<Record<ViewName, string>> = { dashboard: 'overview-mode', tasks: 'tasks-mode', calendar: 'calendar-mode' };
    main.className = modes[view] || '';
    if (!root) { main.replaceChildren(); root = createRoot(main); }
    // Preserve local React state during data refreshes, reset it on navigation.
    if (current !== view) current = view;
    flushSync(() => root!.render(<ViewErrorBoundary key={view}><Suspense fallback={<p role="status">Loading…</p>}><View/></Suspense></ViewErrorBoundary>));
  }, () => {
    if (root) { flushSync(() => root!.unmount()); root = undefined; current = undefined; }
  });
}
