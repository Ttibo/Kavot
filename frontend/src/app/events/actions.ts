/** Commands of `data-action` buttons, wherever they are (trees, pages, dialogs, context menus). */
import { state } from '../state';
import { navigate, refreshData, toast } from '../navigation';
import { api } from '../../services/api';
import { closeModal } from '../../components/dialogs/controller';
import { openSettings } from '../../features/settings/actions';
import { addProjectResourceModal, editProjectModal, newProjectModal } from '../../features/projects/dialogs';
import { newTaskModal, taskArchivesModal, taskColumnModal } from '../../features/tasks/dialogs';
import { activeNoteFolderId, activeNoteProjectId } from '../../features/documents/workspace';
import { addProjectPaperModal, createNewCanvas, createNewDrawing, createNewNote, createNoteFolder, noteSettingsModal } from '../../features/documents/dialogs';
import { renderPapers } from '../../features/library/filters';
import { editPaperMetadataModal, editPaperModal, openPaper, paperFolderModal, paperPdfUploadModal, paperReferencesModal } from '../../features/library/documents';
import { idOrNull, showError } from './shared';

type Action = (source: HTMLElement | undefined, projectId: number | null) => unknown;

/** The project new notes, drawings and folders go to: none for the general workspace. */
const creationProject = (source: HTMLElement | undefined, projectId: number | null, fallback = 0) =>
  source?.dataset.generalContext ? null : projectId || fallback || activeNoteProjectId();

/** In the Library, an article opens in its reader; elsewhere, in the editor. */
function readInLibrary(source: HTMLElement | undefined, projectId: number | null) {
  if (!source?.closest('.library-workspace')) return false;
  state.libraryReadingPaperId = Number(source.dataset.paperId);
  state.paperProjectContext = projectId;
  renderPapers();
  return true;
}

async function updateProjectStatus(projectId: number, status: 'archived' | 'active') {
  await api(`/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify({ status }) });
  await refreshData();
}

async function openProjectResource(target: string | undefined) {
  if (!target) return;
  if (window.pywebview?.api?.open_project_resource) {
    if (!(await window.pywebview.api.open_project_resource(target))) throw new Error('This resource could not be opened');
  } else if (/^https?:\/\//i.test(target)) {
    window.open(target, '_blank', 'noopener,noreferrer');
  } else {
    throw new Error('Local folders can be opened from the Kavot desktop app');
  }
}

const actions: Record<string, Action> = {
  'new-project': () => newProjectModal(),
  'edit-project': (_, projectId) => editProjectModal(projectId),
  'add-project-resource': (_, projectId) => addProjectResourceModal(projectId),
  'open-project-resource': (source) => openProjectResource(source?.dataset.resourceTarget).catch(showError),
  'archive-project': async (_, projectId) => {
    if (!projectId || !confirm('Archive this project?')) return;
    try {
      await updateProjectStatus(projectId, 'archived');
      if (state.view !== 'settings') await navigate('notes');
      toast('Project archived. Find it in Settings › Archive.');
    } catch (error) { showError(error); }
  },
  'unarchive-project': async (_, projectId) => {
    if (!projectId) return;
    try {
      await updateProjectStatus(projectId, 'active');
      toast('Project restored from the archive');
    } catch (error) { showError(error); }
  },
  'delete-project': async (_, projectId) => {
    if (!projectId || !confirm('Move this project, its tasks and its notes to the trash? Shared articles will be kept.')) return;
    try {
      await api(`/projects/${projectId}`, { method: 'DELETE' });
      await refreshData();
      if (state.view !== 'settings') await navigate('notes');
      window.dispatchEvent(new Event('kavot:projects-trashed'));
      toast('Project moved to the trash. You can restore it in Settings › Archive.');
    } catch (error) { showError(error); }
  },
  'load-demo': async () => {
    try {
      await api('/demo', { method: 'POST' });
      await refreshData();
      await navigate('notes');
      toast('Demo workspace loaded');
    } catch (error) { showError(error); }
  },
  'manage-templates': () => openSettings('templates'),

  // Articles.
  'paper-references': (source) => paperReferencesModal(Number(source?.dataset.paperId)),
  'add-paper-pdf': (source) => paperPdfUploadModal(Number(source?.dataset.paperId)),
  'open-paper-pdf': async (source, projectId) => {
    try {
      if (!readInLibrary(source, projectId)) await openPaper(Number(source?.dataset.paperId), projectId);
    } catch (error) { showError(error); }
  },
  'open-paper-workspace': (source, projectId) => readInLibrary(source, projectId)
    || openPaper(Number(source?.dataset.paperId), projectId, { withNote: source?.dataset.withNote !== 'false' }),
  'open-paper-modal-note': async (source, projectId) => {
    try {
      await closeModal();
      await openPaper(Number(source?.dataset.paperId), projectId);
    } catch (error) { showError(error); }
  },
  'add-project-paper': (_, projectId) => addProjectPaperModal(projectId),
  'edit-paper': (source) => editPaperModal(Number(source?.dataset.paperId)),
  'edit-paper-metadata': (source) => editPaperMetadataModal(Number(source?.dataset.paperId)),
  'new-paper-folder': (source) => paperFolderModal(null, idOrNull(source?.dataset.parentPaperFolderId)),
  'edit-paper-folder': (source) => paperFolderModal(Number(source?.dataset.paperFolderId)),
  'reset-paper-filters': () => {
    state.paperSearch = '';
    if (!state.selectedProject) state.paperProjectFilter = 'all';
    state.paperStatusFilter = '';
    state.paperYearFilter = 'all';
    state.paperFolderFilter = 'all';
    state.paperPage = 1;
    renderPapers();
  },

  // Tasks.
  'new-task': (source, projectId) => newTaskModal(projectId, idOrNull(source?.dataset.columnId)),
  'edit-task': (source) => newTaskModal(null, null, Number(source?.dataset.taskId)),
  'new-column': () => taskColumnModal(),
  'edit-column': (source) => taskColumnModal(Number(source?.dataset.columnId)),
  'task-archives': () => taskArchivesModal(),

  // Documents of the vault.
  'new-note': (source, projectId) => {
    const target = creationProject(source, projectId);
    return createNewNote(target, idOrNull(source?.dataset.paperId), idOrNull(source?.dataset.folderId) || activeNoteFolderId(target));
  },
  'new-drawing': (source, projectId) => {
    const target = creationProject(source, projectId);
    return createNewDrawing(target, idOrNull(source?.dataset.folderId) || activeNoteFolderId(target));
  },
  'new-canvas': (source) => createNewCanvas(idOrNull(source?.dataset.folderId)),
  'new-folder': (source, projectId) => {
    const parent = source?.dataset.parentFolderId === 'root' ? 'root' : idOrNull(source?.dataset.parentFolderId);
    return createNoteFolder(creationProject(source, projectId), parent);
  },
  'edit-note': (source) => noteSettingsModal(
    Number(source?.dataset.noteId),
    idOrNull(source?.dataset.noteProject),
    idOrNull(source?.closest<HTMLElement>('.notes-layout')?.dataset.notesProject),
  ),
};

export async function handleAction(action: string | undefined, source?: HTMLElement) {
  const run = action ? actions[action] : undefined;
  if (!run) return;
  await run(source, idOrNull(source?.dataset.projectId || state.selectedProject?.id));
}
