import { iconPaths } from '../../components/Icon';

export const collectionIcons = [
  ['database', 'Database'], ['folder', 'Folder'], ['notes', 'Note'], ['papers', 'Article'],
  ['tasks', 'Tasks'], ['calendar', 'Calendrier'], ['canvas', 'Canvas'], ['conferences', 'Personnes'],
  ['link', 'Link'], ['local', 'Computer'], ['sparkle', 'Star'], ['archive', 'Archive'],
];
export function collectionIcon(database?: { id: string; icon?: string }) {
  if (collectionIcons.some(([id]) => id === database?.icon)) return database.icon;
  return ({ articles: 'papers', notes: 'canvas', tasks: 'tasks', conferences: 'conferences', datasets: 'database' })[database?.id] || 'database';
}
export function collectionIconMarkup(database?: { id: string; icon?: string }) {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${iconPaths[collectionIcon(database)]}"/></svg>`;
}
