import { refreshCanvasCollections } from '../features/collections/canvasCollections';
import { api } from '../services/api';
import { applyFontSizes } from './typography';
import { applyColors } from './colors';
import { flushReaderAutosave, main, setInterfaceTheme, state, viewShown } from './state';
import { renderSidebarCollections } from '../features/collections/catalog';
import { flushCurrentNoteAutosave, flushSecondaryNoteAutosave, flushWorkspaceMarkdownSaves, renderNotes } from '../features/documents/workspace';
import { flushCanvasSaves, refreshCanvasTemplatePresentation } from '../features/documents/canvas';
import { publish } from './viewBridge';
import { applyScopeFilters } from './scope';
import { ensureEditor, openPage } from './tabs/pages';
import { canonicalView, isPage } from './pages';
import { openSettings } from '../features/settings/actions';

export function toast(message, type = "success") {
  const item = document.createElement("div");
  item.className = `toast ${type === "error" ? "error" : ""}`;
  item.textContent = message;
  document.querySelector("#toast-region").append(item);
  setTimeout(() => item.remove(), 3600);
}

const stateSources = {
  projects: "/projects",
  papers: "/papers",
  paperFolders: "/paper-folders",
  tasks: "/tasks",
  taskColumns: "/task-columns",
  conferences: "/conferences",
  datasets: "/datasets",
  notes: "/notes",
  noteFolders: "/note-folders",
  notePlacements: "/note-placements",
  noteTemplates: "/note-templates",
  noteScripts: "/note-scripts",
  databases: "/databases",
  workflows: "/workflows",
  dashboard: "/dashboard",
  workspaceTree: "/workspace/tree",
} as const;

type StateSource = keyof typeof stateSources;

let refreshing: Promise<void> | null = null;
let queuedRefresh: Promise<void> | null = null;

/** Reload every collection. Calls made during a reload share one follow-up reload. */
export function refreshData(): Promise<void> {
  if (!refreshing) {
    refreshing = loadAllData().finally(() => { refreshing = null; });
    return refreshing;
  }
  queuedRefresh ||= refreshing.catch(() => {}).then(() => {
    queuedRefresh = null;
    return refreshData();
  });
  return queuedRefresh;
}

/** Reload only the collections a mutation can change, instead of the whole workspace. */
export async function refreshState(sources: StateSource[]) {
  const keys = new Set<StateSource>(sources);
  if (viewShown("dashboard")) keys.add("dashboard");
  const loaded = await Promise.all([...keys].map(async (key) => [key, await api(stateSources[key])] as const));
  Object.assign(state, Object.fromEntries(loaded));
  if (keys.has("databases")) await loadDatabaseRecords(state.databases);
  refreshCanvasTemplatePresentation();
  refreshCanvasCollections();
  renderSidebarCollections();
}

async function loadDatabaseRecords(databases) {
  const recordEntries = await Promise.all(
    databases
      .filter((database) => database.storage?.driver === "json-files")
      .map(async (database) => {
        try {
          return [database.id, await api(`/databases/${database.id}/records`)];
        } catch (_) {
          return [database.id, []];
        }
      }),
  );
  state.databaseRecords = Object.fromEntries(recordEntries);
}

async function loadAllData() {
  const keys = Object.keys(stateSources) as StateSource[];
  const [preferences, ...values] = await Promise.all([
    api("/settings/preferences"),
    ...keys.map((key) => api(stateSources[key])),
  ]);
  Object.assign(state, Object.fromEntries(keys.map((key, index) => [key, values[index]])));
  state.theme = setInterfaceTheme(preferences?.theme, false);
  applyFontSizes(preferences?.font_sizes);
  applyColors(preferences);
  await loadDatabaseRecords(state.databases);
  applyScopeFilters();
  refreshCanvasTemplatePresentation();
  refreshCanvasCollections();
  renderSidebarCollections();
  state.projects.forEach((project) => {
    const readingKey = `project-readings:${project.id}`;
    if (!state.initializedReadingSpaces.has(readingKey)) {
      state.collapsedSpaces.add(readingKey);
      state.initializedReadingSpaces.add(readingKey);
    }
  });
}

/** The sidebar highlights the current view from the state: it only needs to redraw. */
export function setActiveNavigation(_view?) {
  publish();
}

/** Opens a page of the application as a tab of the editor (in the active tab, a new one, or the other pane),
 * or shows the editor itself (`notes`). Settings open in their window. */
export async function navigate(view, options: { preserveProjectContext?: boolean; newTab?: boolean; beside?: boolean } = {}) {
  await flushCurrentNoteAutosave();
  await flushSecondaryNoteAutosave();
  await flushReaderAutosave();
  await flushWorkspaceMarkdownSaves();
  await flushCanvasSaves();
  view = canonicalView(view);
  if (view === "settings") return openSettings();
  if (view !== "papers") state.libraryReadingPaperId = null;
  if (!options.preserveProjectContext) {
    state.selectedProject = null;
    // Pages open filtered on the project of the sidebar scope, or on the whole workspace.
    applyScopeFilters();
    state.paperProjectContext = null;
  }
  // The React shell can be reconciling while a navigation command is handled.
  // Closing the mobile drawer is cosmetic, so it must never abort navigation
  // when the sidebar has briefly been detached.
  document.querySelector("#sidebar")?.classList.remove("open");
  if (isPage(view)) {
    if (view === "dashboard") state.dashboard = await api("/dashboard");
    return openPage(view, { collectionId: view === "database" ? state.collectionId : undefined, newTab: options.newTab, beside: options.beside });
  }
  // The editor keeps its open tabs: the explorer of the sidebar opens documents into them.
  state.expandedWorkspacePaths.add("notes/general");
  render();
  (main as HTMLElement).focus();
}

/** Redraws the main area: the editor and its tabs (pages in tabs refresh with it). */
export function render() {
  ensureEditor();
  renderNotes();
}
