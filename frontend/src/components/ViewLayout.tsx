import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react';
import { Icon } from './Icon';

/** Every management view: one header, optional toolbar, a body that fills the
 * remaining height without page scroll, and an optional pagination footer. */
export function ViewPage({ className = '', children, label, style }: { className?: string; children: ReactNode; label?: string; style?: CSSProperties }) {
  return <section className={`view-page ${className}`} aria-label={label} style={style}>{children}</section>;
}

export function ViewHeader({ icon, title, count, subtitle, children }: { icon?: string; title: ReactNode; count?: number | string; subtitle?: ReactNode; children?: ReactNode }) {
  return <header className="view-header">
    <div className="view-header-title">
      {icon && <Icon name={icon} size={16}/>}
      <h1>{title}</h1>
      {count !== undefined && <span className="view-header-count">{count}</span>}
      {subtitle && <span className="view-header-subtitle">{subtitle}</span>}
    </div>
    {children && <div className="view-header-actions">{children}</div>}
  </header>;
}

export function ViewToolbar({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`view-toolbar ${className}`}>{children}</div>;
}

/** Page numbers around the current one, with gaps marked as null. */
function pageWindow(page: number, pages: number) {
  const wanted = new Set([1, pages, page - 1, page, page + 1].filter(value => value >= 1 && value <= pages));
  const sorted = [...wanted].sort((a, b) => a - b);
  const result: (number | null)[] = [];
  sorted.forEach((value, index) => { if (index && value - sorted[index - 1] > 1) result.push(null); result.push(value); });
  return result;
}

export function Pagination({ page, pages, total, from, to, onPage, compact = false, label = 'Pages' }: {
  page: number; pages: number; total: number; from: number; to: number; onPage: (page: number) => void; compact?: boolean; label?: string;
}) {
  // A single compact page keeps the footer's place hidden: the list height never depends on the page count.
  const idle = compact && pages <= 1;
  return <nav className={`view-pagination${compact ? ' compact' : ''}${idle ? ' is-idle' : ''}`} aria-label={label} aria-hidden={idle || undefined}>
    {!compact && <span className="view-pagination-range" aria-live="polite">{total ? `${from}–${to} of ${total}` : 'No items'}</span>}
    <div className="view-pagination-controls">
      <button type="button" className="view-page-button" disabled={page <= 1} aria-label="Previous page" onClick={() => onPage(page - 1)}><Icon name="back" size={13}/></button>
      {compact ? <span className="view-page-status">{page} / {pages}</span>
        : pageWindow(page, pages).map((value, index) => value === null
          ? <span key={`gap-${index}`} className="view-page-gap">…</span>
          : <button key={value} type="button" className="view-page-button" aria-current={value === page ? 'page' : undefined} onClick={() => onPage(value)}>{value}</button>)}
      <button type="button" className="view-page-button" disabled={page >= pages} aria-label="Next page" onClick={() => onPage(page + 1)}><Icon name="chevron" size={13}/></button>
    </div>
  </nav>;
}

/**
 * Shows only as many items as fit in the body element (`ref`), so views never scroll.
 * Items are the children of the `data-fit-list` element (or elements marked
 * `data-fit-item`); the page size follows the body's size and shrinks when taller
 * items would overflow.
 */
export function useFitPagination<T>(items: T[], options: { page?: number; onPage?: (page: number) => void; resetKey?: unknown; initial?: number } = {}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(options.initial ?? 12);
  const [localPage, setLocalPage] = useState(1);
  const [estimateTick, setEstimateTick] = useState(0);
  const controlled = options.page !== undefined;
  const pages = Math.max(1, Math.ceil(items.length / size));
  const page = Math.min(Math.max(1, controlled ? options.page! : localPage), pages);
  const setPage = useCallback((next: number) => { if (controlled) options.onPage?.(next); else setLocalPage(next); }, [controlled, options.onPage]);
  const start = (page - 1) * size;
  const pageItems = items.slice(start, start + size);

  useEffect(() => { if (!controlled) setLocalPage(1); }, [options.resetKey, controlled]);

  // Re-estimate when the body changes size.
  useEffect(() => {
    const body = ref.current;
    if (!body || typeof ResizeObserver === 'undefined') return;
    let width = body.clientWidth, height = body.clientHeight;
    const observer = new ResizeObserver(() => {
      if (body.clientWidth === width && body.clientHeight === height) return;
      width = body.clientWidth; height = body.clientHeight;
      setEstimateTick(tick => tick + 1);
    });
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  // Estimate from the rendered items, then shrink while the body still overflows.
  const estimated = useRef(-1);
  useLayoutEffect(() => {
    const body = ref.current;
    if (!body || !body.clientHeight) return;
    const list = body.querySelector<HTMLElement>('[data-fit-list]');
    const nodes = list ? [...list.children] as HTMLElement[] : [...body.querySelectorAll<HTMLElement>('[data-fit-item]')];
    if (!nodes.length) return;
    const top = body.getBoundingClientRect().top;
    const firstTop = nodes[0].getBoundingClientRect().top;
    const perRow = Math.max(1, nodes.filter(node => Math.abs(node.getBoundingClientRect().top - firstTop) < 2).length);
    if (estimated.current !== estimateTick) {
      estimated.current = estimateTick;
      const last = nodes[nodes.length - 1].getBoundingClientRect();
      const rows = Math.ceil(nodes.length / perRow);
      const parent = getComputedStyle(nodes[0].parentElement!);
      const gap = parseFloat(parent.rowGap) || 0;
      const pitch = rows > 1 ? (last.top - firstTop) / (rows - 1) : last.height + gap;
      const reserved = firstTop - top + (parseFloat(getComputedStyle(body).paddingBottom) || 0);
      const fit = Math.max(1, Math.floor((body.clientHeight - reserved + gap) / Math.max(pitch, 1)));
      const next = fit * perRow;
      if (next !== size) { setSize(next); return; }
    }
    if (body.scrollHeight > body.clientHeight + 1 && size > perRow) setSize(size - perRow);
  });
  // A new list or a resize restarts the estimate.
  useEffect(() => { setEstimateTick(tick => tick + 1); }, [items.length, options.resetKey]);

  return { ref, page, pages, setPage, pageItems, size, total: items.length, from: items.length ? start + 1 : 0, to: Math.min(start + size, items.length) };
}

/** A list whose page size fits its own height, with a pagination footer. */
export function FitList<T>({ items, render, className = '', listClassName = '', header, empty, compact = false, label, resetKey }: {
  items: T[]; render: (item: T) => ReactNode; className?: string; listClassName?: string; header?: ReactNode; empty?: ReactNode; compact?: boolean; label?: string; resetKey?: unknown;
}) {
  const fit = useFitPagination(items, { resetKey });
  return <div className={`fit-list ${className}`}>
    <div className="fit-body" ref={fit.ref}>{items.length ? <>{header}<div className={`fit-items ${listClassName}`} data-fit-list>{fit.pageItems.map(render)}</div></> : empty}</div>
    {items.length > 0 && <Pagination compact={compact} label={label} page={fit.page} pages={fit.pages} total={fit.total} from={fit.from} to={fit.to} onPage={fit.setPage}/>}
  </div>;
}

const PANEL_WIDTH_KEY = 'kavot-collection-panel-width';
const PANEL_MIN_WIDTH = 25;
const readPanelWidth = () => {
  try { const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY)); return saved >= PANEL_MIN_WIDTH && saved <= 100 ? saved : 40; }
  catch { return 40; }
};
const savePanelWidth = (value: number) => { try { localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(value))); } catch { /* per-viewer preference only */ } };

/** Detail panel shown over a view, on the right: 40% of the width by default,
 * resizable from its left edge and expandable to the full width. Its parent must be positioned. */
export function OverlayPanel({ label, title, actions, onClose, closeLabel = 'Close the panel', className = '', bodyRef, children }: { label: string; title: ReactNode; actions?: ReactNode; onClose: () => void; closeLabel?: string; className?: string; bodyRef?: Ref<HTMLDivElement>; children?: ReactNode }) {
  const panel = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(readPanelWidth);
  const [expanded, setExpanded] = useState(false);
  const dragging = useRef(false);
  const resizeTo = (clientX: number) => {
    const box = panel.current?.parentElement?.getBoundingClientRect();
    if (!box?.width) return;
    setExpanded(false);
    setWidth(Math.max(PANEL_MIN_WIDTH, Math.min(100, (box.right - clientX) / box.width * 100)));
  };
  return <aside ref={panel} className={`overlay-panel ${className}${expanded ? ' is-expanded' : ''}`} style={{ width: expanded ? '100%' : `${width}%` }} aria-label={label}
    onKeyDown={event => { if (event.key === 'Escape' && !(event.target as HTMLElement).closest('.rich-content')) onClose(); }}>
    <div className="overlay-panel-resizer" role="separator" tabIndex={0} aria-orientation="vertical" aria-label="Resize the panel" aria-valuemin={PANEL_MIN_WIDTH} aria-valuemax={100} aria-valuenow={Math.round(expanded ? 100 : width)} title="Drag to resize · Double-click to reset"
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (dragging.current) resizeTo(event.clientX); }}
      onPointerUp={event => { if (!dragging.current) return; dragging.current = false; event.currentTarget.releasePointerCapture(event.pointerId); setWidth(current => { savePanelWidth(current); return current; }); }}
      onPointerCancel={() => { dragging.current = false; }}
      onDoubleClick={() => { setExpanded(false); setWidth(40); savePanelWidth(40); }}
      onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return; event.preventDefault(); setExpanded(false); setWidth(current => { const next = Math.max(PANEL_MIN_WIDTH, Math.min(100, current + (event.key === 'ArrowLeft' ? 5 : -5))); savePanelWidth(next); return next; }); }}/>
    <div className="overlay-panel-actions">
      <strong className="overlay-panel-title">{title}</strong>
      {actions}
      <button className="icon-button" aria-label={expanded ? 'Restore the panel width' : 'Expand the panel'} aria-pressed={expanded} title={expanded ? 'Restore width' : 'Expand'} onClick={() => setExpanded(value => !value)}><Icon name="panel" size={14}/></button>
      <button className="icon-button" aria-label={closeLabel} title="Close" onClick={onClose}><Icon name="close" size={14}/></button>
    </div>
    <div className="overlay-panel-body" ref={bodyRef}>{children}</div>
  </aside>;
}
