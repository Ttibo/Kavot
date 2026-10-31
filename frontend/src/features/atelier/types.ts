import { api } from '../../services/api';
import type { Summary } from '../agents/api';

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
export type Usage = { input?: number; output?: number; cache_read?: number; cache_write?: number; reasoning?: number; cost_usd?: number; turns?: number; duration_ms?: number };
export type Overview = {
  project: { id: number; name: string; description?: string; color?: string; status?: string; canvas_path?: string };
  folders: Folder[]; conversations: Summary[];
  notes: { id: number; title: string; updated_at?: string }[];
  tasks: { id: number; title: string; status: string; priority?: string; due_date?: string }[];
};
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
