/** Fields of the Conferences and Datasets collections, described like the fields of custom collections
 * so their items are shown and edited the same way. */
import { conferenceStatusLabels, datasetStatusLabels } from '../research/actions';
import type { CustomField } from './customFields';

const DEADLINE_KINDS: Record<string, string> = { abstract: 'Abstract', submission: 'Submission', notification: 'Notification', camera_ready: 'Camera-ready', workshop: 'Workshop', other: 'Other' };

const CONFERENCE_FIELDS: CustomField[] = [
  { id: 'acronym', name: 'Acronym', type: 'text' },
  { id: 'edition', name: 'Edition', type: 'text' },
  { id: 'status', name: 'Status', type: 'select', required: true, options: Object.keys(conferenceStatusLabels), optionLabels: conferenceStatusLabels },
  { id: 'location', name: 'Location', type: 'text' },
  { id: 'url', name: 'Website', type: 'url' },
  { id: 'starts_at', name: 'Start', type: 'date' },
  { id: 'ends_at', name: 'End', type: 'date' },
  { id: 'deadlines', name: 'Deadlines', type: 'list', columns: [
    { id: 'kind', name: 'Type', type: 'select', options: Object.keys(DEADLINE_KINDS), optionLabels: DEADLINE_KINDS, default: 'submission' },
    { id: 'label', name: 'Label', type: 'text' },
    { id: 'due_at', name: 'Due', type: 'datetime' },
  ] },
];

const DATASET_FIELDS: CustomField[] = [
  { id: 'description', name: 'Description', type: 'markdown' },
  { id: 'access_status', name: 'Access', type: 'select', required: true, options: Object.keys(datasetStatusLabels), optionLabels: datasetStatusLabels },
  { id: 'version', name: 'Version', type: 'text' },
  { id: 'license', name: 'License', type: 'text' },
  { id: 'url', name: 'Source', type: 'url' },
  { id: 'local_path', name: 'Local path', type: 'text' },
];

/** Built-in field definitions of a collection, or null when it has none. */
export function builtinFields(databaseId: string): CustomField[] | null {
  return databaseId === 'conferences' ? CONFERENCE_FIELDS : databaseId === 'datasets' ? DATASET_FIELDS : null;
}
