import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { api } from '../services/api';
import { refreshData, toast } from '../app/navigation';
import { publish } from '../app/viewBridge';
import { ViewHeader } from './ViewLayout';

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


export function CollectionHeader({ icon, title, count, description, children }: { icon?: string; title: ReactNode; count?: number; description: string; children?: ReactNode }) {
  return <ViewHeader icon={icon} title={title} count={count} subtitle={description}>{children}</ViewHeader>;
}



export function RecordActions({ title, children }: { title: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) ref.current.open = false; };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, []);
  return <details ref={ref} className="record-actions" onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape' && ref.current) { ref.current.open = false; ref.current.querySelector('summary')?.focus(); } }}>
    <summary aria-label={`More actions for ${title}`} title="Actions">···</summary><div className="record-actions-panel">{children}</div>
  </details>;
}
