import { ShareButton } from '../components/SharingPanel';
import { Icon } from '../components/Icon';
import { collectionIcon } from '../features/collections/icons';
import { customRecordModal } from '../features/collections/customRecord';
import { CollectionWithPanel } from '../components/CollectionRecordPanel';
import { useRuntime } from '../app/runtime';
import { publish } from '../app/viewBridge';
import { toast } from '../app/navigation';
import { api } from '../services/api';
import { EmptyState } from '../components/common';
import { CollectionHeader, DeleteRecordButton } from '../components/CollectionControls';
import { CollectionBrowser, type BrowserProperty, type PropertyType } from '../components/CollectionBrowser';
import { ViewPage } from '../components/ViewLayout';
import { CollectionWatchersButton } from '../features/collections/CollectionWatchers';

const FIELD_TYPES: Record<string, PropertyType> = { text: 'text', markdown: 'text', url: 'url', email: 'email', select: 'select', number: 'number', boolean: 'boolean', date: 'date', datetime: 'date', tags: 'tags' };

export function CollectionsView() {
  const runtime = useRuntime(); const { state } = runtime;
  const database = runtime.collectionDatabaseDefinitions().find((item: any) => item.id === state.collectionId);
  if (!database) return <EmptyState title="Collection not found">Choose a collection from the navigation.</EmptyState>;
  const items = runtime.collectionItems(database.id);
  const values = (item: any) => item.source.values || item.source;
  const projectIds = (item: any) => { const value = values(item); return value.project_ids || value.projects?.map((p: Project) => p.id) || (value.project_id ? [value.project_id] : []); };
  const properties: BrowserProperty<any>[] = [
    { id: 'title', label: 'Title', type: 'text', value: item => item.title },
    ...(database.fields || []).filter((field: any) => FIELD_TYPES[field.type] && !['title', 'name'].includes(field.id))
      .map((field: any) => ({ id: `field:${field.id}`, label: field.name || field.id, type: FIELD_TYPES[field.type], value: (item: any) => values(item)[field.id], options: field.type === 'select' ? (field.options || []).map((option: string) => ({ value: option, label: option })) : undefined, editable: ['text', 'boolean', 'select'].includes(field.type) })),
    { id: 'projects', label: 'Projects', type: 'tags', value: item => state.projects.filter((p: Project) => projectIds(item).includes(p.id)).map((p: Project) => p.name) },
    { id: 'detail', label: 'Preview', type: 'text', value: item => runtime.truncate(item.detail || '', 140) },
    { id: 'updated', label: 'Modified', type: 'date', value: item => item.source.updated_at },
  ];
  const move = async (item: any, propertyId: string, value: unknown) => {
    const field = propertyId.replace(/^field:/, '');
    try {
      const saved = await api<any>(`/databases/${database.id}/records/${item.id}`, { method: 'PATCH', body: JSON.stringify({ values: { ...values(item), [field]: value } }) });
      state.databaseRecords[database.id] = (state.databaseRecords[database.id] || []).map(record => record.id === item.id ? saved : record);
      publish();
    } catch (error) { toast((error as Error).message, 'error'); }
  };
  return <CollectionWithPanel databaseId={database.id}><ViewPage className="database-page collection-page" label={database.name}>
    <CollectionHeader icon={collectionIcon(database)} count={items.length} title={database.name} description="Find, organize and manage the items in your collection."><CollectionWatchersButton collectionId={database.id}/><button className="button button-primary" onClick={() => customRecordModal(database)}>＋ New item</button></CollectionHeader>
    <CollectionBrowser storageKey={`custom.${database.id}`} name={database.name} items={items} properties={properties} defaults={{ view: 'gallery', visible: { gallery: ['detail', 'projects'], list: ['projects', 'updated'], kanban: ['detail'], table: properties.slice(1).map(p => p.id) } }}
      titleProps={item => ({ 'data-collection-open': runtime.collectionDragPayload(item.type, item.id, database.id) })}
      dragPayload={item => runtime.collectionDragPayload(item.type, item.id, database.id)}
      onMove={move}
      actions={item => <><ShareButton source={{kind: 'item', collection: database.id, id: String(item.id)}}/><DeleteRecordButton iconOnly endpoint={'/databases/' + database.id + '/records/' + item.id} title={item.title} onDeleted={() => { state.databaseRecords[database.id] = (state.databaseRecords[database.id] || []).filter(record => record.id !== item.id); publish(); }}/></>}
      empty={<EmptyState icon="▦" title="Empty collection">Items added to this collection will appear here.</EmptyState>}/>
  </ViewPage></CollectionWithPanel>;
}
