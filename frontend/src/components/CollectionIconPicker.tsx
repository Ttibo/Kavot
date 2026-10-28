import { useState } from 'react';
import { Icon } from './Icon';
import { collectionIcon, collectionIcons } from '../features/collections/icons';
import { api } from '../services/api';
import { state } from '../app/state';
import { publish } from '../app/viewBridge';

export function CollectionIconPicker({ value, onChange, disabled = false, label = 'Collection icon' }: { value: string; onChange: (icon: string) => void; disabled?: boolean; label?: string }) {
  return <label className="collection-icon-picker"><span>{label}</span><Icon name={value}/><select aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>{collectionIcons.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>;
}

export function CollectionIconSetting({ database }: { database: any }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(icon: string) {
    setBusy(true); setError('');
    try {
      const saved = await api(`/databases/${database.id}`, { method: 'PATCH', body: JSON.stringify({ icon }) });
      state.databases = state.databases.map(item => item.id === saved.id ? saved : item);
      publish();
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  return <div><CollectionIconPicker value={collectionIcon(database)} label={`Icon: ${database.name}`} disabled={busy} onChange={icon => void save(icon)}/>{error && <p role="alert">{error}</p>}</div>;
}
