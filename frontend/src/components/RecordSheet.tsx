import { useEffect, useRef, useState } from 'react';
import { OverlayPanel } from './ViewLayout';
import { closeSheet, mountSheet, subscribeSheet, type SheetSpec } from '../features/sheet/sheet';

/** The record side panel (tasks, events), shown over the right of the current page like a collection item. */
export function RecordSheet() {
  const [spec, setSpec] = useState<SheetSpec | null>(null);
  const [title, setTitle] = useState('');
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => subscribeSheet(next => { setSpec(next); setTitle(next?.title || ''); }), []);
  useEffect(() => {
    const element = body.current;
    if (!spec || !element) return;
    mountSheet(spec, element, setTitle);
    return () => { element.replaceChildren(); };
  }, [spec]);
  if (!spec) return null;
  return <OverlayPanel className="record-sheet" label={spec.label} title={title} closeLabel="Close the panel" onClose={() => void closeSheet()} bodyRef={body}/>;
}
