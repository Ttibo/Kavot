import { Component, lazy, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import { EmptyState } from '../components/common';
import type { PageId } from './pages';

/** The component of each page (see pages.ts), loaded when its first tab opens. */
const load = <K extends string>(loader: () => Promise<Record<K, ComponentType<any>>>, name: K) =>
  lazy(() => loader().then(module => ({ default: module[name] })));

export const pageComponents: Record<PageId, ComponentType<any>> = {
  dashboard: load(() => import('../views/DashboardView'), 'DashboardView'),
  chat: load(() => import('../views/ChatView'), 'ChatView'),
  tasks: load(() => import('../views/TasksView'), 'TasksView'),
  calendar: load(() => import('../views/CalendarView'), 'CalendarView'),
  watchers: load(() => import('../views/WatchersView'), 'WatchersView'),
  workflows: load(() => import('../views/WorkflowsView'), 'WorkflowsView'),
  papers: load(() => import('../views/LibraryView'), 'LibraryView'),
  conferences: load(() => import('../views/ResearchViews'), 'ConferencesView'),
  datasets: load(() => import('../views/ResearchViews'), 'DatasetsView'),
  database: load(() => import('../views/CollectionsView'), 'CollectionsView'),
  trash: load(() => import('../views/TrashView'), 'TrashView'),
};

export class PageErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('View failed', error, info.componentStack); }
  render() { return this.state.error ? <EmptyState icon="!" title="Unable to display this view">{this.state.error}</EmptyState> : this.props.children; }
}
