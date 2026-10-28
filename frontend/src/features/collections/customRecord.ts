import { state } from '../../app/state';
import { publish } from '../../app/viewBridge';
import { discardNewCollectionDraft, flushCollectionSaves } from './noteEditor';

/** Opens an empty item in the collection's side panel, in the same editor as existing items.
 * It is created on its first save, once it has a title and its required fields. */
async function openNewItemPanel(type: 'record' | 'conference' | 'dataset', databaseId: string, projectIds: number[] = []) {
  await flushCollectionSaves();
  const reference = { type, id: 'new', databaseId, session: Date.now(), projectIds };
  discardNewCollectionDraft(reference);
  state.collectionPanel = reference;
  publish();
}

/** Creates an item of a custom collection in the side panel editor. */
export function customRecordModal(database: any) {
  return openNewItemPanel('record', database.id);
}

/** Creates a conference or a dataset in the side panel editor, linked to the project in scope. */
export function newRegistryItemModal(kind: 'conference' | 'dataset') {
  const filter = kind === 'dataset' ? state.datasetProjectFilter : state.conferenceProjectFilter;
  const project = state.projects.find(item => item.id === Number(filter));
  return openNewItemPanel(kind, `${kind}s`, project ? [project.id] : []);
}
