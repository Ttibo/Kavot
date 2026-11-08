/** Usage of an agent request as its CLI reports it, and how the interface shows it. */
export type Usage = { input?: number; output?: number; cache_read?: number; cache_write?: number; reasoning?: number; cost_usd?: number; turns?: number; duration_ms?: number };

/** Every token read or written, cached tokens included: what the model processed. */
export const totalTokens = (usage?: Usage) => usage
  ? (usage.input || 0) + (usage.output || 0) + (usage.cache_read || 0) + (usage.cache_write || 0) + (usage.reasoning || 0) : 0;

/** Tokens as they are billed: a cached token read costs about a tenth of a new one. Budgets and lists use this,
 * so a long conversation that mostly rereads its cache does not look ten times more expensive than it is. */
export const billedTokens = (usage?: Usage) => usage
  ? (usage.input || 0) + (usage.output || 0) + (usage.cache_write || 0) + (usage.reasoning || 0) + Math.round((usage.cache_read || 0) / 10) : 0;

export function tokens(value = 0) {
  return value < 1000 ? String(value) : value < 1_000_000 ? `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k` : `${(value / 1_000_000).toFixed(1)}M`;
}
export const cost = (value?: number) => value ? `$${value < 0.1 ? value.toFixed(3) : value.toFixed(2)}` : '';
export function duration(ms = 0) {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

const when = (value?: string | null) => value
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
