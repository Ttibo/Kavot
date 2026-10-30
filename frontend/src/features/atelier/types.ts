import { api } from '../../services/api';

export type Commit = { sha: string; short: string; author: string; date: string; refs: string[]; subject: string };
export type Folder = {
  id: string; name: string; path: string; kind?: 'code' | 'resources'; file?: boolean; size?: number; legacy?: boolean; available: boolean; error?: string;
  is_git?: boolean; branch?: string | null; parent_repository?: boolean; git_error?: string;
  changes: { status: string; path: string }[]; commits: Commit[];
};
export type FileDiff = { path: string; old_path: string; status: string; binary: boolean; additions: number; deletions: number; patch: string };
export type Diff = {
  files: FileDiff[]; truncated: boolean; message?: string; sha?: string; author?: string; date?: string;
  folders?: { folder_id: string; name: string; files: FileDiff[]; truncated: boolean; error?: string | null }[];
};
export type RunFile = { path: string; status: string; additions: number; deletions: number };
export type Usage = { input?: number; output?: number; cache_read?: number; cache_write?: number; reasoning?: number; cost_usd?: number; turns?: number; duration_ms?: number };
export type Workspace = {
  folder_id: string; name: string; worktree: string | null; branch: string; base_sha: string; base_branch: string;
  files: RunFile[]; commit: string | null; merged: boolean; open?: boolean;
};
export type RunStatus = 'running' | 'review' | 'answered' | 'failed' | 'cancelled' | 'accepted' | 'merged' | 'discarded';
export type Run = {
  id: string; title: string; status: RunStatus; engine: string; model: string; folder_id: string; branch: string;
  base_branch: string; base_sha: string; task_id: number | null; note_ids: number[]; created_at: string; updated_at: string;
  finished_at: string | null; files: (RunFile & { folder_id?: string })[]; error: string | null; commit: string | null; merged: boolean;
  usage?: Usage; workspaces?: Workspace[]; resources?: { folder_id: string; name: string; path: string }[];
};
export type RunEvent = { id: number; kind: string; label: string; detail: string; at: string };
export type RunDetail = Run & {
  prompt: string; response: string | null; events: RunEvent[]; worktree: string | null; worktree_exists: boolean; draft?: string;
  usage_history?: (Usage & { at: string; prompt: string })[];
  messages: { role: 'user' | 'assistant'; content: string; at: string }[];
};
export type Overview = {
  project: { id: number; name: string; description?: string; color?: string; status?: string; canvas_path?: string };
  folders: Folder[]; runs: Run[];
  notes: { id: number; title: string; updated_at?: string }[];
  tasks: { id: number; title: string; status: string; priority?: string; due_date?: string }[];
};
export type Engine = { id: 'claude' | 'codex' | 'opencode'; name: string; enabled: boolean; available: boolean; model: string };
export type MapSymbol = { id: string; name: string; kind: string; line: number; end?: number; doc?: string; calls: string[]; called_by: string[] };
export type MapFile = {
  path: string; lang: string; lines: number; doc: string; error?: string | null;
  imports: string[]; imported_by: string[]; external: string[]; symbols: MapSymbol[];
};
export type CodeMap = { files: MapFile[]; edges: { source: string; target: string }[]; directories: { path: string; files: number; lines: number }[]; languages: string[]; truncated: boolean; built_at: string };
export type Entry = { name: string; path: string; directory: boolean };
export type FileContent = { path: string; size: number; content: string | null; binary: boolean; truncated: boolean; extension: string };
export type Location = { folderId: string; path: string; line?: number };

export const atelierApi = <T = any>(projectId: number, path = '', options: RequestInit = {}) =>
  api<T>(`/atelier/projects/${projectId}${path}`, options);

export const post = (body?: unknown): RequestInit => ({ method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export function openInEditor(projectId: number, folderId: string, path = '', line = 1, editor: 'vscode' | 'cursor' | 'system' | 'default' = 'vscode') {
  return atelierApi(projectId, `/folders/${folderId}/open`, post({ path, line, editor }));
}

export const ACTIVE: RunStatus[] = ['running', 'review', 'answered', 'failed', 'cancelled'];
export const STATUS_LABELS: Record<RunStatus, string> = {
  running: 'Running', review: 'To review', answered: 'Answered', failed: 'Failed', cancelled: 'Stopped', accepted: 'Committed', merged: 'Merged', discarded: 'Discarded',
};

/** Every token the agent consumed or produced. */
export const totalTokens = (usage?: Usage) => usage
  ? (usage.input || 0) + (usage.output || 0) + (usage.cache_read || 0) + (usage.cache_write || 0) + (usage.reasoning || 0) : 0;
export function tokens(value = 0) {
  return value < 1000 ? String(value) : value < 1_000_000 ? `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k` : `${(value / 1_000_000).toFixed(1)}M`;
}
export const cost = (value?: number) => value ? `$${value < 0.1 ? value.toFixed(3) : value.toFixed(2)}` : '';
export function duration(ms = 0) {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

export const when = (value?: string | null) => value
  ? new Date(value).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

export function relative(value?: string | null) {
  if (!value) return '';
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return when(value);
}
