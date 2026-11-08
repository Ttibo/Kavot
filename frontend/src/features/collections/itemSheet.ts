import { openCollectionItem } from './catalog';

type Reference = { type: string; id: string | number; databaseId?: string };

/** Opens an item of a canvas card: a task in the side panel of the Tasks page, an article in its reader. */
export async function openItemInSheet(reference: Reference, onSaved?: () => void | Promise<void>) {
  if (reference.type === 'task') {
    const { newTaskModal } = await import('../tasks/dialogs');
    return newTaskModal(null, null, Number(reference.id), onSaved || null);
  }
  return openCollectionItem(reference);
}
