import { useCallback, useEffect, useState } from 'react';
import { api } from '../../services/api';
import type { Report, Suggestion } from './Suggestions';

/** An article watch of the papers plugin (`/api/article-watches`). */
export type WatchDraft = {
  name: string; description: string; topics: string[]; keywords: string[]; folder_ids: number[];
  semantic_enabled: boolean; enabled: boolean; max_suggestions: number;
};
export type ArticleWatch = WatchDraft & {
  id: number; last_run_at: string | null; last_error: string | null;
  suggestions: Suggestion[]; reports: Report[];
};

export const draftOf = (watch: ArticleWatch): WatchDraft => ({
  name: watch.name, description: watch.description || '', topics: watch.topics || [], keywords: watch.keywords || [],
  folder_ids: watch.folder_ids || [], semantic_enabled: watch.semantic_enabled !== false, enabled: watch.enabled,
  max_suggestions: watch.max_suggestions || 10,
});

export const newSuggestions = (watch: ArticleWatch) => (watch.suggestions || []).filter(item => item.status === 'new').length;

/** The watches and the number of articles waiting for a decision, loaded with the Library. */
export function useArticleWatches() {
  const [watches, setWatches] = useState<ArticleWatch[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { setWatches(await api<ArticleWatch[]>('/article-watches')); setError(''); }
    catch (reason) { setError((reason as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const replace = useCallback((watch: ArticleWatch) =>
    setWatches(list => list?.some(item => item.id === watch.id) ? list.map(item => item.id === watch.id ? watch : item) : [...(list || []), watch]), []);
  const newCount = (watches || []).reduce((total, watch) => total + newSuggestions(watch), 0);
  return { watches, error, setError, load, replace, newCount };
}
export type ArticleWatchesState = ReturnType<typeof useArticleWatches>;

/** What the Library should show when asked to open its Watches panel from elsewhere. */
export type WatchesIntent = { watchId?: number; create?: boolean };
let pendingIntent: WatchesIntent | null = null;
const listeners = new Set<(intent: WatchesIntent) => void>();
/** Calls `onIntent` for a pending request on mount and for every later one while mounted. */
export function useWatchesIntent(onIntent: (intent: WatchesIntent) => void) {
  useEffect(() => {
    if (pendingIntent) { onIntent(pendingIntent); pendingIntent = null; }
    listeners.add(onIntent);
    return () => { listeners.delete(onIntent); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
