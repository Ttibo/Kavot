import { tokens, totalTokens, type Usage } from '../atelier/types';
import type { Run, Session } from './api';

/** Tokens past which a request, or a whole conversation, is worth flagging (cached tokens included). */
export const MESSAGE_WARN = 250_000, MESSAGE_LIMIT = 500_000;
export const CONVERSATION_WARN = 1_000_000, CONVERSATION_LIMIT = 3_000_000;

export type Level = 'ok' | 'warn' | 'over';
export type Budget = {
  total: number; last: number; level: Level; hue: number; runId?: string;
  /** Which limit is passed: the last request, the conversation, or none. */
  reason?: 'message' | 'conversation';
};

const levelOf = (value: number, warn: number, limit: number): Level => value >= limit ? 'over' : value >= warn ? 'warn' : 'ok';

/** Where the conversation stands: its total, its latest request (the one running counts live) and a hue from green to red. */
export function budgetOf(session: Session | null, run: Run | null): Budget {
  const history = session?.usage_history || [];
  const running = run?.status === 'running';
  const live = running ? totalTokens(run?.usage) : 0;
  const total = totalTokens(session?.usage) + live;
  const latest = history[history.length - 1];
  const last = running ? live : totalTokens(latest);
  const message = levelOf(last, MESSAGE_WARN, MESSAGE_LIMIT), conversation = levelOf(total, CONVERSATION_WARN, CONVERSATION_LIMIT);
  const rank = { ok: 0, warn: 1, over: 2 };
  const level = rank[message] >= rank[conversation] ? message : conversation;
  // A request costs about what the conversation already holds: the gauge follows the larger share of a limit.
  const share = Math.min(1, Math.max(last / MESSAGE_LIMIT, total / CONVERSATION_LIMIT));
  return { total, last, level, hue: Math.round(140 * (1 - share)), runId: running ? run?.id : latest?.run_id,
    reason: level === 'ok' ? undefined : rank[message] >= rank[conversation] ? 'message' : 'conversation' };
}

/** The usage of one finished request, by its run. */
export const usageOfRun = (session: Session | null, runId?: string): Usage | undefined =>
  runId ? session?.usage_history?.find(entry => entry.run_id === runId) : undefined;

export function budgetTitle(budget: Budget) {
  return `This conversation: ${tokens(budget.total)} tokens · latest request: ${tokens(budget.last)}.\n`
    + 'Each call of the agent rereads the whole conversation, so a long one costs more per request. '
    + 'Cached tokens are billed about ten times less.';
}

export function budgetAlert(budget: Budget) {
  if (budget.level === 'ok') return '';
  if (budget.reason === 'message') return budget.level === 'over'
    ? `This request used ${tokens(budget.last)} tokens, past the ${tokens(MESSAGE_LIMIT)} limit. A new conversation starts lighter: the agent reads the notes' briefs again instead of this whole history.`
    : `This request used ${tokens(budget.last)} tokens. The conversation is getting heavy; a new one costs less per request.`;
  return budget.level === 'over'
    ? `This conversation reached ${tokens(budget.total)} tokens, past the ${tokens(CONVERSATION_LIMIT)} limit. Start a new conversation for the next task.`
    : `This conversation reached ${tokens(budget.total)} tokens. Consider a new conversation for a new task.`;
}
