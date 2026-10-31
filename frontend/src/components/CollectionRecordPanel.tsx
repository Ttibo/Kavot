import { useEffect, useRef, type ReactNode } from 'react';
import { useRuntime } from '../app/runtime';
import { publish } from '../app/viewBridge';
import { OverlayPanel } from './ViewLayout';
import { paneOf } from '../features/sheet/sheet';
import { findCollectionItem } from '../features/collections/catalog';
import { bindCollectionEditors, collectionRecordMarkup, discardNewCollectionDraft, flushCollectionSaves, isNewCollectionItem, openCollectionInNotes } from '../features/collections/noteEditor';

/** Collection page with the selected (or new) item open over the list, in the HTML note editor. */
export function CollectionWithPanel({ databaseId, children }: { databaseId: string; children: ReactNode }) {
  const { state } = useRuntime();
  const reference = state.collectionPanel?.databaseId === databaseId ? state.collectionPanel : null;
  const host = useRef<HTMLDivElement>(null);
  // A new item keeps its editor when its first save gives it an id.
  const key = reference ? reference.session ? `new/${reference.session}` : `${reference.databaseId}/${reference.type}/${reference.id}` : '';
  // The editor owns the panel body: it is built once per item, not on every data refresh.
  useEffect(() => {
    const element = host.current;
    if (!element || !reference) return;
    const item = isNewCollectionItem(reference) ? null : findCollectionItem(reference);
    element.innerHTML = collectionRecordMarkup({ content: reference, title: item?.title || '' }, 'panel');
    bindCollectionEditors(element, { onSaved: publish });
    element.querySelector<HTMLInputElement>('[data-record-title]')?.focus({ preventScroll: true });
    return () => { void flushCollectionSaves().then(publish, () => {}).finally(() => discardNewCollectionDraft(reference)); element.replaceChildren(); };
  }, [key]);
  // Leaving the page closes the panel.
  useEffect(() => () => { if (state.collectionPanel?.databaseId === databaseId) state.collectionPanel = null; }, [databaseId]);
  const close = () => { state.collectionPanel = null; publish(); };
  const isNew = reference && isNewCollectionItem(reference);
  const openInTab = () => {
    const target = reference, pane = paneOf(host.current)?.dataset.workspacePane;
    close();
    void openCollectionInNotes(target, { newTab: true, pane });
  };
  return <div className={`collection-split ${reference ? 'has-panel' : ''}`}>
    <div className="collection-split-main">{children}</div>
    {reference && <OverlayPanel className="collection-record-panel" label={isNew ? 'New item editor' : 'Item editor'} title={isNew ? 'New item' : 'Item'} closeLabel="Close the item" onClose={close} bodyRef={host}
      onOpenInTab={isNew ? undefined : openInTab}/>}
  </div>;
}
