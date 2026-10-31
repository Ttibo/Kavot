import { flushReaderAutosave, main, state } from '../../app/state';
import { applyWorkspaceTab, ensureWorkspaceTab, reloadNoteForOpen, workspaceNoteTab, expandWorkspacePathParents, findWorkspaceNode, flushCurrentNoteAutosave, flushSecondaryNoteAutosave, flushWorkspaceMarkdownSaves, renderNotes, replaceActiveWorkspaceTab, workspaceResourcePayload, workspaceResourceTab } from '../documents/workspace';
import { flushCanvasSaves } from '../documents/canvas';
import { navigate, refreshData, setActiveNavigation, toast } from '../../app/navigation';
import { setScope } from '../../app/scope';

export async function openProjectArea(projectId, area = "canvas") {
  const project = state.projects.find((item) => item.id === Number(projectId));
  if (!project) return;
  await flushCurrentNoteAutosave();
  await flushSecondaryNoteAutosave();
  await flushReaderAutosave();
  await flushWorkspaceMarkdownSaves();
  await flushCanvasSaves();
  state.selectedProject = project;
  if (area === "canvas" || area === "overview") {
    let node = findWorkspaceNode(project.canvas_path);
    if (!node) {
      await refreshData();
      node = findWorkspaceNode(state.projects.find((item) => item.id === project.id)?.canvas_path);
    }
    if (!node) return toast("The project canvas could not be found", "error");
    await flushCurrentNoteAutosave();
    await flushSecondaryNoteAutosave();
    await flushCanvasSaves();
    const resource = await workspaceResourcePayload(node);
    // Opening a project filters the interface on it; the canvas opens next to the documents already open.
    await setScope(project.id);
    state.view = "notes";
    state.selectedProject = null;
    ensureWorkspaceTab("primary", workspaceResourceTab(resource));
    applyWorkspaceTab("primary", workspaceResourceTab(resource));
    expandWorkspacePathParents(node.path);
    const projectDirectory = String(project.canvas_path || "").split("/")[1];
    state.expandedWorkspacePaths.add("notes");
    state.expandedWorkspacePaths.add("notes/projects");
    if (projectDirectory)
      state.expandedWorkspacePaths.add(`notes/projects/${projectDirectory}`);
    state.activeNotePane = "primary";
    main.classList.remove("reader-mode", "tasks-mode", "calendar-mode", "overview-mode");
    setActiveNavigation();
    renderNotes();
    (main as HTMLElement).focus();
  } else if (area === "atelier") {
    await openAtelier(project.id);
  } else if (area === "tasks") {
    state.taskProjectFilter = String(project.id);
    await navigate("tasks", { preserveProjectContext: true });
  } else if (area === "papers") {
    state.paperProjectFilter = String(project.id);
    await navigate("papers", { preserveProjectContext: true });
  } else if (area === "conferences") {
    state.conferenceProjectFilter = String(project.id);
    await navigate("conferences", { preserveProjectContext: true });
  } else if (area === "datasets") {
    state.datasetProjectFilter = String(project.id);
    await navigate("datasets", { preserveProjectContext: true });
  } else if (area === "calendar") {
    state.calendarProjectFilter = String(project.id);
    await navigate("calendar", { preserveProjectContext: true });
  }
}

export type AtelierSection = "project" | "code" | "agents" | "tasks";
const ATELIER_TITLES: Record<AtelierSection, string> = { project: "Atelier", code: "Code", agents: "Agents", tasks: "Tasks" };

/** A section of a project as an editor tab. Each linked folder of the Code section is a tab of its own. */
export function atelierResource(project: Project, section: AtelierSection = "project", folderId?: string) {
  const folder = section === "code" && folderId ? folderId : undefined;
  return { type: "atelier", path: `atelier/${project.id}/${section}${folder ? `/${folder}` : ""}`, title: `${ATELIER_TITLES[section]} · ${project.name}`, projectId: project.id, section, folderId: folder };
}

async function flushEditors() {
  await flushCurrentNoteAutosave();
  await flushSecondaryNoteAutosave();
  await flushReaderAutosave();
  await flushWorkspaceMarkdownSaves();
  await flushCanvasSaves();
}

function revealProject(project: Project) {
  const projectDirectory = String(project.canvas_path || "").split("/")[1];
  state.expandedWorkspacePaths.add("notes");
  state.expandedWorkspacePaths.add("notes/projects");
  if (projectDirectory) state.expandedWorkspacePaths.add(`notes/projects/${projectDirectory}`);
}

/** Opens a section of a project's Atelier as a tab of the Workspace editor, next to its notes and canvas. */
export async function openAtelier(projectId: number, section: AtelierSection = "project", pane?: "primary" | "secondary", options: { newTab?: boolean; folderId?: string } = {}) {
  const project = state.projects.find((item) => item.id === Number(projectId));
  if (!project) return toast("This project no longer exists", "error");
  await flushEditors();
  state.atelierProjectId = project.id;
  const tab = workspaceResourceTab(atelierResource(project, section, options.folderId));
  // A project section is a tab of the editor like any document: it opens next to the tabs already there.
  if (state.view !== "notes") {
    state.view = "notes";
    state.selectedProject = null;
    main.classList.remove("reader-mode", "tasks-mode", "calendar-mode", "overview-mode");
    setActiveNavigation();
  }
  const target = pane || (state.activeNotePane === "secondary" ? "secondary" : "primary");
  // Like any document: in the active tab, or in a new one (Ctrl/Cmd+click); into a given pane, as its own tab.
  if (pane || options.newTab) {
    ensureWorkspaceTab(target, tab);
    applyWorkspaceTab(target, tab);
  } else replaceActiveWorkspaceTab(target, tab);
  revealProject(project);
  renderNotes();
}

/** The pane next to `pane`: the Atelier opens notes, the canvas or another section there, side by side. */
const besidePane = (pane: string) => pane === "secondary" ? "primary" : "secondary";

export async function openAtelierBeside(projectId: number, section: AtelierSection, pane: string, folderId?: string) {
  await openAtelier(projectId, section, besidePane(pane), { folderId });
}

export async function openNoteBeside(noteId: number, pane: string) {
  await flushEditors();
  if (!await reloadNoteForOpen(noteId)) return;
  const tab = workspaceNoteTab(state.notes.find((item) => item.id === noteId));
  if (!tab) return;
  const target = besidePane(pane);
  ensureWorkspaceTab(target, tab);
  applyWorkspaceTab(target, tab);
  renderNotes();
}

export async function openCanvasBeside(projectId: number, pane: string) {
  const project = state.projects.find((item) => item.id === Number(projectId));
  const node = project && findWorkspaceNode(project.canvas_path);
  if (!node) return toast("The project canvas could not be found", "error");
  await flushEditors();
  const tab = workspaceResourceTab(await workspaceResourcePayload(node));
  const target = besidePane(pane);
  ensureWorkspaceTab(target, tab);
  applyWorkspaceTab(target, tab);
  renderNotes();
}

/** Shows another section (or project) in the same Atelier tab. */
export function switchAtelier(projectId: number, section: AtelierSection, pane: "primary" | "secondary") {
  const project = state.projects.find((item) => item.id === Number(projectId));
  if (!project) return;
  state.atelierProjectId = project.id;
  replaceActiveWorkspaceTab(pane, workspaceResourceTab(atelierResource(project, section)));
  revealProject(project);
  renderNotes();
}

/** Opens the project canvas in the active pane, staying in the project. */
export async function openProjectCanvas(projectId: number) {
  const project = state.projects.find((item) => item.id === Number(projectId));
  const node = project && findWorkspaceNode(project.canvas_path);
  if (!node) return toast("The project canvas could not be found", "error");
  await flushEditors();
  const pane = state.activeNotePane === "secondary" ? "secondary" : "primary";
  replaceActiveWorkspaceTab(pane, workspaceResourceTab(await workspaceResourcePayload(node)));
  renderNotes();
}
