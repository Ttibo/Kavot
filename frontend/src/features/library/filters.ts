import { escapeHtml, state } from '../../app/state';
import { showView } from '../../app/viewBridge';

export function paperFolderIds(paper: Paper): number[] {
  return [...new Set([paper.folder_id, ...(paper.folder_ids || [])].filter((id): id is number => id != null))];
}

export function paperCustomMetadata(paper) {
  const custom = paper?.metadata?.customFields;
  return custom && typeof custom === "object" && !Array.isArray(custom)
    ? custom
    : {};
}

export function paperPublicationYear(paper) {
  const match = String(paper?.published_at || "").match(/(?:18|19|20)\d{2}/);
  return match ? match[0] : "";
}
export function paperFolderDescendantIds(folderId) {
  const ids = new Set([Number(folderId)]);
  let changed = true;
  while (changed) {
    changed = false;
    state.paperFolders.forEach((folder) => {
      if (
        folder.parent_id &&
        ids.has(folder.parent_id) &&
        !ids.has(folder.id)
      ) {
        ids.add(folder.id);
        changed = true;
      }
    });
  }
  return ids;
}

/** Articles in each folder and its subfolders, computed once per loaded library (the folder tree asks for
 * every folder on each redraw). */
let folderCounts: { papers: Paper[]; folders: PaperFolder[]; counts: Map<number, number> } | null = null;
export function paperFolderCount(folderId) {
  if (folderCounts?.papers !== state.papers || folderCounts.folders !== state.paperFolders) {
    const parents = new Map(state.paperFolders.map((folder) => [folder.id, folder.parent_id || null]));
    const counts = new Map<number, number>();
    for (const paper of state.papers) {
      const reached = new Set<number>();
      for (let id of paperFolderIds(paper)) {
        while (id != null && !reached.has(id)) { reached.add(id); id = parents.get(id) ?? null; }
      }
      reached.forEach((id) => counts.set(id, (counts.get(id) || 0) + 1));
    }
    folderCounts = { papers: state.papers, folders: state.paperFolders, counts };
  }
  return folderCounts.counts.get(Number(folderId)) || 0;
}

export function paperFolderOptions(
  selected = null,
  parentId = null,
  depth = 0,
  excluded = new Set(),
) {
  return state.paperFolders
    .filter(
      (folder) => folder.parent_id === parentId && !excluded.has(folder.id),
    )
    .map(
      (folder) =>
        `<option value="${folder.id}" ${Number(selected) === folder.id ? "selected" : ""}>${"— ".repeat(depth)}${escapeHtml(folder.name)}</option>${paperFolderOptions(selected, folder.id, depth + 1, excluded)}`,
    )
    .join("");
}

export function paperFolderLabel(folderId) {
  if (!folderId) return "Unfiled";
  const parts = [];
  const seen = new Set();
  let current = state.paperFolders.find(
    (folder) => folder.id === Number(folderId),
  );
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    parts.unshift(current.name);
    current = state.paperFolders.find(
      (folder) => folder.id === current.parent_id,
    );
  }
  return parts.join(" / ") || "Unfiled";
}

export function renderPapers() { showView("papers"); }

export function paperFilteredItems() {
  const query = state.paperSearch.trim().toLowerCase();
  const normalizedDoiQuery = query
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
    .replace(/^doi\s*:\s*/, "");
  const project =
    state.paperProjectFilter === "all"
      ? null
      : Number(state.paperProjectFilter);
  const folderIds = !["all", "root"].includes(state.paperFolderFilter)
    ? paperFolderDescendantIds(Number(state.paperFolderFilter))
    : null;
  return state.papers
    .filter((paper) => {
      const haystack = [
        paper.title,
        paper.doi,
        paper.abstract,
        paper.publication,
        ...(paper.authors || []),
        ...(paper.tags || []),
        ...Object.keys(paperCustomMetadata(paper)),
        ...Object.values(paperCustomMetadata(paper)),
      ]
        .join(" ")
        .toLowerCase();
      return (
        (!query ||
          haystack.includes(query) ||
          (normalizedDoiQuery && haystack.includes(normalizedDoiQuery))) &&
        (!project || paper.projects.some((p) => p.id === project)) &&
        (state.paperFolderFilter !== "root" || !paperFolderIds(paper).length) &&
        (!folderIds || paperFolderIds(paper).some(id => folderIds.has(id))) &&
        (!state.paperStatusFilter ||
          paper.status === state.paperStatusFilter) &&
        (state.paperYearFilter === "all" ||
          paperPublicationYear(paper) === state.paperYearFilter)
      );
    })
    .sort(
      (left, right) =>
        String(right.created_at || "").localeCompare(
          String(left.created_at || ""),
        ) || right.id - left.id,
    );
}
