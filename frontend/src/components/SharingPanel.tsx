import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from '../services/api';
import './sharing.css';

export type ShareSource = {kind: 'note' | 'project' | 'item'; id: string; collection?: string};
type Choice = ShareSource & {title: string; group: string};
type SharedField = {label: string; type: string; value: string | number | boolean | string[] | null};
type SharedEntry = {key: string; title: string; fields: Record<string, SharedField>};
type SharedItem = {id: string; title: string; kind: string; owned: boolean; owner_number: string; version: number; members?: string[]; content?: {entries: SharedEntry[]; attachments: {name: string; resource_id: string}[]}};
function shareApi(path: string, method = 'GET', body?: unknown) {
  return api(`/cloud-sync${path}`, {method, headers: {'X-Kavot-Local': '1'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
}
const identity = (source: ShareSource) => `${source.kind}:${source.collection || ''}:${source.id}`;

export function SharingPanel({initialSource, onDirtyChange}: {initialSource?: ShareSource; onDirtyChange?: (dirty: boolean) => void}) {
  const [account, setAccount] = useState<any>(null);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [items, setItems] = useState<SharedItem[]>([]);
  const [selection, setSelection] = useState(initialSource ? identity(initialSource) : '');
  const [recipient, setRecipient] = useState('');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<SharedItem | null>(null);
  const [entryIndex, setEntryIndex] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [section, setSection] = useState<'received' | 'sent'>('received');
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  const canShare = !!account?.storage?.enabled;

  async function loadItems() {
    const rows: SharedItem[] = [];
    while (true) {
      const page = await shareApi(`/shares?offset=${rows.length}`);
      rows.push(...page);
      if (page.length < 100) break;
    }
    setItems(rows);
  }
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); setMessage('');
    try { await action(); } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    let alive = true;
    void Promise.all([shareApi('/account'), shareApi('/shares/catalog')]).then(async ([me, catalog]) => {
      if (!alive) return;
      setAccount(me); setChoices(catalog); await loadItems();
    }).catch(reason => { if (alive) setError(reason.message); }).finally(() => { if (alive) setLoaded(true); });
    let polling = false;
    const timer = window.setInterval(async () => {
      if (polling || document.hidden) return;
      polling = true;
      try { await loadItems(); } catch { /* Explicit operations report connection failures. */ }
      finally { polling = false; }
    }, 10000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  async function open(item: SharedItem) {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    const result = await shareApi(`/shares/${item.id}`);
    setActive(result); setEntryIndex(0); setDirty(false);
  }
  function change(name: string, value: SharedField['value']) {
    if (!active?.content) return;
    const entries = active.content.entries.map((entry, index) => index !== entryIndex ? entry : {
      ...entry, title: ['title', 'name'].includes(name) && typeof value === 'string' ? value : entry.title,
      fields: {...entry.fields, [name]: {...entry.fields[name], value}}
    });
    setActive({...active, content: {...active.content, entries}}); setDirty(true);
  }
  const visible = items.filter(item => section === 'sent' ? item.owned : !item.owned);
  const entry = active?.content?.entries[entryIndex];
  const changedRemotely = active && items.some(item => item.id === active.id && item.version !== active.version);
  return <div className="sharing-panel">
    <header><h2>Sharing</h2><p>Work together on a note, a project or a collection item.</p></header>
    {account && <section className="settings-card sharing-identity"><div><h3>My sharing number</h3><strong>{account.share_number || 'Server update required'}</strong><p>Give this number to the person who wants to share with you.</p></div><button className="button" disabled={!account.share_number} onClick={() => void run(async () => { await navigator.clipboard.writeText(account.share_number); setMessage('Number copied.'); })}>Copy my number</button></section>}
    {!account && loaded && <p>Connect this device to your account in “Cloud and storage” to access shares.</p>}
    {account && <section className="settings-card"><h3>Share an item</h3>{!canShare ? <p>Online storage must be active to send a share. You can receive and edit shares with your connected account.</p> : <form onSubmit={event => { event.preventDefault(); void run(async () => {
      const selected = choices.find(choice => identity(choice) === selection);
      if (!selected) throw new Error('Choose an item to share.');
      const {kind, id, collection} = selected;
      const result = await shareApi('/shares', 'POST', {source: {kind, id, ...(collection ? {collection} : {})}, recipient_number: recipient.replace(/\s/g, '')});
      setRecipient(''); setSection('sent'); await loadItems(); await open(result); setMessage('Share created with read and write access.');
    }); }}>
      <label>Search for an item<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Title, collection or project"/></label>
      <label>Item to share<select required value={selection} onChange={event => setSelection(event.target.value)}><option value="">Choose an item…</option>{choices.filter(choice => `${choice.title} ${choice.group}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()) || identity(choice) === selection).map(choice => <option key={identity(choice)} value={identity(choice)}>{choice.group} · {choice.title}</option>)}</select></label>
      <label>Recipient’s sharing number<input inputMode="numeric" autoComplete="off" required pattern="[0-9 ]{12,16}" value={recipient} onChange={event => setRecipient(event.target.value)} placeholder="12 chiffres"/></label>
      <p>Read and write access. Content and attachments use your storage. Changes are applied to the original item when your app is connected.</p>
      <button className="button button-primary" disabled={busy}>Share</button>
    </form>}</section>}
    {error && <p className="storage-notice" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {account && <section className="settings-card"><div className="sharing-tabs"><button className="button" aria-pressed={section === 'received'} onClick={() => setSection('received')}>Received</button><button className="button" aria-pressed={section === 'sent'} onClick={() => setSection('sent')}>Sent</button><button className="button" disabled={busy} onClick={() => void run(loadItems)}>Actualiser</button></div>
      {!visible.length ? <p>No {section === 'sent' ? 'sent' : 'received'} shares yet.</p> : <ul className="sharing-list">{visible.map(item => <li key={item.id}><button className="text-link" disabled={busy} onClick={() => void run(() => open(item))}>{item.title}</button><small>{item.kind === 'project' ? 'Project' : item.kind === 'note' ? 'Note' : 'Item'} · Owner {item.owner_number} · Read and write</small></li>)}</ul>}
    </section>}
    {active?.content && <section className="settings-card sharing-editor" aria-label="Share editor"><h3>{active.title}</h3>
      {changedRemotely && <p role="status">A newer version is available. Your draft stays on screen.</p>}
      <div className="sharing-tabs"><button className="button" disabled={busy} onClick={() => void run(() => open(active))}>Reload the share</button><span>{dirty ? 'Unsaved changes' : 'Saved'} · Version {active.version}</span></div>
      {active.content.entries.length > 1 && <label>Project content<select value={entryIndex} onChange={event => setEntryIndex(Number(event.target.value))}>{active.content.entries.map((row, index) => <option key={row.key} value={index}>{row.title}</option>)}</select></label>}
      {entry && <form onSubmit={event => { event.preventDefault(); void run(async () => {
        const result = await shareApi(`/shares/${active.id}`, 'PUT', {expected_version: active.version, content: active.content});
        setActive(result); setDirty(false); await loadItems(); setMessage('Shared changes saved.');
      }); }}>
        {Object.entries(entry.fields).map(([name, field]) => <label key={`${entry.key}:${name}`}>{field.label}{field.type === 'boolean' ? <input aria-label={field.label} type="checkbox" checked={!!field.value} onChange={event => change(name, event.target.checked)}/> : field.type === 'markdown' ? <textarea aria-label={field.label} rows={12} value={String(field.value || '')} onChange={event => change(name, event.target.value)}/> : <input aria-label={field.label} type={field.type === 'number' ? 'number' : 'text'} step="any" value={Array.isArray(field.value) ? field.value.join(', ') : String(field.value ?? '')} onChange={event => change(name, field.type === 'number' ? event.target.value === '' ? null : Number(event.target.value) : field.type === 'tags' ? event.target.value.split(',').map(value => value.trim()).filter(Boolean) : event.target.value)}/>}</label>)}
        <button className="button button-primary" disabled={busy || !dirty}>Save changes</button>
      </form>}
      {!!active.content.attachments.length && <div><h4>Attachments</h4>{active.content.attachments.map(file => <button className="button" key={file.resource_id} disabled={busy} onClick={() => void run(async () => { const result = await shareApi(`/shares/${active.id}/attachments/${file.resource_id}`); if (new URL(result.url).protocol !== 'https:') throw new Error('Invalid download address.'); window.open(result.url, '_blank', 'noopener,noreferrer'); })}>{file.name}</button>)}</div>}
      {active.owned && <div className="sharing-members"><h4>People with access</h4>{active.members?.map(number => <p key={number}>{number} <button className="button button-small" disabled={busy} onClick={() => void run(async () => { await shareApi(`/shares/${active.id}/members/${number}`, 'DELETE'); setActive({...active, members: active.members?.filter(value => value !== number)}); await loadItems(); setMessage('Access revoked.'); })}>Revoke access</button></p>)}<button className="button" disabled={busy} onClick={() => { if (window.confirm('Stop this share for every recipient? The local item will be kept.')) void run(async () => { await shareApi(`/shares/${active.id}`, 'DELETE'); setActive(null); setDirty(false); await loadItems(); setMessage('Share stopped.'); }); }}>Stop sharing</button></div>}
    </section>}
  </div>;
}

export function ShareButton({source}: {source: ShareSource}) {
  const [open, setOpen] = useState(false);
  return <><button className="button button-small" onClick={() => setOpen(true)}>Share</button>{open && <ShareDialog source={source} close={() => setOpen(false)}/>}</>;
}
function ShareDialog({source, close}: {source: ShareSource; close: () => void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const dirty = useRef(false);
  const tryClose = () => { if (!dirty.current || window.confirm('Discard unsaved changes?')) close(); };
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="sharing-dialog" onCancel={event => { event.preventDefault(); tryClose(); }}><button className="button" onClick={tryClose}>Close</button><SharingPanel initialSource={source} onDirtyChange={value => { dirty.current = value; }}/></dialog>;
}

export function openShareDialog(source: ShareSource) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(<ShareDialog source={source} close={() => { root.unmount(); host.remove(); }}/>);
}
