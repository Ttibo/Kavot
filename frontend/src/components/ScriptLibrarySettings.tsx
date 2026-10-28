import { useEffect, useRef, useState } from 'react';
import { useRuntime } from '../app/runtime';
import { state } from '../app/state';
import { emptyScript, openScriptEditor, scriptExamples } from '../features/documents/embeds';
import {
  deleteLibraryScript, downloadScripts, importLibraryScripts, libraryScripts, parseScriptPackage, saveLibraryScript, type LibraryScript,
} from '../features/documents/scriptLibrary';
import { networkApprovals, revokeNetworkApproval, type NetworkApproval } from '../features/documents/embeds/scriptNetwork';
import '../styles/features/embeds.css';

const fold = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase();
const origins: Record<string, string> = { local: 'Created here', file: 'Imported', example: 'Example', online: 'Online' };
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const blankScript = (): LibraryScript & { height: string } => ({ ...emptyScript(), description: '', author: '', tags: [], source: { kind: 'local' } });

export function ScriptLibrarySettings() {
  const runtime = useRuntime();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [approvals, setApprovals] = useState<NetworkApproval[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => { networkApprovals().then(setApprovals).catch(() => setApprovals([])); }, []);
  const scripts = libraryScripts();
  const terms = fold(query.trim()).split(/\s+/).filter(Boolean);
  const visible = scripts.filter(script => {
    const haystack = fold(`${script.name} ${script.description} ${script.author} ${(script.tags || []).join(' ')}`);
    return terms.every(term => haystack.includes(term));
  });
  const installed = (name: string) => scripts.some(script => script.source?.kind === 'example' && script.name === name);

  async function run(action: () => Promise<string | void>) {
    setBusy(true); setError(''); setStatus('');
    try {
      const message = await action();
      if (message) setStatus(message);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function edit(script: LibraryScript | null, duplicate = false) {
    const isUpdate = !!script && !duplicate;
    const name = script ? (duplicate ? `${script.name} (copy)` : script.name) : blankScript().name;
    openScriptEditor({ ...blankScript(), ...(script || {}), height: 'auto', name }, {
      title: isUpdate ? 'Edit script' : 'New script',
      saveLabel: 'Save',
      metadata: true,
      onSave: async next => {
        const values: LibraryScript = {
          ...blankScript(), ...(script || {}), ...next,
          description: next.description || '', author: next.author || '', tags: next.tags || [],
        };
        if (!isUpdate) { delete values.uid; values.source = { kind: 'local' }; }
        await saveLibraryScript(values, isUpdate ? script.id : undefined);
        runtime.toast(isUpdate ? 'Script saved' : 'Script added to the library');
      },
    });
  }

  async function importFiles(files: FileList | null) {
    if (!files?.length) return;
    await run(async () => {
      const parsed = (await Promise.all([...files].map(async file => parseScriptPackage(await file.text())))).flat();
      const result = await importLibraryScripts(parsed);
      return `${plural(result.created, 'script')} added · ${result.updated} updated`;
    });
    if (fileInput.current) fileInput.current.value = '';
  }

  function remove(script: LibraryScript) {
    if (!confirm(`Delete “${script.name}”? Notes that use it keep their copy.`)) return;
    void run(async () => { await deleteLibraryScript(script.id!); return 'Script deleted.'; });
  }

  function revoke(approval: NetworkApproval) {
    void run(async () => {
      await revokeNetworkApproval(approval.url);
      setApprovals(await networkApprovals());
      return `Access to ${approval.url} revoked.`;
    });
  }

  function addExample(example: (typeof scriptExamples)[number]) {
    void run(async () => {
      await saveLibraryScript({ ...blankScript(), ...example, author: 'Kavot', source: { kind: 'example' } });
      return `“${example.name}” added to the library.`;
    });
  }

  return <div className="script-library-settings">
    <header>
      <h3>Script library</h3>
      <p>Scripts are inserted into notes with <strong>Insert → Script</strong>. They run isolated from the app, without file access, and can read your collections. They reach the web only through <code>kavot.fetch</code>, after you approve each URL.</p>
      <div className="form-actions">
        <button className="button button-primary" disabled={busy} onClick={() => edit(null)}>＋ New script</button>
        <button className="button" disabled={busy} onClick={() => fileInput.current?.click()}>Import…</button>
        <button className="button" disabled={busy || !scripts.length} onClick={() => downloadScripts(scripts, 'kavot-library')}>Export all</button>
        <input ref={fileInput} type="file" accept=".json,application/json" multiple hidden aria-label="Script files to import" onChange={event => void importFiles(event.target.files)}/>
      </div>
      {status && <p role="status" className="script-library-status">{status}</p>}
      {error && <p role="alert">{error}</p>}
    </header>

    <article className="settings-card">
      <div className="script-library-toolbar">
        <h3>My scripts <small>{scripts.length}</small></h3>
        {scripts.length > 3 && <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search scripts…" aria-label="Search scripts"/>}
      </div>
      {visible.length ? <ul className="script-library-list">{visible.map(script => <li key={script.id}>
        <span className="kv-embed-icon" aria-hidden="true">{'</>'}</span>
        <div className="script-library-info">
          <strong>{script.name}</strong>
          <span className="script-library-meta">
            {[script.author, origins[script.source?.kind || 'local'], script.updated_at && `updated ${new Date(script.updated_at).toLocaleDateString('en-US')}`].filter(Boolean).join(' · ')}
          </span>
          {script.description && <small>{script.description}</small>}
          {!!script.tags?.length && <span className="script-library-tags">{script.tags.map(tag => <i key={tag}>{tag}</i>)}</span>}
        </div>
        <div className="form-actions">
          <button className="button button-small" disabled={busy} onClick={() => edit(script)}>Edit</button>
          <button className="button button-small" disabled={busy} onClick={() => edit(script, true)}>Duplicate</button>
          <button className="button button-small" disabled={busy} onClick={() => downloadScripts([script], script.name)} aria-label={`Export ${script.name}`}>Export</button>
          <button className="button button-small" disabled={busy} onClick={() => remove(script)} aria-label={`Delete ${script.name}`}>Delete</button>
        </div>
      </li>)}</ul> : <p className="script-library-empty">{scripts.length ? 'No script matches the search.' : 'No scripts yet. Create one, import a shared file or start from an example below.'}</p>}
    </article>

    <article className="settings-card">
      <h3>Examples</h3>
      <p>Ready-to-use scripts to add and adapt.</p>
      <ul className="script-library-list">{scriptExamples.map(example => <li key={example.name}>
        <span className="kv-embed-icon" aria-hidden="true">{'</>'}</span>
        <div className="script-library-info"><strong>{example.name}</strong><small>{example.description}</small></div>
        <div className="form-actions">
          <button className="button button-small" disabled={busy || installed(example.name)} onClick={() => addExample(example)}>{installed(example.name) ? 'Already added' : 'Add'}</button>
        </div>
      </li>)}</ul>
    </article>

    <article className="settings-card">
      <h3>Network access <small>{approvals.length}</small></h3>
      <p>Addresses you allowed scripts to call with <code>kavot.fetch</code>. Any script can use an allowed address, and send it data from your notes: revoke the ones you no longer need. A revoked address asks again on next use.</p>
      {approvals.length ? <ul className="script-library-list">{approvals.map(approval => <li key={approval.url}>
        <div className="script-library-info">
          <strong><code>{approval.url}</code></strong>
          <span className="script-library-meta">
            {[approval.script && `first requested by “${approval.script}”`, approval.approved_at && `allowed ${new Date(approval.approved_at).toLocaleDateString('en-US')}`].filter(Boolean).join(' · ')}
          </span>
        </div>
        <div className="form-actions">
          <button className="button button-small" disabled={busy} onClick={() => revoke(approval)} aria-label={`Revoke ${approval.url}`}>Revoke</button>
        </div>
      </li>)}</ul> : <p className="script-library-empty">No address allowed yet. A dialog asks you the first time a script calls a new URL.</p>}
    </article>

    <article className="settings-card">
      <h3>Share scripts</h3>
      <p>Export one script or the whole library as a <code>.kavot-scripts.json</code> file, then import it on another computer. Each script keeps its ID: importing it again updates the existing copy instead of creating a duplicate.</p>
      <p className="settings-hint">{plural(state.noteScripts.length, 'script')} in this workspace.</p>
    </article>
  </div>;
}
