import { api } from '../../services/api';
import type { ExternalAgentConfiguration, ExternalEngine } from '../../components/ExternalAgentSettings';
import type { Diff, Usage } from '../atelier/types';

/** Agent conversations, shared by the assistant panel, the Chat view and the Atelier. */

export type Mode = 'answer' | 'propose' | 'auto';
export type AgentEvent = { id: number; kind: string; label: string; detail: string; at: string };
export type Proposal = {
  proposal_id: string; kind?: string; label: string; target: string; diff: string; status: string;
  after?: string | { content?: string; title?: string }; result?: { id?: number; kind?: string };
  action?: { kind?: string; id?: number; values?: { url?: string; doi?: string; content?: string } };
};
export type Message = {
  role: 'user' | 'assistant'; content: string; at?: string; context?: any; mode?: Mode;
  run_id?: string; events?: AgentEvent[]; proposals?: Proposal[]; status?: string; error?: string;
};
export type CodeSpace = {
  folder_id: string; name: string; worktree: string | null; branch: string; base_sha: string; base_branch: string;
  files: { path: string; status: string; additions: number; deletions: number }[]; commit: string | null; merged: boolean; open?: boolean;
};
export type CodeStatus = 'open' | 'review' | 'accepted' | 'merged' | 'discarded';
export type Code = {
  project_id: number; workspaces: CodeSpace[]; resources: { folder_id: string; name: string; path: string; file?: boolean }[];
  status: CodeStatus; worktree_exists?: boolean; files?: (CodeSpace['files'][number] & { folder_id: string })[];
};
export type Run = {
  id: string; session_id: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; response: string | null; error: string | null;
  events: AgentEvent[]; resources: { id: string; title: string; path?: string }[]; model: string; effort: string; scope?: any; mode?: Mode;
  proposals?: Proposal[]; proposal_errors?: string[]; modified_files?: string[]; draft?: string; usage?: Usage; started_at?: string;
};
export type Session = {
  id: string; engine: ExternalEngine; title: string; model: string; effort: string; messages: Message[]; project_id?: number;
  code?: Code | null; usage?: Usage; usage_history?: (Usage & { at: string; prompt: string; run_id?: string })[];
  active_run_id: string | null; last_run?: Run; created_at: string; updated_at: string;
};
export type Summary = Omit<Session, 'messages' | 'last_run' | 'usage_history'> & { message_count: number; last_status?: string };
export type Resource = { id: string; title: string; path: string; kind: string; note_id?: number; paper_id?: number };

export const ENGINE_NAMES: Record<ExternalEngine, string> = { codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode' };

const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const agents = {
  settings: () => api<ExternalAgentConfiguration>('/external-agents/settings'),
  list: (projectId?: number | null) => api<Summary[]>(`/external-agents/sessions${projectId ? `?project_id=${projectId}` : ''}`),
  get: (id: string) => api<Session>(`/external-agents/sessions/${id}`),
  create: (engine: ExternalEngine, projectId?: number | null) => api<Session>('/external-agents/sessions', json('POST', { engine, project_id: projectId || null })),
  rename: (id: string, title: string) => api<Session>(`/external-agents/sessions/${id}`, json('PATCH', { title })),
  remove: (id: string) => api<void>(`/external-agents/sessions/${id}`, json('DELETE')),
  send: (id: string, body: { text: string; context: any; model: string; effort: string; mode: Mode }) =>
    api<Run>(`/external-agents/sessions/${id}/messages`, json('POST', body)),
  run: (id: string) => api<Run>(`/external-agents/runs/${id}`),
  cancel: (id: string) => api<Run>(`/external-agents/runs/${id}/cancel`, json('POST')),
  decide: (runId: string, proposalId: string, decision: 'apply' | 'dismiss') =>
    api<Run>(`/external-agents/runs/${runId}/proposals/${proposalId}`, json('POST', { decision })),
  preview: (text: string, context: any) => api<{ resources: Resource[]; target: Resource | null; note_intent?: string }>('/external-agents/context', json('POST', { text, context })),
  resources: () => api<Resource[]>('/external-agents/resources'),
  attach: (file: File) => { const body = new FormData(); body.append('file', file); return api<Resource>('/external-agents/attachments', { method: 'POST', body }); },
  // The code of a conversation (Atelier plugin).
  diff: (id: string) => api<Diff>(`/atelier/conversations/${id}/diff`),
  accept: (id: string, message: string, merge: boolean) => api<Code>(`/atelier/conversations/${id}/accept`, json('POST', { message, merge })),
  merge: (id: string) => api<Code>(`/atelier/conversations/${id}/merge`, json('POST')),
  discard: (id: string) => api<Code>(`/atelier/conversations/${id}/discard`, json('POST')),
};

export type ConversationStatus = 'running' | 'review' | 'failed' | 'cancelled' | 'answered' | 'accepted' | 'merged' | 'discarded' | 'new';
export const STATUS_LABELS: Record<ConversationStatus, string> = {
  running: 'Running', review: 'To review', failed: 'Failed', cancelled: 'Stopped', answered: 'Answered',
  accepted: 'Committed', merged: 'Merged', discarded: 'Discarded', new: 'New',
};

/** Where a conversation stands: its running request first, then its code, then its last answer. */
export function statusOf(item: Pick<Summary, 'active_run_id' | 'code'> & { last_status?: string; message_count?: number; messages?: Message[] }): ConversationStatus {
  if (item.active_run_id) return 'running';
  const code = item.code?.status;
  if (code === 'review' || code === 'accepted') return code;
  const last = item.last_status || (item.messages ? [...item.messages].reverse().find(message => message.role === 'assistant')?.status || 'completed' : undefined);
  if (last === 'failed' || last === 'cancelled') return last;
  if (code === 'merged' || code === 'discarded') return code;
  return (item.message_count ?? item.messages?.length) ? 'answered' : 'new';
}

/** Needs the user: running, changes to review or merge, or a failure. */
export const needsAttention = (status: ConversationStatus) => ['running', 'review', 'accepted', 'failed'].includes(status);
