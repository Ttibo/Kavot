import { publish } from '../../app/viewBridge';
import { toast } from '../../app/navigation';
import { findCollectionItem, openCollectionItem } from './catalog';

type Reference = { type: string; id: string | number; databaseId?: string };

/** Opens a collection item (task, conference, dataset, custom record) in the side panel over the page,
 * like a task of the Tasks page. Articles keep their PDF reader. */
export async function openItemInSheet(reference: Reference, onSaved?: () => void | Promise<void>) {
  if (reference.type === 'paper') return openCollectionItem(reference);
  if (reference.type === 'task') {
    const { newTaskModal } = await import('../tasks/dialogs');
    return newTaskModal(null, null, Number(reference.id), onSaved || null);
  }
  const target = { ...reference, databaseId: reference.databaseId || ({ conference: 'conferences', dataset: 'datasets' } as Record<string, string>)[reference.type] };
  const item = findCollectionItem(target);
  if (!item) return toast('Item not found', 'error');
  const [{ collectionRecordMarkup, bindCollectionEditors, flushCollectionSaves }, { openSheet }] = await Promise.all([import('./noteEditor'), import('../sheet/sheet')]);
  void openSheet({
    key: `record:${target.databaseId || target.type}:${target.id}`,
    title: item.title || 'Item',
    label: 'Item editor',
    mount: body => {
      body.innerHTML = collectionRecordMarkup({ content: target, title: item.title || '' }, 'panel');
      bindCollectionEditors(body, { onSaved: () => { publish(); void onSaved?.(); } });
      return { beforeClose: async () => { await flushCollectionSaves(); return true; } };
    },
  });
}
