import type { Runtime } from '../../app/runtime';
import { currentProject } from '../../app/projectContext';
import { pages } from '../../app/pages';
import { findWorkspaceNode } from '../documents/workspace';

const contexts = new Map<Element, () => Record<string, any>>();
// A suggestion made while no conversation is on screen waits for the Agents view it opens.
let pendingSuggestion: string | null = null;
export function takePendingSuggestion() {
  const text = pendingSuggestion;
  pendingSuggestion = null;
  return text;
}
export function suggestToAgent(text: string) {
  if (document.querySelector('.agent-compose')) {
    window.dispatchEvent(new CustomEvent('kavot:assistant-suggestion', { detail: { text } }));
    return;
  }
  pendingSuggestion = text;
  void import('../../app/tabs/pages').then(module => module.openPage('chat', { beside: true }));
}
export function registerAgentContext(element: Element, read: () => Record<string, any>) {
  for (const owner of contexts.keys()) if (!owner.isConnected) contexts.delete(owner);
  contexts.set(element, read);
  return () => { contexts.delete(element); };
}

// What the agent is told the user is looking at: a page of the registry, or an area inside one.
const viewNames: Record<string, string> = {
  ...Object.fromEntries(Object.entries(pages).map(([id, page]) => [id, page.title])),
  project: 'Research Hub', canvas: 'Canvas', notes: 'Notes and editor', reader: 'Lecteur PDF', citations: 'Graphe de citations',
};
export const suggestions: Record<string, string[]> = {
  dashboard: ['Where do I stand on my active projects?', 'Which reading or task should I pick up?'],
  projects: ['Compare the progress of my projects.', 'Which projects lack sources or a next step?'],
  project: ['Summarize the findings and limitations of this project with their sources.', 'Suggest a reading plan and next steps.'],
  canvas: ['Question this card: what do my other notes and articles say about it?', 'Explain this relation and its direction.', 'Compare these findings and their sources.', 'Write a synthesis in the open note.'],
  notes: ['Summarize this note with its references.', 'Suggest a rewording of the selected passage and keep the rest.'],
  papers: ['Compare the displayed articles and their limitations.', 'Find duplicates and gaps in this collection.'],
  reader: ['Explain the method and limitations with the PDF page numbers.', 'Suggest a sourced enrichment of the reading note.'],
  citations: ['Analyze the graph pack with its abstracts: findings, methods, limitations and references.', 'Retrieve the articles related to the selected reference and justify five relevant readings.', 'Find relevant articles for this question: '],
  tasks: ['Break this research down into verifiable tasks with a completion criterion.', 'Suggest priorities for the displayed tasks.'],
  calendar: ['Detect conflicts between these deadlines.', 'Suggest a realistic reading and writing schedule.'],
  datasets: ['Compare the coverage, format, license and limitations of the datasets.', 'Which dataset fits the project’s question?'],
  conferences: ['Compare the relevant conferences and check the deadlines on their official websites.', 'Suggest a list of possible submissions.'],
  database: ['Synthesize the displayed records with their references.', 'Suggest an update that follows the collection’s fields.'],
};

let selection: { note_id: number | null; text: string } | null = null;
document.addEventListener('selectionchange', () => {
  const selected = window.getSelection();
  if (!selected?.toString() && document.activeElement?.closest('#main-content')) selection = null;
  if (selected?.toString() && selected.anchorNode?.parentElement?.closest('#main-content')) {
    const pane = selected.anchorNode.parentElement.closest('[data-primary-note-id], [data-secondary-note-id], [data-agent-note-id]');
    const source = selected.anchorNode.parentElement.closest('.note-editor, .library-reader-note')?.querySelector<HTMLTextAreaElement>('textarea');
    selection = { note_id: Number(pane?.getAttribute('data-secondary-note-id') || pane?.getAttribute('data-primary-note-id') || (pane as HTMLElement)?.dataset.agentNoteId || source?.dataset.agentNoteId) || null,
      text: selected.toString().slice(0, 20000) };
  }
});

type Pane = 'primary' | 'secondary';
const activeTab = (state: any, pane: Pane) => state?.workspaceTabs?.[pane]?.find((tab: any) => tab.id === state.workspaceActiveTabs?.[pane]);
const isAgentsTab = (tab: any) => tab?.resource?.type === 'view' && tab.resource.view === 'chat';

/** The pane the user works in. Talking from the Agents tab, it is the window open beside it: its note,
 * canvas or page is what the request is about. */
function documentPane(state: any): Pane {
  const focused: Pane = state?.activeNotePane === 'secondary' && state.workspaceTabs?.secondary?.length ? 'secondary' : 'primary';
  const other: Pane = focused === 'primary' ? 'secondary' : 'primary';
  return isAgentsTab(activeTab(state, focused)) && activeTab(state, other) ? other : focused;
}

/** The project a tab belongs to: the note's, the canvas's, the project section's. */
function tabProject(state: any, tab: any): number | null {
  if (tab?.type === 'note') return state.notes.find((note: any) => note.id === Number(tab.noteId))?.project_id || null;
  const resource = tab?.resource;
  if (resource?.type === 'atelier') return Number(resource.projectId) || null;
  if (resource?.path) return state.projects.find((project: any) => project.canvas_path === resource.path)?.id
    || Number(findWorkspaceNode(resource.path)?.creation_context?.project_id || findWorkspaceNode(resource.path)?.project_id) || null;
  return null;
}

export function captureAgentContext(runtime?: Runtime) {
  const state = runtime?.state;
  const pane = documentPane(state);
  const tab = activeTab(state, pane);
  const active = tab?.resource || null;
  // A page open in that pane (Library, Tasks…) is the view the user is in; a note or a file, the editor.
  const view = state?.view === 'notes' ? (active?.type === 'view' ? active.view : active?.type === 'atelier' ? 'project' : 'notes') : state?.view || 'dashboard';
  let noteId: number | null = tab?.type === 'note' ? Number(tab.noteId) || null : null;
  // Atelier and page tabs are not files: they give their own context (registerAgentContext, the view below).
  const isFile = (resource: any) => resource?.path && !['atelier', 'view'].includes(resource.type);
  const resourcePath = view === 'notes' && isFile(active) ? active.path : null;
  const openDocuments: Record<string, any>[] = [];
  const addDocument = (detail: Record<string, any>) => {
    if (detail.note_id || detail.paper_id || detail.resource_path || detail.url) openDocuments.push(detail);
  };
  for (const side of ['primary', 'secondary']) {
    for (const item of state?.workspaceTabs?.[side] || []) {
      if (item.type !== 'note' && !isFile(item.resource)) continue;
      addDocument(item.type === 'note' ? { note_id: item.noteId, pane: side } : {
        resource_path: item.resource?.path, paper_id: item.resource?.paperId, title: item.resource?.title, pane: side,
      });
    }
  }
  // Components on screen describe what they show (the canvas selection, the reader's article, the Atelier);
  // the one in the document pane describes the request's subject.
  let extension: Record<string, any> = {};
  for (const [element, read] of contexts) {
    if (!element.isConnected) { contexts.delete(element); continue; }
    if (element.closest('[hidden]') || !element.getClientRects().length) continue;
    const detail = read();
    addDocument({ note_id: detail.note_id, paper_id: detail.paper_id, resource_path: detail.resource_path, url: detail.document_url, title: detail.document_title });
    const inPane = element.closest<HTMLElement>('[data-workspace-pane]')?.dataset.workspacePane;
    if (!inPane || inPane === pane) extension = { ...extension, ...detail };
  }
  if (extension.note_id) noteId = extension.note_id;
  addDocument({ note_id: noteId, resource_path: resourcePath, paper_id: extension.paper_id || (view === 'papers' ? state?.libraryReadingPaperId : null), active: true });
  const area = extension.area || (resourcePath?.endsWith('.canvas') ? 'canvas' : view);
  // The project of what is open (a project canvas, a project note) gives the request its project context.
  const ownProject = Number(extension.project_id) || (state ? tabProject(state, tab) : null);
  const project = state?.projects.find((item: any) => item.id === ownProject) || currentProject(runtime);
  const filters: Record<string, any> = {};
  const keys: Record<string, string[]> = {
    papers: ['paperSearch', 'paperStatusFilter', 'paperYearFilter', 'paperFolderFilter', 'paperProjectFilter'],
    tasks: ['taskProjectFilter'], calendar: ['calendarProjectFilter', 'calendarSourceFilter', 'calendarCursor'],
    conferences: ['conferenceProjectFilter'], datasets: ['datasetProjectFilter'], notes: ['noteScope', 'noteFolderId'],
  };
  for (const key of keys[view] || []) filters[key] = state?.[key];
  return JSON.parse(JSON.stringify({ view, area, view_label: viewNames[area] || area,
    project_id: project?.id || null, project_name: project?.name || null,
    note_id: noteId, resource_path: resourcePath, canvas_path: resourcePath?.endsWith('.canvas') ? resourcePath : null,
    paper_id: view === 'papers' ? state?.libraryReadingPaperId || null : null,
    collection_id: view === 'database' ? (active?.type === 'view' && active.collectionId) || state?.collectionId : null, filters,
    calendar_range: view === 'calendar' && runtime ? runtime.calendarMonthRange(state.calendarCursor) : null,
    visible_paper_ids: view === 'papers' && runtime ? runtime.paperFilteredItems().map(item => item.id) : null,
    open_documents: openDocuments,
    selected_text: noteId && selection?.note_id === noteId ? selection.text : '', ...extension,
  }));
}
