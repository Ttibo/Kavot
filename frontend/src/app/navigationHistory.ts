import { state, flushReaderAutosave, main } from './state';
import { subscribe } from './viewBridge';
import { render, setActiveNavigation, toast } from './navigation';
import { findWorkspaceNode, flushCurrentNoteAutosave, flushSecondaryNoteAutosave, flushWorkspaceMarkdownSaves, workspaceResourcePayload } from '../features/documents/workspace';
import { flushCanvasSaves } from '../features/documents/canvas';

// Keep navigation separate from document undo: never capture the data collections.
const keys = ['view', 'currentNoteId', 'selectedPaperId', 'libraryReadingPaperId',
  'noteScope', 'noteFolderId', 'collectionId', 'paperProjectContext',
  'taskProjectFilter', 'paperProjectFilter', 'conferenceProjectFilter',
  'datasetProjectFilter', 'calendarProjectFilter', 'primaryResource',
  'secondaryResource', 'workspaceTabs', 'workspaceActiveTabs', 'activeNotePane'] as const;

function capture(): Pick<typeof state, typeof keys[number]> & { projectId: number | null } {
  return structuredClone({ ...Object.fromEntries(keys.map(key => [key, state[key]])), projectId: state.selectedProject?.id ?? null }) as ReturnType<typeof capture>;
}
function identity(route: ReturnType<typeof capture>) {
  return JSON.stringify([route.view, route.projectId, route.currentNoteId,
    route.libraryReadingPaperId, route.collectionId, route.noteScope, route.noteFolderId,
    route.primaryResource?.path, route.secondaryResource?.path, route.workspaceActiveTabs]);
}

export function initializeNavigationHistory() {
  const session = crypto.randomUUID();
  let current = capture();
  let index = 0;
  let restoring = 0;
  let pending = Promise.resolve();
  const entry = () => ({ kavot: session, index, route: current });
  window.history.replaceState(entry(), '');

  subscribe(() => queueMicrotask(() => {
    if (restoring) return;
    const next = capture();
    const changed = identity(next) !== identity(current);
    current = next;
    if (changed) { index++; window.history.pushState(entry(), ''); }
    else window.history.replaceState(entry(), '');
  }));

  window.addEventListener('popstate', event => {
    if (event.state?.kavot !== session) return;
    const target = event.state;
    restoring++;
    pending = pending.then(async () => {
      try {
        await flushCurrentNoteAutosave();
        await flushSecondaryNoteAutosave();
        await flushReaderAutosave();
        await flushWorkspaceMarkdownSaves();
        await flushCanvasSaves();
        const route = structuredClone(target.route);
        // Read files again so Back never resurrects content saved before an edit.
        const resources = new Map();
        const refreshResource = async resource => {
          if (!resource?.path) return resource;
          if (!resources.has(resource.path)) {
            const node = findWorkspaceNode(resource.path);
            resources.set(resource.path, node ? await workspaceResourcePayload(node) : null);
          }
          return resources.get(resource.path);
        };
        for (const key of ['primaryResource', 'secondaryResource']) route[key] = await refreshResource(route[key]);
        for (const pane of ['primary', 'secondary']) {
          for (const tab of route.workspaceTabs[pane]) {
            if (tab.resource) tab.resource = await refreshResource(tab.resource);
          }
          route.workspaceTabs[pane] = route.workspaceTabs[pane].filter(tab => tab.type !== 'resource' || tab.resource);
        }
        const { projectId, ...values } = route;
        Object.assign(state, values);
        state.selectedProject = state.projects.find(project => project.id === projectId) || null;
        index = target.index;
        current = capture();
        setActiveNavigation(state.selectedProject ? 'projects' : state.view);
        main.classList.remove('reader-mode', 'notes-mode', 'tasks-mode', 'calendar-mode', 'overview-mode');
        render();
        main.focus();
      } catch (error) {
        window.history.replaceState(entry(), '');
        toast(error instanceof Error ? error.message : String(error), 'error');
      }
    }).finally(() => { queueMicrotask(() => { restoring--; }); });
  });

  document.addEventListener('keydown', event => {
    if (event.defaultPrevented) return;
    const back = event.key === 'BrowserBack' || (event.altKey && event.key === 'ArrowLeft');
    const forward = event.key === 'BrowserForward' || (event.altKey && event.key === 'ArrowRight');
    if (!back && !forward) return;
    event.preventDefault();
    if (back && index > 0) window.history.back();
    else if (forward) window.history.forward();
  });
}
