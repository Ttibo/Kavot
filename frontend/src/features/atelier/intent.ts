import { useEffect, useState } from 'react';
import type { AtelierSection } from '../projects/navigation';

export type AtelierIntent = { folderId?: string; codeTab?: 'files' | 'map' | 'git'; runId?: string | null; taskId?: number | null; add?: 'code' | 'resources' };
export type AtelierLocation = { projectId: number; section: AtelierSection; folderId?: string; runId?: string | null };
type Pane = 'primary' | 'secondary';

/** What the next Atelier panel of a project section should show (a folder, a conversation…),
 * set by the project sidebar or another section just before opening it. */
const intents = new Map<string, AtelierIntent>();
const key = (projectId: number, section: AtelierSection) => `${projectId}:${section}`;

export function setAtelierIntent(projectId: number, section: AtelierSection, intent: AtelierIntent) {
  intents.set(key(projectId, section), intent);
  // A panel already showing this section applies it now; otherwise the next one does when it mounts.
  window.dispatchEvent(new CustomEvent('kavot:atelier-intent', { detail: { projectId, section } }));
}

export function takeAtelierIntent(projectId: number, section: AtelierSection) {
  const intent = intents.get(key(projectId, section));
  intents.delete(key(projectId, section));
  return intent;
}

/** Something of a project changed (a linked folder or file, an agent run): every panel of it reloads. */
export function notifyAtelierChanged(projectId: number) {
  window.dispatchEvent(new CustomEvent('kavot:atelier-changed', { detail: { projectId } }));
}

export function useAtelierChanged(projectId: number, reload: () => void) {
  useEffect(() => {
    const listener = (event: Event) => { if ((event as CustomEvent).detail?.projectId === projectId) reload(); };
    window.addEventListener('kavot:atelier-changed', listener);
    return () => window.removeEventListener('kavot:atelier-changed', listener);
  }, [projectId, reload]);
}

/** What each pane's Atelier shows, so the project sidebar can highlight where the user is. */
const locations: Partial<Record<Pane, AtelierLocation>> = {};

export function setAtelierLocation(pane: Pane, location: AtelierLocation) {
  locations[pane] = location;
  window.dispatchEvent(new Event('kavot:atelier-location'));
}

/** Forgets a pane's location, unless a newer panel of that pane already replaced it. */
export function clearAtelierLocation(pane: Pane, location: AtelierLocation) {
  if (locations[pane] !== location) return;
  delete locations[pane];
  window.dispatchEvent(new Event('kavot:atelier-location'));
}

export function useAtelierLocations() {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion(value => value + 1);
    window.addEventListener('kavot:atelier-location', listener);
    return () => window.removeEventListener('kavot:atelier-location', listener);
  }, []);
  return locations;
}
