import { flushReaderAutosave, main, state } from '../../app/state';
import { applyWorkspaceTab, ensureWorkspaceTab, expandWorkspacePathParents, findWorkspaceNode, flushCurrentNoteAutosave, flushSecondaryNoteAutosave, flushWorkspaceMarkdownSaves, renderNotes, workspaceResourcePayload, workspaceResourceTab } from '../documents/workspace';
import { flushCanvasSaves } from '../documents/canvas';
import { navigate, refreshData, setActiveNavigation, toast } from '../../app/navigation';

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
    // The canvas opens next to the documents already open.
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
  } else if (area === "tasks") {
    state.taskProjectFilter = String(project.id);
    await navigate("tasks", { preserveProjectContext: true });
  } else if (area === "papers") {
    state.paperProjectFilter = String(project.id);
    await navigate("papers", { preserveProjectContext: true });
  } else if (area === "calendar") {
    state.calendarProjectFilter = String(project.id);
    await navigate("calendar", { preserveProjectContext: true });
  }
}
