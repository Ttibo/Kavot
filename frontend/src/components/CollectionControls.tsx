import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon } from './Icon';
import { api } from '../services/api';
import { refreshData, toast } from '../app/navigation';
import { publish } from '../app/viewBridge';

export function DeleteRecordButton({ endpoint, title, message, onBeforeDelete, onDeleted, iconOnly = false }: { endpoint: string; title: string; message?: string; onBeforeDelete?: () => void | Promise<void>; onDeleted?: () => void | Promise<void>; iconOnly?: boolean }) {
  const [busy, setBusy] = useState(false);
  return <button type="button" className={`button button-small button-danger collection-delete-button${iconOnly ? ' icon-only' : ''}`} disabled={busy} aria-label={`Delete: ${title}`} title={`Delete: ${title}`} onKeyDown={event => event.stopPropagation()} onClick={async event => {
    event.stopPropagation();
    if (!window.confirm(message || `Delete “${title}”? This cannot be undone.`)) return;
    setBusy(true);
    try {
      if (onBeforeDelete) await onBeforeDelete();
      await api(endpoint, { method: 'DELETE' });
      if (onDeleted) await onDeleted();
      else { await refreshData(); publish(); }
      toast('Item deleted');
    } catch (error) { toast(error.message, 'error'); }
    finally { setBusy(false); }
  }}>{iconOnly ? <Icon name="trash" size={16}/> : busy ? 'Deleting…' : 'Delete'}</button>;
}
/** A "···" menu. The panel is placed in viewport coordinates so tables and scrolling lists never clip it. */
export function RecordActions({ title, children }: { title: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const close = () => { if (ref.current) ref.current.open = false; setPlace(null); };
  useEffect(() => {
    if (!place) return;
    const dismiss = (event: PointerEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) close(); };
    const away = (event: Event) => { if (!(event.target instanceof Node && ref.current?.contains(event.target))) close(); };
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('scroll', away, true);
    window.addEventListener('resize', close);
    return () => { document.removeEventListener('pointerdown', dismiss); window.removeEventListener('scroll', away, true); window.removeEventListener('resize', close); };
  }, [place]);
  const onToggle = () => {
    const details = ref.current;
    if (!details?.open) { setPlace(null); return; }
    const box = details.querySelector('summary')!.getBoundingClientRect();
    const below = window.innerHeight - box.bottom;
    setPlace({ position: 'fixed', right: Math.max(8, window.innerWidth - box.right), ...(below < 220 && box.top > below ? { bottom: window.innerHeight - box.top + 4, top: 'auto' } : { top: box.bottom + 4, bottom: 'auto' }) });
  };
  return <details ref={ref} className="record-actions" onToggle={onToggle}
    onClick={event => { if ((event.target as HTMLElement).closest('.record-actions-panel > :is(button, a)')) setTimeout(close); }}
    onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape' && ref.current) { close(); ref.current.querySelector('summary')?.focus(); } }}>
    <summary aria-label={`More actions for ${title}`} title="Actions">···</summary><div className="record-actions-panel" role="menu" style={place || undefined}>{children}</div>
  </details>;
}
