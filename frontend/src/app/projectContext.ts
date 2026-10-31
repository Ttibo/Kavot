import type { Runtime } from './runtime';

/** Resolve the project represented by the current view, including editor tabs. */
export function currentProject(runtime?: Runtime) {
  if (!runtime) return null;
  const { state } = runtime;
  const filters: Record<string, string> = {
    tasks: state.taskProjectFilter, papers: state.paperProjectFilter,
    conferences: state.conferenceProjectFilter, datasets: state.datasetProjectFilter,
    calendar: state.calendarProjectFilter,
  };
  const id = state.view === 'notes' ? state.selectedProject?.id || (state.noteScope.startsWith('project:') ? Number(state.noteScope.slice(8)) : null)
    : Number(filters[state.view || 'dashboard']);
  // Without a project of its own, the view belongs to the project of the sidebar scope.
  return state.projects.find(project => project.id === (id || state.scopeProjectId)) || null;
}
