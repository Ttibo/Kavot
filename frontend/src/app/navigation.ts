import { refreshCanvasCollections } from '../features/collections/canvasCollections';
import { api } from '../services/api';
import { applyFontSizes } from './typography';
import { applyColors } from './colors';
import { flushReaderAutosave, main, setInterfaceTheme, state } from './state';
import { renderDatabaseCollection, renderSidebarCollections } from '../features/collections/catalog';
import { flushCurrentNoteAutosave, flushSecondaryNoteAutosave, flushWorkspaceMarkdownSaves, renderNotes } from '../features/documents/workspace';
import { flushCanvasSaves, refreshCanvasTemplatePresentation } from '../features/documents/canvas';
import { renderDashboard, renderProjects } from './viewActions';
import { showView } from './viewBridge';
import { renderPapers } from '../features/library/filters';
import { renderTasks } from '../features/tasks/actions';
import { renderCalendar } from '../features/calendar/actions';
import { renderConferences, renderDatasets } from '../features/research/actions';
import { renderSettings } from '../features/settings/actions';

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
  if (state.view === "dashboard") keys.add("dashboard");
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

export function setActiveNavigation(view) {
  document
    .querySelectorAll("[data-nav]")
    .forEach((button) =>
      button.classList.toggle("active", (button as HTMLElement).dataset.nav === view),
    );
}

export async function navigate(view, options: { preserveProjectContext?: boolean } = {}) {
  await flushCurrentNoteAutosave();
  await flushSecondaryNoteAutosave();
  await flushReaderAutosave();
  await flushWorkspaceMarkdownSaves();
  await flushCanvasSaves();
  if (view === "projects") view = "notes";
  if (view === "discovery") view = "papers";
  if (view === "article-watch") view = "watchers";
  const preserveProjectContext = options.preserveProjectContext === true;
  // Leaving for another view, or opening the Workspace itself, ends the project mode.
  if (!preserveProjectContext || view !== "notes") state.projectWorkspaceId = null;
  state.view = view;
  if (view !== "papers") state.libraryReadingPaperId = null;
  if (!preserveProjectContext) {
    state.selectedProject = null;
    state.taskProjectFilter = "all";
    state.paperProjectFilter = "all";
    state.conferenceProjectFilter = "all";
    state.datasetProjectFilter = "all";
    state.calendarProjectFilter = "all";
    state.paperProjectContext = null;
    if (view === "notes") {
      state.noteScope = "general";
      state.noteFolderId = "all";
      state.currentNoteId = null;
      state.primaryResource = null;
      state.secondaryResource = null;
      state.workspaceTabs.primary = [];
      state.workspaceTabs.secondary = [];
      state.workspaceActiveTabs.primary = null;
      state.workspaceActiveTabs.secondary = null;
      state.activeNotePane = "primary";
      state.expandedWorkspacePaths.add("notes/general");
    }
  }
  main.classList.remove(
    "reader-mode",
    "notes-mode",
    "tasks-mode",
    "calendar-mode",
    "overview-mode",
  );
  setActiveNavigation(view);
  // The React shell can be reconciling while a navigation command is handled.
  // Closing the mobile drawer is cosmetic, so it must never abort navigation
  // when the sidebar has briefly been detached.
  document.querySelector("#sidebar")?.classList.remove("open");
  if (view === "dashboard") state.dashboard = await api("/dashboard");
  render();
  (main as HTMLElement).focus();
}

export function render() {
  const renderers = {
    dashboard: renderDashboard,
    projects: renderProjects,
    papers: renderPapers,
    watchers: () => showView("watchers"),
    workflows: () => showView("workflows"),
    chat: () => showView("chat"),
    trash: () => showView("trash"),
    tasks: renderTasks,
    notes: renderNotes,
    calendar: renderCalendar,
    database: renderDatabaseCollection,
    conferences: renderConferences,
    datasets: renderDatasets,
    settings: renderSettings,
  };
  (renderers[state.view] || renderDashboard)();
}
