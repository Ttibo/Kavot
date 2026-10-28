import { DeleteRecordButton, CollectionHeader } from '../components/CollectionControls';
import { CollectionBrowser, type BrowserProperty } from '../components/CollectionBrowser';
import { toast } from '../app/navigation';
import { useEffect, useState } from 'react';
import { useRuntime } from '../app/runtime';
import { EmptyState } from '../components/common';
import { Icon } from '../components/Icon';
import { api } from '../services/api';
import { conferenceStatusLabels, datasetStatusLabels } from '../features/research/actions';
import { newRegistryItemModal } from '../features/collections/customRecord';
import { openCollectionPanel } from '../features/collections/catalog';
import { CollectionWithPanel } from '../components/CollectionRecordPanel';
import { ViewPage } from '../components/ViewLayout';
import { CollectionWatchersButton } from '../features/collections/CollectionWatchers';

const dateValue = (value?: string) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : Infinity;
const nextDeadline = (item: any, now: number) => [...(item.deadlines || [])].filter(deadline => dateValue(deadline.due_at) >= now).sort((a, b) => dateValue(a.due_at) - dateValue(b.due_at))[0];
const linkedNames = (ids: number[] = [], records: any[]) => records.filter(record => ids.includes(record.id)).map(record => record.name);
const projectMatch = (item: any, project: string) => project === 'all' || (project === 'none' ? !item.project_ids?.length : item.project_ids?.includes(Number(project)));

/** Active records come from state; archived ones are fetched only when asked for. */
function useRegistryRecords(collection: 'conferences' | 'datasets', includeArchived: boolean, activeRecords: any[]) {
  const [archive, setArchive] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!includeArchived) { setError(''); setLoading(false); return; }
    let cancelled = false;
    setLoading(true); setError('');
    api<any[]>(`/${collection}?include_archived=true`).then(records => {
      if (!cancelled) setArchive(records.filter(record => (record.status || record.access_status) === 'archived'));
    }).catch(() => { if (!cancelled) setError('Could not load archived records. Try again.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [collection, includeArchived, activeRecords]);
  return { records: includeArchived ? [...activeRecords, ...archive] : activeRecords, loading, error };
}

function ArchiveToggle({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
  return <label className="cb-archive-toggle"><input type="checkbox" checked={value} onChange={event => onChange(event.target.checked)}/> Archives</label>;
}

/** Status moves from the kanban send the whole record, as the API expects. */
async function saveRecord(collection: 'conferences' | 'datasets', record: any, patch: Record<string, unknown>, refresh: () => Promise<void>) {
  try {
    await api(`/${collection}/${record.id}`, { method: 'PATCH', body: JSON.stringify({ ...record, ...patch }) });
    await refresh();
  } catch (error) { toast((error as Error).message, 'error'); }
}

export function ConferencesView() {
  const runtime = useRuntime();
  const { state } = runtime;
  const [includeArchived, setIncludeArchived] = useState(false);
  const projectFilter = state.conferenceProjectFilter;
  const project = state.projects.find((item: Project) => item.id === Number(projectFilter));
  const { records, loading, error } = useRegistryRecords('conferences', includeArchived, state.conferences);
  const scoped = records.filter((item: any) => projectMatch(item, projectFilter));
  const now = Date.now();
  const local = new Date(now);
  const today = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
  const phase = (item: any) => !item.starts_at ? 'unknown' : item.starts_at > today ? 'upcoming' : (item.ends_at || item.starts_at) < today ? 'past' : 'ongoing';
  const statusOptions = Object.entries(conferenceStatusLabels).map(([value, label]) => ({ value, label: String(label) }));
  const properties: BrowserProperty<any>[] = [
    { id: 'name', label: 'Name', type: 'text', value: item => item.name },
    { id: 'status', label: 'Status', type: 'select', options: statusOptions, value: item => item.status, editable: true },
    { id: 'acronym', label: 'Acronyme', type: 'text', value: item => item.acronym },
    { id: 'edition', label: 'Edition', type: 'text', value: item => item.edition },
    { id: 'location', label: 'Lieu', type: 'text', value: item => item.location },
    { id: 'starts_at', label: 'Start', type: 'date', value: item => item.starts_at },
    { id: 'ends_at', label: 'Fin', type: 'date', value: item => item.ends_at },
    { id: 'deadline', label: 'Next deadline', type: 'date', value: item => nextDeadline(item, now)?.due_at },
    { id: 'deadline_label', label: 'Due', type: 'text', value: item => nextDeadline(item, now)?.label },
    { id: 'period', label: 'Period', type: 'select', options: [{ value: 'upcoming', label: 'Upcoming' }, { value: 'ongoing', label: 'En cours' }, { value: 'past', label: 'Past' }, { value: 'unknown', label: 'Dates to be confirmed' }], value: phase },
    { id: 'projects', label: 'Projects', type: 'tags', value: item => linkedNames(item.project_ids, state.projects) },
    { id: 'datasets', label: 'Datasets', type: 'tags', value: item => linkedNames(item.dataset_ids, state.datasets) },
    { id: 'updated_at', label: 'Modified', type: 'date', value: item => item.updated_at },
  ];
  return <CollectionWithPanel databaseId="conferences"><ViewPage className="research-registry" label="Conferences">
    <CollectionHeader icon="conferences" count={scoped.length} title={project ? `${project.name} · Conferences` : 'Conferences'} description="Discover your next opportunity. Keep submissions and key dates in view."><CollectionWatchersButton collectionId="conferences"/><button className="button button-primary" onClick={() => newRegistryItemModal('conference')}><Icon name="plus" size={14}/> New conference</button></CollectionHeader>
    {error && <p role="alert">{error}</p>}
    <CollectionBrowser storageKey="conferences" name="Conferences" noun="conferences" items={scoped} properties={properties}
      defaults={{ view: 'gallery', sort: 'deadline', groupBy: 'status', visible: { gallery: ['status', 'location', 'starts_at', 'deadline', 'projects'], list: ['status', 'starts_at', 'deadline'], kanban: ['starts_at', 'deadline'], table: ['status', 'acronym', 'location', 'starts_at', 'deadline', 'deadline_label', 'projects', 'datasets'] } }}
      toolbarExtra={<>{loading && <span className="cb-hint" role="status">Loading archived conferences…</span>}<ArchiveToggle value={includeArchived} onChange={setIncludeArchived}/></>}
      titleProps={item => ({ onClick: () => state.conferences.some((record: any) => record.id === item.id) ? void openCollectionPanel({ type: 'conference', id: item.id, databaseId: 'conferences' }) : runtime.conferenceModal(item.id, { record: item }) })}
      dragPayload={item => runtime.collectionDragPayload('conference', item.id, 'conferences')}
      onMove={(item, property, value) => saveRecord('conferences', item, { [property]: value }, () => runtime.refreshData())}
      actions={item => <DeleteRecordButton iconOnly endpoint={'/conferences/' + item.id} title={item.name}/>}
      empty={<EmptyState icon="◇" title="Your next research opportunity starts here" action="new-conference" actionLabel="Add conference">Add a conference, connect your projects, and track each submission deadline.</EmptyState>}/>
  </ViewPage></CollectionWithPanel>;
}

export function DatasetsView() {
  const runtime = useRuntime();
  const { state } = runtime;
  const [includeArchived, setIncludeArchived] = useState(false);
  const projectFilter = state.datasetProjectFilter;
  const project = state.projects.find((item: Project) => item.id === Number(projectFilter));
  const { records, loading, error } = useRegistryRecords('datasets', includeArchived, state.datasets);
  const scoped = records.filter((item: any) => projectMatch(item, projectFilter));
  const accessOptions = Object.entries(datasetStatusLabels).map(([value, label]) => ({ value, label: String(label) }));
  const properties: BrowserProperty<any>[] = [
    { id: 'name', label: 'Name', type: 'text', value: item => item.name },
    { id: 'access_status', label: 'Access', type: 'select', options: accessOptions, value: item => item.access_status, editable: true },
    { id: 'description', label: 'Description', type: 'text', value: item => runtime.truncate(item.description || item.notes || '', 160) },
    { id: 'version', label: 'Version', type: 'text', value: item => item.version },
    { id: 'license', label: 'Licence', type: 'text', value: item => item.license, editable: true },
    { id: 'location', label: 'Emplacement', type: 'select', options: [{ value: 'both', label: 'Local + online' }, { value: 'local', label: 'Chemin local' }, { value: 'online', label: 'Online source' }, { value: 'missing', label: 'No location' }], value: item => item.local_path && item.url ? 'both' : item.local_path ? 'local' : item.url ? 'online' : 'missing' },
    { id: 'url', label: 'URL', type: 'text', value: item => item.url },
    { id: 'local_path', label: 'Chemin local', type: 'text', value: item => item.local_path },
    { id: 'projects', label: 'Projects', type: 'tags', value: item => linkedNames(item.project_ids, state.projects) },
    { id: 'conferences', label: 'Conferences', type: 'tags', value: item => linkedNames(item.conference_ids, state.conferences) },
    { id: 'updated_at', label: 'Modified', type: 'date', value: item => item.updated_at },
  ];
  return <CollectionWithPanel databaseId="datasets"><ViewPage className="research-registry" label="Datasets">
    <CollectionHeader icon="database" count={scoped.length} title={project ? `${project.name} · Datasets` : 'Datasets'} description="A clear view of your data, its provenance, and where it can be used."><CollectionWatchersButton collectionId="datasets"/><button className="button button-primary" onClick={() => newRegistryItemModal('dataset')}><Icon name="plus" size={14}/> New dataset</button></CollectionHeader>
    {error && <p role="alert">{error}</p>}
    <CollectionBrowser storageKey="datasets" name="Datasets" noun="datasets" items={scoped} properties={properties}
      defaults={{ view: 'gallery', sort: 'name', groupBy: 'access_status', visible: { gallery: ['access_status', 'description', 'license', 'projects'], list: ['access_status', 'version', 'license'], kanban: ['license', 'projects'], table: ['access_status', 'version', 'license', 'location', 'projects', 'conferences', 'updated_at'] } }}
      toolbarExtra={<>{loading && <span className="cb-hint" role="status">Loading archived datasets…</span>}<ArchiveToggle value={includeArchived} onChange={setIncludeArchived}/></>}
      titleProps={item => ({ onClick: () => state.datasets.some((record: any) => record.id === item.id) ? void openCollectionPanel({ type: 'dataset', id: item.id, databaseId: 'datasets' }) : runtime.datasetModal(item.id, { record: item }) })}
      dragPayload={item => runtime.collectionDragPayload('dataset', item.id, 'datasets')}
      onMove={(item, property, value) => saveRecord('datasets', item, { [property]: value }, () => runtime.refreshData())}
      actions={item => <DeleteRecordButton iconOnly endpoint={'/datasets/' + item.id} title={item.name}/>}
      empty={<EmptyState icon="▦" title="Build your research data collection" action="new-dataset" actionLabel="Add dataset">Document your first dataset and link it to the projects that use it.</EmptyState>}/>
  </ViewPage></CollectionWithPanel>;
}
