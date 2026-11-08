import { state } from './state';

/** Opening a page from the sidebar shows the whole workspace: its project filters go back to "all".
 * (A project's own Tasks or Library, opened from the tree, sets its filter after this.) */
export function applyScopeFilters() {
  state.taskProjectFilter = 'all';
  state.paperProjectFilter = 'all';
  state.calendarProjectFilter = 'all';
}
