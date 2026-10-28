import { useEffect, useState } from 'react';
import { navigate } from '../../app/navigation';
import { Icon } from '../../components/Icon';
import { api } from '../../services/api';

/** What the Watchers page should show when it opens: a collection filter, or a new watcher for it. */
export type WatcherIntent = { collectionId?: string; create?: boolean; watcherId?: number };
let intent: WatcherIntent | null = null;

export function openWatchers(next: WatcherIntent = {}) {
  intent = next;
  void navigate('watchers');
}

export function takeWatcherIntent() {
  const value = intent;
  intent = null;
  return value;
}

type Summary = { id: number; collection_id: string; pending_count: number; running: boolean };

export function CollectionWatchersButton({ collectionId }: { collectionId: string }) {
  const [watchers, setWatchers] = useState<Summary[]>([]);
  useEffect(() => {
    void api<Summary[]>(`/watchers?collection_id=${encodeURIComponent(collectionId)}`).then(setWatchers).catch(() => setWatchers([]));
  }, [collectionId]);
  const pending = watchers.reduce((total, watcher) => total + watcher.pending_count, 0);
  return <button type="button" className="button" title="Agents that keep this collection up to date"
    onClick={() => openWatchers(watchers.length ? { collectionId } : { collectionId, create: true })}>
    <Icon name="sparkle" size={14}/> {watchers.length ? `Watchers · ${watchers.length}` : 'Add a watcher'}
    {pending > 0 && <b className="watch-agent-badge" style={{ marginLeft: 6, marginRight: 0 }}>{pending}</b>}
  </button>;
}
