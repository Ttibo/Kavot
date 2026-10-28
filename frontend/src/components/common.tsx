import type { CSSProperties, ReactNode } from 'react';
import { workspaceColor } from '../styles/palette';

export const cssVars = (values: Record<string, string | number>) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, typeof value === 'string' ? workspaceColor(value) : value])) as CSSProperties;
export function EmptyState({ icon = '◇', title, children, action, actionLabel, onAction }: { icon?: string; title: string; children: ReactNode; action?: string; actionLabel?: string; onAction?: () => void }) {
  return <div className="empty-state"><div className="empty-state-mark">{icon}</div><h3>{title}</h3><p>{children}</p>{(action || onAction) && <button className="button button-primary" data-action={action} onClick={onAction}>{actionLabel}</button>}</div>;
}
export function PageHeader({ title, description, children }: { title: ReactNode; description: string; children?: ReactNode }) {
  return <div className="page-header compact-header"><div><h1>{title}</h1><p>{description}</p></div><div className="header-actions">{children}</div></div>;
}
export function Loading({ children = 'Preparing your research workspace…' }: { children?: ReactNode }) { return <div className="page-loading" role="status"><div className="loading-mark">K</div><p>{children}</p></div>; }
