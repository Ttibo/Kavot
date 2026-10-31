import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { OverlayPanel } from './ViewLayout';
import { closeSheet, mountSheet, subscribeSheet, type SheetSpec } from '../features/sheet/sheet';

/** The box of a pane relative to the panel's own parent, kept up to date while the panes move or redraw. */
function usePaneFrame(pane: string | undefined, frame: React.RefObject<HTMLDivElement | null>) {
  const [box, setBox] = useState<CSSProperties>({ inset: 0 });
  useLayoutEffect(() => {
    const parent = frame.current?.parentElement;
    if (!pane || !parent) { setBox({ inset: 0 }); return; }
    let observed: Element | null = null, frameId = 0, last = '';
    const sizes = new ResizeObserver(() => schedule());
    // Typing in a note redraws the editor many times a second: measure at most once a frame, and only re-render on a change.
    const schedule = () => { if (!frameId) frameId = requestAnimationFrame(() => { frameId = 0; measure(); }); };
    const apply = (next: CSSProperties) => { const key = JSON.stringify(next); if (key !== last) { last = key; setBox(next); } };
    function measure() {
      // The editor redraws its panes: find this one again each time.
      const host = document.querySelector<HTMLElement>(`#main-content [data-workspace-pane="${pane}"]`);
      if (host !== observed) { if (observed) sizes.unobserve(observed); if (host) sizes.observe(host); observed = host; }
      if (!host || !parent) return apply({ inset: 0 });
      const outer = parent.getBoundingClientRect(), inner = host.getBoundingClientRect();
      apply({ left: Math.round(inner.left - outer.left), top: Math.round(inner.top - outer.top), width: Math.round(inner.width), height: Math.round(inner.height) });
    }
    measure();
    sizes.observe(parent);
    const main = document.querySelector('#main-content');
    const redraws = new MutationObserver(schedule);
    if (main) redraws.observe(main, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    return () => { cancelAnimationFrame(frameId); sizes.disconnect(); redraws.disconnect(); window.removeEventListener('resize', schedule); };
  }, [pane]);
  return box;
}

/** The record side panel (tasks, events, items), over the right of the view it was opened from, like a
 * collection item: with panes side by side it stays over its own pane. */
export function RecordSheet() {
  const [spec, setSpec] = useState<SheetSpec | null>(null);
  const [title, setTitle] = useState('');
  const body = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => subscribeSheet(next => { setSpec(next); setTitle(next?.title || ''); }), []);
  useEffect(() => {
    const element = body.current;
    if (!spec || !element) return;
    mountSheet(spec, element, setTitle);
    return () => { element.replaceChildren(); };
  }, [spec]);
  const box = usePaneFrame(spec?.pane, frame);
  if (!spec) return <div ref={frame} hidden/>;
  const openInTab = spec.openInTab && (async () => {
    if (await closeSheet()) await spec.openInTab!(spec.pane || 'primary');
  });
  return <div ref={frame} className="record-sheet-frame" style={box}>
    <OverlayPanel className="record-sheet" label={spec.label} title={title} closeLabel="Close the panel" onClose={() => void closeSheet()}
      onOpenInTab={openInTab ? () => void openInTab() : undefined} bodyRef={body}/>
  </div>;
}
