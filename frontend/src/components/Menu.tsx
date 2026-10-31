import { useEffect, useRef, useState, type ReactNode } from 'react';

/** A popup menu anchored under its button, closed by a click outside or Escape. */
export function Menu({ button, label, className = '', menuClassName = '', children }: { button: (open: boolean, toggle: () => void) => ReactNode; label: string; className?: string; menuClassName?: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!host.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape); };
  }, [open]);
  return <div className={`sidebar-menu-host ${className}`} ref={host}>
    {button(open, () => setOpen(value => !value))}
    {open && <div className={`project-switcher-menu popup-menu ${menuClassName}`} role="menu" aria-label={label}>{children(() => setOpen(false))}</div>}
  </div>;
}
