import { state } from './state';
import { publish } from './viewBridge';
import { render } from './navigation';
import { rerenderWorkspaceTree } from '../features/documents/workspace';

/** The project the interface is filtered on, if it still exists and is not archived. */
export function scopeProject(): Project | null {
  return state.projects.find((project: Project) => project.id === state.scopeProjectId && project.status !== 'archived') || null;
}

/** Every per-view project filter follows the scope: the whole workspace, or one project. */
export function applyScopeFilters() {
  if (state.scopeProjectId && state.projects.length && !scopeProject()) setStoredScope(null);
  const value = state.scopeProjectId ? String(state.scopeProjectId) : 'all';
  state.taskProjectFilter = value;
  state.paperProjectFilter = value;
  state.conferenceProjectFilter = value;
  state.datasetProjectFilter = value;
  state.calendarProjectFilter = value;
}

function setStoredScope(projectId: number | null) {
  state.scopeProjectId = projectId;
  try {
    if (projectId) localStorage.setItem('kavot-scope-project', String(projectId));
    else localStorage.removeItem('kavot-scope-project');
  } catch { /* The scope then lasts for this session only. */ }
}

/** Filters the interface on a project (or the whole workspace) and redraws what it changes. */
export function setScope(projectId: number | null) {
  if (state.scopeProjectId === projectId) return;
  setStoredScope(projectId);
  applyScopeFilters();
  // The editor keeps its tabs: only the explorer changes. Other views are filtered again.
  rerenderWorkspaceTree();
  if (state.view !== 'notes') render();
  publish();
}
