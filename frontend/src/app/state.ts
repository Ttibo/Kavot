import { markdownMediaPreview } from '../features/documents/mediaPreview';
import { documentHtml, isHtmlDocument } from '../features/documents/html';
import { protectMath } from '../features/documents/math';
import { noteDatabaseMarkup } from '../features/documents/noteDatabase';
import { api } from '../services/api';
import { toast } from './navigation';
import { editorSession } from './editorSession';
import { markdownTableCells, markdownTableStart } from '../features/documents/markdown';

const initialTheme = document.documentElement.dataset.theme || "dark";

function storedWorkspaceSession() {
  try {
    return JSON.parse(localStorage.getItem("kavot-workspace-session") || "{}") || {};
  } catch (_) {
    return {};
  }
}

export function rememberWorkspaceSession(documentState) {
  state.recentDocument = { ...documentState, openedAt: Date.now() };
  if (documentState.type === "paper") state.recentPaper = state.recentDocument;
  else state.recentFile = state.recentDocument;
  localStorage.setItem(
    "kavot-workspace-session",
    JSON.stringify({
      recentDocument: state.recentDocument,
      recentFile: state.recentFile,
      recentPaper: state.recentPaper,
      readingProgress: state.readingProgress,
    }),
  );
}

export function rememberReadingProgress(paperId, page) {
  if (!paperId) return;
  state.readingProgress[String(paperId)] = Math.max(1, Number(page) || 1);
  rememberWorkspaceSession({
    type: "paper",
    paperId: Number(paperId),
    page: state.readingProgress[String(paperId)],
  });
}

const initialWorkspaceSession = storedWorkspaceSession();

export function setInterfaceTheme(theme, persist = true) {
  const nextTheme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = nextTheme;
  try {
    localStorage.setItem("kavot-theme", nextTheme);
  } catch (_) {
    // The native WebView may restrict browser storage; the file-backed
    // preference below remains the durable source of truth.
  }
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", nextTheme === "dark" ? "#10171d" : "#f4f7f9");
  if (persist) {
    api("/settings/preferences", {
      method: "PATCH",
      body: JSON.stringify({ theme: nextTheme }),
    }).catch((error) => toast(error.message, "error"));
  }
  return nextTheme;
}

export const state = {
  settingsTab: "general",
  theme: initialTheme,
  // Graph search was merged into the library; keep old ?view=discovery links working.
  view: ((view) => view === "discovery" ? "papers" : view === "article-watch" ? "watchers" : view)(["discovery", "dashboard", "projects", "papers", "article-watch", "watchers", "workflows", "chat", "tasks", "notes", "calendar", "database", "conferences", "datasets", "settings", "trash"].includes(
    new URLSearchParams(window.location.search).get("view"),
  )
    ? new URLSearchParams(window.location.search).get("view")
    : "dashboard"),
  projects: [] as Project[],
  papers: [] as Paper[],
  paperFolders: [] as PaperFolder[],
  tasks: [] as any[],
  taskColumns: [] as any[],
  conferences: [] as any[],
  datasets: [] as any[],
  calendarEvents: [] as any[],
  notes: [] as any[],
  noteFolders: [] as NoteFolder[],
  notePlacements: [] as any[],
  noteTemplates: [] as any[],
  noteScripts: [] as any[],
  databases: [] as any[],
  workflows: [] as any[],
  workflowId: null as number | null,
  /** Project the whole interface is filtered on (sidebar trees, tasks, library…), or null for the whole workspace. */
  scopeProjectId: (Number(localStorage.getItem("kavot-scope-project")) || null) as number | null,
  /** Last project opened in the Atelier (code folders, map and agents). */
  atelierProjectId: null as number | null,
  databaseRecords: {} as Record<string, Array<{ id: string; values: Record<string, any>; updated_at?: string; note?: Note }>>,
  collectionId: "articles",
  /** Item open in the side panel of a collection page. */
  collectionPanel: null as { type: string; id: string | number; databaseId: string; session?: number; projectIds?: number[] } | null,
  collectionsSidebarOpen: localStorage.getItem("kavot-collections-open") !== "false",
  workspaceTree: [],
  dashboard: null as { recent_paper?: Paper; current_note?: any } | null,
  recentDocument: initialWorkspaceSession.recentDocument || null,
  recentFile:
    initialWorkspaceSession.recentFile ||
    (initialWorkspaceSession.recentDocument?.type !== "paper"
      ? initialWorkspaceSession.recentDocument
      : null),
  recentPaper:
    initialWorkspaceSession.recentPaper ||
    (initialWorkspaceSession.recentDocument?.type === "paper"
      ? initialWorkspaceSession.recentDocument
      : null),
  readingProgress: initialWorkspaceSession.readingProgress || {},
  selectedProject: null as Project | null | undefined,
  selectedPaperId: null,
  paperProjectContext: null,
  currentNoteId: null,
  noteScope: "general",
  noteFolderId: "all" as string | number,
  collapsedFolders: new Set(),
  collapsedSpaces: new Set(["readings"]),
  initializedReadingSpaces: new Set(),
  taskProjectFilter: "all",
  taskView: localStorage.getItem("kavot-task-view") === "list" ? "list" : "kanban",
  calendarProjectFilter: "all",
  calendarSourceFilter: "all",
  calendarCursor: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  conferenceProjectFilter: "all",
  datasetProjectFilter: "all",
  paperProjectFilter: "all",
  paperFolderFilter: "all",
  paperSearch: "",
  paperStatusFilter: "",
  paperYearFilter: "all",
  paperPage: 1,
  paperPageSize: 20,
  libraryReadingPaperId: null as number | null,
  editorMode: "edit",
  noteSidebarWidth: 340,
  noteSplitPercent: 50,
  noteWorkspaceSplitPercent: 50,
  noteTreeScrollTop: 0,
  secondaryNoteSplitPercent: 50,
  secondaryFirst: false,
  activeNotePane: "primary",
  primaryResource: null as { type?: string; path?: string; title?: string; [key: string]: any } | null,
  secondaryResource: null,
  workspaceTabs: { primary: [], secondary: [] },
  workspaceActiveTabs: { primary: null, secondary: null },
  expandedWorkspacePaths: new Set(["notes", "notes/general", "notes/projects", "collections"]),
  expandedPaperFolders: new Set(),
  editingNoteFolderId: null,
  editingWorkspacePath: null,
  focusNoteTitleId: null,
};

// This module is also imported by React views while the module graph is
// evaluated, before AppShell has added these nodes to the document. Keep live
// bindings and attach them once the shell is mounted.
export let main = document.querySelector<HTMLElement>("#main-content");

export let modalBackdrop = document.querySelector<HTMLElement>("#modal-backdrop");

export let modal = document.querySelector<HTMLElement>("#modal");

export let modalContent = document.querySelector<HTMLElement>("#modal-content");

/** A page of the application is on screen: as the page, or as the active tab of an editor pane. */
export function viewShown(view: string) {
  return state.view === view || (["primary", "secondary"] as const).some(pane =>
    state.workspaceTabs[pane]?.find(tab => tab.id === state.workspaceActiveTabs[pane])?.resource?.view === view);
}

export function bindInterfaceElements() {
  main = document.querySelector<HTMLElement>("#main-content");
  modalBackdrop = document.querySelector<HTMLElement>("#modal-backdrop");
  modal = document.querySelector<HTMLElement>("#modal");
  modalContent = document.querySelector<HTMLElement>("#modal-content");
}

let readerSavePromise: Promise<Note | void> = Promise.resolve();

export const workspaceMarkdownTimers = new Map();

export const noteTitleTimers = new Map();

export async function flushReaderAutosave() {
  if (editorSession.pendingReaderSave) {
    clearTimeout(editorSession.readerAutosaveTimer);
    const save = editorSession.pendingReaderSave;
    editorSession.pendingReaderSave = null;
    await save();
  }
  await readerSavePromise;
}

export const escapeHtml = (value = "") =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

function markdownImageUrl(value, assetBase = "") {
  if (assetBase && /^assets\/[a-zA-Z0-9._-]+$/.test(value)) {
    return `${assetBase}${encodeURIComponent(value.slice(7))}`;
  }
  if (/^\/api\/[^\s"'<>]+$/.test(value)) return value;
  if (/^https?:\/\/[^\s"'<>]+$/.test(value)) return value;
  return "";
}

function inlineMarkdown(value = "", assetBase = "") {
  const math = protectMath(String(value));
  const codeTokens = [];
  let text = escapeHtml(math.text).replace(/`([^`]+)`/g, (_, code) => {
    const token = `%%CODE${codeTokens.length}%%`;
    codeTokens.push(`<code>${code}</code>`);
    return token;
  });
  text = text
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => {
      const source = markdownImageUrl(url, assetBase);
      return source ? `<img src="${source}" alt="${alt}" loading="lazy">` : alt;
    })
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+|\.?\.?\/[^\s)]+|#[^\s)]+)\)/g,
      (_, label, url) => {
        const target = /^assets\/[a-zA-Z0-9._-]+$/.test(url)
          ? markdownImageUrl(url, assetBase)
          : url;
        return target
          ? `<a href="${target}" target="_blank" rel="noreferrer">${label}</a>`
          : label;
      },
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/==([^=]+)==/g, '<mark>$1</mark>')
    .replace(/(%%CODE\d+%%)|%%.*?%%/g, (_, codeToken) => codeToken || '');
  codeTokens.forEach((code, index) => {
    text = text.replace(`%%CODE${index}%%`, code);
  });
  return math.restore(text);
}

export function renderMarkdown(source = "", assetBase = "") {
  if (isHtmlDocument(String(source))) return documentHtml(String(source), assetBase);
  const math = protectMath(String(source).replaceAll("\r\n", "\n"));
  const lines = math.text.split("\n");
  const output = [];
  let listType = null;
  let inCode = false;
  let codeLines = [];
  let codeLanguage = '';
  let skipUntil = -1;
  const tableCells = (line: string) => markdownTableCells(line).map(cell => cell.replaceAll("\\|", "|"));
  const closeList = () => {
    if (listType) output.push(`</${listType}>`);
    listType = null;
  };
  lines.forEach((line, index) => {
    if (index <= skipUntil) return;
    if (line.trim().startsWith("```")) {
      closeList();
      if (inCode) {
        output.push(
          (codeLanguage === 'kavot-db' && noteDatabaseMarkup(codeLines.join('\n'))) || `<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`,
        );
        codeLines = [];
      }
      if (!inCode) codeLanguage = line.trim().slice(3).trim();
      inCode = !inCode;
      return;
    }
    if (inCode) {
      codeLines.push(line);
      return;
    }
    if (math.isDisplay(line.trim())) {
      closeList();
      output.push(`<div class="markdown-math">${line.trim()}</div>`);
      return;
    }
    if (/^<!--\s*kavot:dynamic:[a-z_]+:(start|end)\s*-->$/.test(line.trim()))
      return;
    if (
      line.includes("|") &&
      index + 1 < lines.length &&
      markdownTableStart(lines, index)
    ) {
      closeList();
      const headers = tableCells(line);
      const rows = [];
      let cursor = index + 2;
      while (
        cursor < lines.length &&
        lines[cursor].includes("|") &&
        lines[cursor].trim()
      ) {
        rows.push(tableCells(lines[cursor]));
        cursor += 1;
      }
      skipUntil = cursor - 1;
      output.push(
        `<div class="markdown-table-wrap"><table><thead><tr>${headers.map((cell) => `<th>${inlineMarkdown(cell, assetBase)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, cellIndex) => `<td>${inlineMarkdown(row[cellIndex] || "", assetBase)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`,
      );
      return;
    }
    if (!line.trim()) {
      closeList();
      output.push("");
      return;
    }
    const media = markdownMediaPreview(line);
    if (media) { closeList(); output.push(media); return; }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      output.push(
        `<h${level}>${inlineMarkdown(heading[2], assetBase)}</h${level}>`,
      );
      return;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      closeList();
      output.push("<hr>");
      return;
    }
    const task = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (task) {
      if (listType !== "ul") {
        closeList();
        output.push('<ul class="markdown-tasks">');
        listType = "ul";
      }
      output.push(
        `<li><input type="checkbox" disabled ${task[1].toLowerCase() === "x" ? "checked" : ""}>${inlineMarkdown(task[2], assetBase)}</li>`,
      );
      return;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    if (unordered) {
      if (listType !== "ul") {
        closeList();
        output.push("<ul>");
        listType = "ul";
      }
      output.push(`<li>${inlineMarkdown(unordered[1], assetBase)}</li>`);
      return;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) {
      if (listType !== "ol") {
        closeList();
        output.push("<ol>");
        listType = "ol";
      }
      output.push(`<li>${inlineMarkdown(ordered[1], assetBase)}</li>`);
      return;
    }
    closeList();
    if (line.startsWith("> "))
      output.push(
        `<blockquote>${inlineMarkdown(line.slice(2), assetBase)}</blockquote>`,
      );
    else output.push(`<p>${inlineMarkdown(line, assetBase)}</p>`);
  });
  closeList();
  if (inCode)
    output.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  return math.restore(output.join("\n"));
}

export function noteAssetBase(note) {
  return note?.id ? `/api/notes/${note.id}/assets/` : "";
}

export const formatDate = (value) => {
  if (!value) return "No due date";
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
};

export const truncate = (value = "", length = 90) =>
  value.length > length ? `${value.slice(0, length).trim()}…` : value;

export const labels: Record<string, string> = {
  active: "Active",
  paused: "Paused",
  archived: "Archived",
  to_read: "To read",
  reading: "Reading",
  read: "Read",
  key: "Key",
  todo: "To do",
  doing: "In progress",
  done: "Done",
  low: "Low",
  medium: "Medium",
  high: "High",
};
