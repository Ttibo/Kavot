import type { Runtime } from '../../app/runtime';
import { currentProject } from '../../app/projectContext';

const contexts = new Map<Element, () => Record<string, any>>();
export function suggestToAgent(text: string) {
  window.dispatchEvent(new CustomEvent('kavot:assistant-suggestion', { detail: { text } }));
}
export function registerAgentContext(element: Element, read: () => Record<string, any>) {
  for (const owner of contexts.keys()) if (!owner.isConnected) contexts.delete(owner);
  contexts.set(element, read);
  return () => { contexts.delete(element); };
}

const viewNames: Record<string, string> = {
  dashboard: 'Accueil', projects: 'Projects', project: 'Research Hub', canvas: 'Canvas', notes: 'Notes and editor',
  papers: 'Library', reader: 'Lecteur PDF', citations: 'Graphe de citations', tasks: 'Tasks',
  calendar: 'Calendrier', datasets: 'Datasets', conferences: 'Conferences', database: 'Collection', settings: 'Settings',
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

export function captureAgentContext(runtime?: Runtime) {
  const state = runtime?.state;
  const view = state?.view || 'dashboard';
  const active = state?.activeNotePane === 'secondary' ? state.secondaryResource : state?.primaryResource;
  const primary = document.querySelector('#note-content') ? Number(state?.currentNoteId) || null : null;
  const secondary = document.querySelector('#secondary-note-content') ? Number(state?.secondaryResource?.noteId) || null : null;
  let noteId = state?.activeNotePane === 'secondary' ? secondary || primary : primary || secondary;
  let resourcePath = view === 'notes' ? active?.path || null : null;
  const openDocuments: Record<string, any>[] = [];
  const addDocument = (detail: Record<string, any>) => {
    if (detail.note_id || detail.paper_id || detail.resource_path || detail.url) openDocuments.push(detail);
  };
  for (const pane of ['primary', 'secondary']) {
    for (const tab of state?.workspaceTabs?.[pane] || []) {
      addDocument(tab.type === 'note' ? { note_id: tab.noteId, pane } : {
        resource_path: tab.resource?.path, paper_id: tab.resource?.paperId, title: tab.resource?.title, pane,
      });
    }
  }
  let extension: Record<string, any> = {};
  for (const [element, read] of contexts) {
    if (!element.isConnected) { contexts.delete(element); continue; }
    if (!element.closest('[hidden]') && element.getClientRects().length) {
      const detail = read();
      addDocument({ note_id: detail.note_id, paper_id: detail.paper_id, resource_path: detail.resource_path, url: detail.document_url, title: detail.document_title });
      if (!detail.canvas_path || detail.canvas_path === active?.path) extension = { ...extension, ...detail };
    }
  }
  if (view !== 'notes') noteId = null;
  if (extension.note_id) noteId = extension.note_id;
  addDocument({ note_id: noteId, resource_path: resourcePath, paper_id: extension.paper_id || (view === 'papers' ? state?.libraryReadingPaperId : null), active: true });
  const area = extension.area || (resourcePath?.endsWith('.canvas') ? 'canvas' : view);
  const project = currentProject(runtime);
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
    collection_id: view === 'database' ? state?.collectionId : null, filters,
    calendar_range: view === 'calendar' && runtime ? runtime.calendarMonthRange(state.calendarCursor) : null,
    visible_paper_ids: view === 'papers' && runtime ? runtime.paperFilteredItems().map(item => item.id) : null,
    open_documents: openDocuments,
    selected_text: noteId && selection?.note_id === noteId ? selection.text : '', ...extension,
  }));
}
