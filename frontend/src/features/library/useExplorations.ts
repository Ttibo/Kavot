import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRuntime } from '../../app/runtime';
import { toast } from '../../app/navigation';
import { api } from '../../services/api';
import type { CitationNode } from './CitationCanvas';
import type { LookupPreview } from './ArticlePreview';

type Direction = 'all' | 'reference' | 'citation';
export type ExplorationTab = { direction: Direction; seed: CitationNode | null };
export type SavedExploration = { id: number; title: string; kind: 'library' | 'external'; paper_id: number | null; seed: CitationNode | null; tabs: ExplorationTab[]; created_at: string; updated_at?: string };

function seedSnapshot(seed: Paper | CitationNode): CitationNode {
  return { ...(seed as CitationNode), id: String(seed.id), relation: 'focus' };
}

/** Citation explorations are saved automatically and can be resumed from the library. */
export function useExplorations() {
  const { state } = useRuntime();
  const [paper, setPaper] = useState<Paper | CitationNode | null>(null);
  const [resumeTabs, setResumeTabs] = useState<ExplorationTab[] | null>(null);
  const [explorations, setExplorations] = useState<SavedExploration[] | null>(null);
  const [identifier, setIdentifier] = useState('');
  const [lookupPreview, setLookupPreview] = useState<LookupPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lookup = useRef<AbortController | null>(null);
  const recordId = useRef<number | null>(null);
  useEffect(() => () => lookup.current?.abort(), []);

  async function load() {
    try { setExplorations(await api<SavedExploration[]>('/discovery/explorations')); }
    catch { setExplorations([]); }
  }
  useEffect(() => { void load(); }, []);

  /** Library papers keep their numeric id; looked-up articles become external graph seeds. */
  function asSeed(seed: Paper | CitationNode | LookupPreview): Paper | CitationNode {
    if ('id' in seed) return seed;
    return { ...seed, id: `external:${seed.doi || seed.url || seed.title}`, relation: 'focus' } as unknown as CitationNode;
  }

  async function start(input: Paper | CitationNode | LookupPreview) {
    const seed = asSeed(input);
    lookup.current?.abort(); setBusy(false); setError('');
    recordId.current = null;
    setResumeTabs(null);
    setPaper(seed);
    try {
      const record = await api<SavedExploration>('/discovery/explorations', {
        method: 'POST',
        body: JSON.stringify({ title: seed.title, kind: typeof seed.id === 'number' ? 'library' : 'external', paper_id: typeof seed.id === 'number' ? seed.id : null, seed: seedSnapshot(seed), tabs: [{ direction: 'all', seed: typeof seed.id === 'string' ? seed as CitationNode : null }] }),
      });
      recordId.current = record.id;
      void load();
    } catch (reason) { toast((reason as Error).message, 'error'); }
  }

  function resume(record: SavedExploration) {
    const seed = record.kind === 'library' && record.paper_id != null
      ? state.papers.find((item: Paper) => item.id === record.paper_id) || record.seed
      : record.seed;
    if (!seed) { toast('The starting article is no longer available.', 'error'); return; }
    recordId.current = record.id;
    setResumeTabs(record.tabs?.length ? record.tabs : [{ direction: 'all', seed: record.kind === 'external' ? record.seed : null }]);
    setPaper(seed);
  }

  async function saveTabs(tabs: ExplorationTab[]) {
    if (!recordId.current) return;
    try {
      await api(`/discovery/explorations/${recordId.current}`, { method: 'PUT', body: JSON.stringify({ tabs }) });
      void load();
    } catch (reason) { toast((reason as Error).message, 'error'); }
  }

  async function remove(id: number) {
    try {
      await api(`/discovery/explorations/${id}`, { method: 'DELETE' });
      if (recordId.current === id) recordId.current = null;
      await load();
      toast('Exploration removed');
    } catch (reason) { toast((reason as Error).message, 'error'); }
  }

  async function exploreIdentifier(event?: FormEvent, value = identifier) {
    event?.preventDefault();
    const identifier = value;
    if (!identifier.trim() || busy) return;
    const controller = new AbortController();
    lookup.current = controller;
    setBusy(true); setError('');
    try {
      const preview = await api<LookupPreview>('/library/import-preview', {
        method: 'POST', body: JSON.stringify({ identifier: identifier.trim() }), signal: controller.signal,
      });
      if (!controller.signal.aborted) setLookupPreview(preview);
    } catch (reason) {
      if (!controller.signal.aborted) setError((reason as Error).message);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return { paper, close: () => setPaper(null), lookupPreview, closeLookup: () => setLookupPreview(null), resumeTabs, explorations, identifier, setIdentifier, busy, error, start, resume, saveTabs, remove, exploreIdentifier };
}
