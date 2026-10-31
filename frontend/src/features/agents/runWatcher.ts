import { lockAgentEditors, refreshAgentArtifacts } from '../externalAgents/sync';
import { agents, type Run } from './api';

/** Every agent run is followed here, not by the view that started it: a conversation open in a tab
 * that is hidden or closed still gets its results, and the documents it changed are reloaded.
 *
 * One poller per run (the view's own poll is a listener, not a second timer): the run's state is
 * broadcast with kavot:agent-run-tick while it runs, and kavot:agent-run-finished when it ends.
 */
const watched = new Set<string>();
const listeners = new Set<(run: Run) => void>();

export function onRunUpdate(listener: (run: Run) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function watchRun(run: Pick<Run, 'id' | 'status' | 'mode'> | null | undefined) {
  if (!run || run.status !== 'running' || watched.has(run.id)) return;
  // In /auto the agent writes while it runs: editors stay read-only until it finishes.
  if (run.mode === 'auto') lockAgentEditors(true);
  watched.add(run.id);
  // One request at a time: with a slow server, an earlier "running" answer arriving after the end
  // would put the view back in a run that nobody follows any more.
  const later = () => window.setTimeout(() => void tick(), document.hidden ? 2500 : 1200);
  const tick = async () => {
    let next: Run;
    try { next = await agents.run(run.id); } catch { later(); return; }
    listeners.forEach(listener => { try { listener(next); } catch { /* One view's render must not stop the others. */ } });
    if (next.status === 'running') { later(); return; }
    watched.delete(run.id);
    if (run.mode === 'auto' && ![...watched.keys()].length) lockAgentEditors(false);
    try {
      if (next.modified_files?.length || next.proposals?.some(item => item.status === 'applied')) await refreshAgentArtifacts();
    } finally {
      window.dispatchEvent(new CustomEvent('kavot:agent-run-finished', { detail: { run: next } }));
    }
  };
  later();
}

/** The conversation each place showed last (a pane, a project's Atelier), kept when its view is rebuilt. */
const selections = new Map<string, string | null>();
export const rememberedSelection = (key: string) => selections.get(key) ?? null;
export const rememberSelection = (key: string, id: string | null) => { selections.set(key, id); };
