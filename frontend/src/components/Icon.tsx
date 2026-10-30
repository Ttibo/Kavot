import type { CSSProperties } from 'react';

export const iconPaths: Record<string, string> = {
  sparkle: 'M12 2.5c.7 4.7 2.8 6.8 7.5 7.5-4.7.7-6.8 2.8-7.5 7.5-.7-4.7-2.8-6.8-7.5-7.5 4.7-.7 6.8-2.8 7.5-7.5zM19 16.5c.25 1.7 1.05 2.5 2.5 2.75-1.45.25-2.25 1.05-2.5 2.75-.25-1.7-1.05-2.5-2.5-2.75 1.45-.25 2.25-1.05 2.5-2.75z',
  home: 'm3 10 9-7 9 7M5 9v11h5v-6h4v6h5V9',
  workflow: 'M3 4h6v5H3zM15 4h6v5h-6zM9 15h6v5H9zM9 6.5h6M6 9v3.5h6V15M18 9v3.5h-6',
  projects: 'M3 5h7l2 3h9v12H3zM8 12h8M12 10v7',
  notes: 'M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6',
  papers: 'M5 4h14v17H5zM8 4V2h8v2M8 9h8M8 13h8M8 17h5',
  tasks: 'M8 4h12v16H4V8M2 4l3 3 5-5M8 11h8M8 16h8',
  calendar: 'M4 5h16v16H4zM8 2v6M16 2v6M4 10h16M8 14h2M14 14h2',
  canvas: 'M3 3h7v6H3zM14 15h7v6h-7zM15 3h6v6h-6zM7 9v9h7M10 6h5',
  settings: 'm12 3 2 3 3-1 2 3-2 3 2 3-2 3-3-1-2 3-3-2-3 1-2-3 2-3-2-3 2-3 3 1zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  search: 'M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15M16 16l5 5',
  plus: 'M12 4v16M4 12h16',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  chevron: 'm9 5 7 7-7 7',
  folder: 'M3 5h7l2 3h9v12H3z',
  database: 'M4 6c0-4 16-4 16 0s-16 4-16 0v12c0 4 16 4 16 0V6M4 12c0 4 16 4 16 0',
  conferences: 'M8 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M2 21v-3c0-6 12-6 12 0v3M17 4a4 4 0 0 1 0 8M18 15c4 0 4 3 4 6',
  link: 'm10 7 3-3a5 5 0 0 1 7 7l-3 3M14 17l-3 3a5 5 0 0 1-7-7l3-3M8 16l8-8',
  local: 'M4 4h16v12H4zM8 21h8M12 16v5',
  close: 'm6 6 12 12M6 18 18 6',
  menu: 'M4 6h16M4 12h16M4 18h16',
  panel: 'M3 4h18v16H3zM15 4v16',
  sidebar: 'M3 4h18v16H3zM9 4v16',
  back: 'm15 5-7 7 7 7',
  code: 'm8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16',
  graph: 'M6 3.75a2.25 2.25 0 1 0 0 4.5 2.25 2.25 0 0 0 0-4.5M18 5.75a2.25 2.25 0 1 0 0 4.5 2.25 2.25 0 0 0 0-4.5M9 15.75a2.25 2.25 0 1 0 0 4.5 2.25 2.25 0 0 0 0-4.5M8.2 6.3l7.6 1.4M6.5 8.2l1.9 7.6M10.6 16.4l6-6.8',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  edit: 'm14 4 6 6M4 20l1-6L16 3l5 5L10 19z',
  check: 'm5 12 4 4L19 6',
  archive: 'M4 5h16v4H4zM6 9v11h12V9M10 13h4',
  chat: 'M4 5h16v11H9l-5 4zM8 9h8M8 12.5h5',
  agents: 'M12 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6M5 21v-2a7 7 0 0 1 14 0v2M19 4l1.5-1.5M5 4 3.5 2.5',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
};

export function Icon({ name, size = 18, style }: { name: string; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}><path d={iconPaths[name] || iconPaths.notes}/></svg>;
}
