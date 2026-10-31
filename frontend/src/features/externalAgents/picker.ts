/** Context the user picks for a chat: projects, notes, articles, folders, collections, files, tasks,
 * and a project's code (changed in worktrees) and resource folders (read only). */

export type PickedKind = 'project' | 'code' | 'resource' | 'task' | 'note' | 'paper' | 'paper_folder' | 'note_folder' | 'collection' | 'file';
export type PickedItem = { key: string; kind: PickedKind; id: string | number; title: string; subtitle?: string; count?: number; project_id?: number };
/** A folder linked to a project in the Atelier. */
export type ProjectFolder = { id: string; name: string; path: string; kind?: 'code' | 'resources'; file?: boolean; available: boolean; is_git?: boolean; branch?: string | null };
export type PickerResource = { id: string; title: string; path: string; kind: string };
type PickerState = {
  projects?: Project[]; notes?: Note[]; papers?: Paper[]; paperFolders?: PaperFolder[]; noteFolders?: NoteFolder[]; tasks?: any[];
  databases?: Array<{ id: string; name: string; removed?: boolean }>;
};

export const KIND_LABELS: Record<PickedKind, string> = {
  project: 'Project', code: 'Code', resource: 'Resource', task: 'Task', note: 'Note', paper: 'Article', paper_folder: 'Article folder',
  note_folder: 'Note folder', collection: 'Collection', file: 'File',
};
export const KIND_ICONS: Record<PickedKind, string> = {
  project: 'projects', code: 'code', resource: 'folder', task: 'tasks', note: 'notes', paper: 'papers', paper_folder: 'folder',
  note_folder: 'folder', collection: 'database', file: 'local',
};
/** Most notes a note folder adds as sources; the agent can still explore the rest. */
export const FOLDER_NOTE_LIMIT = 40;

/** Files the user made or added; Kavot's own metadata and article folders are reached otherwise. */
const isUserFile = (item: PickerResource) => item.kind !== 'note' && item.kind !== 'paper' && !item.path.startsWith('library/')
  && !/\.(kavot\.json|generated\.html)$/.test(item.path);

const fold = (value: string) => value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

function descendants<T extends { id: number; parent_id: number | null }>(folders: T[], root: number): Set<number> {
  const found = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of folders) if (folder.parent_id !== null && found.has(folder.parent_id) && !found.has(folder.id)) { found.add(folder.id); grew = true; }
  }
  return found;
}

export function folderPapers(state: PickerState, folderId: number): Paper[] {
  const ids = descendants(state.paperFolders || [], folderId);
  return (state.papers || []).filter(paper => [paper.folder_id, ...(paper.folder_ids || [])].some(id => id !== null && id !== undefined && ids.has(id)));
}

export function folderNotes(state: PickerState, folderId: number): Note[] {
  const ids = descendants(state.noteFolders || [], folderId);
  return (state.notes || []).filter(note => !note.trashed_at && note.folder_id !== null && ids.has(note.folder_id));
}

/** A project's linked folders: its code (given to change, in a worktree) and its resources (read only). */
export function folderOptions(projectId: number, projectName: string, folders: ProjectFolder[]): PickedItem[] {
  return folders.filter(folder => folder.available).map(folder => {
    const code = folder.kind !== 'resources' && !folder.file && !!folder.is_git;
    return { key: `${code ? 'code' : 'resource'}:${projectId}:${folder.id}`, kind: code ? 'code' as const : 'resource' as const, id: folder.id,
      title: folder.name, project_id: projectId, subtitle: [projectName, code ? `${folder.branch || 'Git'} · changed in a worktree` : 'read only'].join(' · ') };
  });
}

/** Everything that can be picked, with a short description; built from what the app already loaded. */
export function pickerOptions(state: PickerState | undefined, resources: PickerResource[], extra: PickedItem[] = []): PickedItem[] {
  if (!state) return [...extra, ...resources.filter(isUserFile)
    .map(item => ({ key: `file:${item.id}`, kind: 'file' as const, id: item.id, title: item.title, subtitle: item.path }))];
  const projectName = new Map((state.projects || []).map(project => [project.id, project.name]));
  const options: PickedItem[] = [...extra];
  for (const task of state.tasks || []) {
    if (task.archived_at || task.status === 'done') continue;
    options.push({ key: `task:${task.id}`, kind: 'task', id: task.id, title: task.title || 'Untitled task', project_id: task.project_id || undefined,
      subtitle: [task.project_id ? projectName.get(task.project_id) : '', task.status, task.due_date].filter(Boolean).join(' · ') });
  }
  for (const project of state.projects || []) {
    if (project.status === 'archived') continue;
    options.push({ key: `project:${project.id}`, kind: 'project', id: project.id, title: project.name,
      subtitle: [project.description?.slice(0, 80), project.note_count ? `${project.note_count} notes` : '', project.paper_count ? `${project.paper_count} articles` : ''].filter(Boolean).join(' · ') });
  }
  for (const folder of state.paperFolders || []) {
    const count = folderPapers(state, folder.id).length;
    options.push({ key: `paper_folder:${folder.id}`, kind: 'paper_folder', id: folder.id, title: folder.name, subtitle: `${count} articles`, count });
  }
  for (const note of state.notes || []) {
    if (note.trashed_at) continue;
    options.push({ key: `note:${note.id}`, kind: 'note', id: note.id, title: note.title || 'Untitled note',
      subtitle: note.project_id ? projectName.get(note.project_id) || 'Project note' : note.paper_id ? 'Reading note' : 'Notes' });
  }
  for (const paper of state.papers || []) {
    const year = String(paper.published_at || '').slice(0, 4);
    options.push({ key: `paper:${paper.id}`, kind: 'paper', id: paper.id, title: paper.title,
      subtitle: [paper.authors?.[0] && (paper.authors.length > 1 ? `${paper.authors[0]} et al.` : paper.authors[0]), year, paper.file_path ? 'PDF' : ''].filter(Boolean).join(' · ') });
  }
  for (const folder of state.noteFolders || []) {
    if (folder.system_kind) continue;
    const count = folderNotes(state, folder.id).length;
    options.push({ key: `note_folder:${folder.id}`, kind: 'note_folder', id: folder.id, title: folder.name,
      subtitle: [`${count} notes`, folder.project_id ? projectName.get(folder.project_id) : ''].filter(Boolean).join(' · '), count });
  }
  for (const database of state.databases || []) {
    if (database.removed || database.id === 'notes') continue;
    options.push({ key: `collection:${database.id}`, kind: 'collection', id: database.id, title: database.name, subtitle: 'Collection' });
  }
  for (const item of resources) {
    if (!isUserFile(item)) continue;
    options.push({ key: `file:${item.id}`, kind: 'file', id: item.id, title: item.title, subtitle: item.path });
  }
  return options;
}

/** How many options of each type match the query (and in total, under "all"). */
export function countByKind(options: PickedItem[], query: string): Partial<Record<PickedKind | 'all', number>> {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const counts: Partial<Record<PickedKind | 'all', number>> = {};
  for (const option of options) {
    const text = fold(option.title + ' ' + (option.subtitle || ''));
    if (!words.every(word => text.includes(word))) continue;
    counts[option.kind] = (counts[option.kind] || 0) + 1;
    counts.all = (counts.all || 0) + 1;
  }
  return counts;
}

/** Options matching every word of the query, best matches first (title start, then title, then details). */
export function filterOptions(options: PickedItem[], query: string, kind: PickedKind | 'all', limit = 60): PickedItem[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const scored: [number, PickedItem][] = [];
  for (const option of options) {
    if (kind !== 'all' && option.kind !== kind) continue;
    const title = fold(option.title);
    const text = title + ' ' + fold(option.subtitle || '');
    if (!words.every(word => text.includes(word))) continue;
    const score = !words.length ? 0 : title.startsWith(words[0]) ? 0 : words.every(word => title.includes(word)) ? 1 : 2;
    scored.push([score, option]);
  }
  const ordered = scored.sort((a, b) => a[0] - b[0]).map(([, option]) => option);
  if (words.length || kind !== 'all') return ordered.slice(0, limit);
  // Nothing typed yet: a few of each type, so every type is in view.
  const perKind = new Map<PickedKind, number>();
  return ordered.filter(option => { const seen = perKind.get(option.kind) || 0; perKind.set(option.kind, seen + 1); return seen < 6; }).slice(0, limit);
}

export type PickedContext = {
  project_id?: number; project_name?: string; collection_id?: string; picked_collection?: boolean;
  resource_ids: string[]; paper_ids: number[]; focus: Record<string, unknown>[]; note_id: number | null;
  code_folder_ids: string[]; resource_folder_ids: string[];
};

/** The request context fields that make the agent work on the picked items. */
export function pickedContext(picked: PickedItem[], state: PickerState | undefined, resources: PickerResource[]): PickedContext {
  const available = new Set(resources.map(item => item.id));
  const resourceIds: string[] = [];
  const paperIds = new Set<number>();
  const focus: Record<string, unknown>[] = [];
  const codeIds: string[] = [];
  const folderIds: string[] = [];
  const result: Partial<PickedContext> = {};
  for (const item of picked) {
    if ((item.kind === 'code' || item.kind === 'resource') && item.project_id) {
      (item.kind === 'code' ? codeIds : folderIds).push(String(item.id));
      result.project_id ??= item.project_id;
      focus.push({ kind: item.kind === 'code' ? 'code folder (changed in a worktree)' : 'resource folder (read only)', title: item.title });
    } else if (item.kind === 'task') {
      focus.push({ kind: 'task', title: item.title, ref: `kavot://tasks/${item.id}` });
    } else if (item.kind === 'project') {
      result.project_id = Number(item.id); result.project_name = item.title;
      focus.push({ kind: 'project', title: item.title, ref: `kavot://projects/${item.id}` });
    } else if (item.kind === 'note') {
      resourceIds.push(`note:${item.id}`);
      focus.push({ kind: 'note', title: item.title, ref: `kavot://notes/${item.id}` });
    } else if (item.kind === 'paper') {
      paperIds.add(Number(item.id));
      focus.push({ kind: 'article', title: item.title, ref: `kavot://articles/${item.id}` });
    } else if (item.kind === 'paper_folder') {
      const papers = state ? folderPapers(state, Number(item.id)) : [];
      papers.forEach(paper => paperIds.add(paper.id));
      focus.push({ kind: 'article folder', title: item.title, count: papers.length });
    } else if (item.kind === 'note_folder') {
      const notes = state ? folderNotes(state, Number(item.id)) : [];
      notes.slice(0, FOLDER_NOTE_LIMIT).forEach(note => resourceIds.push(`note:${note.id}`));
      focus.push({ kind: 'note folder', title: item.title, count: notes.length });
    } else if (item.kind === 'collection') {
      result.collection_id = String(item.id); result.picked_collection = true;
      focus.push({ kind: 'collection', title: item.title, ref: `kavot://collections/${item.id}` });
    } else if (item.kind === 'file') {
      resourceIds.push(String(item.id));
      focus.push({ kind: 'file', title: item.title });
    }
  }
  // Articles with a PDF are also readable sources; the others are known by their metadata.
  for (const id of paperIds) if (available.has(`paper:${id}`)) resourceIds.push(`paper:${id}`);
  const singleNote = picked.filter(item => item.kind === 'note');
  return { ...result, resource_ids: resourceIds, paper_ids: [...paperIds], focus,
    note_id: singleNote.length === 1 ? Number(singleNote[0].id) : null, code_folder_ids: codeIds, resource_folder_ids: folderIds };
}

const storageKey = (sessionId: string) => `kavot-chat-context:${sessionId}`;

export function loadPicked(sessionId: string): PickedItem[] {
  if (!sessionId) return [];
  try { const value = JSON.parse(localStorage.getItem(storageKey(sessionId)) || '[]'); return Array.isArray(value) ? value : []; }
  catch { return []; }
}

export function savePicked(sessionId: string, picked: PickedItem[]) {
  if (!sessionId) return;
  try {
    if (picked.length) localStorage.setItem(storageKey(sessionId), JSON.stringify(picked));
    else localStorage.removeItem(storageKey(sessionId));
  } catch { /* The picked context simply is not remembered. */ }
}
