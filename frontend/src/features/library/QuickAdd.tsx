import { FormEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRuntime } from '../../app/runtime';
import { api } from '../../services/api';
import { Icon } from '../../components/Icon';
import { useZotero } from './useZotero';

type Preview = {
  title: string; authors: string[]; abstract: string; publication: string; published_at: string;
  doi: string; url: string; tags: string[]; metadata: Record<string, unknown>; origin: string;
  pdf_url?: string | null;
};
type AddMode = 'link' | 'pdf' | 'manual' | 'zotero';
const tabs: [AddMode, string, string][] = [['link', 'Link or DOI', 'link'], ['pdf', 'PDF files', 'papers'], ['manual', 'Manual entry', 'edit'], ['zotero', 'Zotero', 'folder']];
const looksLikeIdentifier = (value: string) => /^(https?:\/\/|doi:|10\.\d{4,9}\/|arxiv:|\d{4}\.\d{4,5})/i.test(value.trim());

/** Add articles to the library: paste a link by default, or pick another way in the tabs. */
export function QuickAdd({ onClose, projectId = null, initialIdentifier = '' }: { onClose: () => void; projectId?: number | null; initialIdentifier?: string }) {
  const runtime = useRuntime();
  const zotero = useZotero();
  const [mode, setMode] = useState<AddMode>('link');
  const [identifier, setIdentifier] = useState(initialIdentifier);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const switchMode = (next: AddMode) => { setMode(next); setError(''); };
  const projectIds = projectId ? [projectId] : [];

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [busy, onClose]);
  useEffect(() => { if (initialIdentifier && looksLikeIdentifier(initialIdentifier)) void lookup(initialIdentifier); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function lookup(value = identifier) {
    if (!value.trim() || busy) return;
    setBusy(true); setError('');
    try { setPreview(await api('/library/import-preview', { method: 'POST', body: JSON.stringify({ identifier: value.trim() }) })); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  const change = (key: keyof Preview, value: string) => preview && setPreview({ ...preview, [key]: value });
  async function confirm(event: FormEvent) {
    event.preventDefault(); if (!preview) return; setBusy(true); setError('');
    try {
      const result = await api<{ paper: Paper; created: boolean; pdf: { found: boolean; imported: boolean; error?: string | null } }>('/library/import', { method: 'POST', body: JSON.stringify({ ...preview, project_ids: projectIds }) });
      await runtime.refreshData();
      if (result.pdf.error) runtime.toast(`${result.created ? 'Article imported' : 'Article updated'}, but the PDF could not be downloaded: ${result.pdf.error}`, 'error');
      else if (result.pdf.imported) runtime.toast(`${result.created ? 'Article' : 'Existing article'} saved with its PDF`);
      else runtime.toast(result.created ? 'Article imported (no open PDF found)' : 'Existing article updated');
      onClose();
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  async function createManually(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const values = new FormData(event.currentTarget);
    const form = new FormData();
    for (const key of ['title', 'abstract', 'publication', 'published_at', 'doi', 'url', 'folder_id']) {
      const value = String(values.get(key) || '').trim();
      if (value) form.append(key, value);
    }
    form.append('authors', JSON.stringify(String(values.get('authors') || '').split(',').map(value => value.trim()).filter(Boolean)));
    form.append('tags', JSON.stringify(String(values.get('tags') || '').split(',').map(value => value.trim()).filter(Boolean)));
    form.append('project_ids', JSON.stringify(values.getAll('project_ids').map(value => Number(value))));
    const file = values.get('file');
    if (file instanceof File && file.size) form.append('file', file);
    try {
      await api<Paper>('/papers', { method: 'POST', body: form });
      await runtime.refreshData();
      runtime.toast('Article added');
      onClose();
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  // One article per PDF, titled after its file name: edit the details later.
  const addFiles = (list: FileList | null) => setFiles(current => [...current, ...[...(list || [])].filter(file => file.type === 'application/pdf' || /\.pdf$/i.test(file.name))]);
  async function importPdfs() {
    if (!files.length || busy) return;
    setBusy(true); setError('');
    let added = 0;
    try {
      for (const file of files) {
        const form = new FormData();
        form.append('title', file.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim() || 'Untitled article');
        form.append('project_ids', JSON.stringify(projectIds));
        form.append('file', file);
        await api<Paper>('/papers', { method: 'POST', body: form });
        added++;
      }
      await runtime.refreshData();
      runtime.toast(`${added} ${added === 1 ? 'article' : 'articles'} added`);
      onClose();
    } catch (reason) {
      setError(`${added ? `${added} added, then: ` : ''}${(reason as Error).message}`);
      setFiles(current => current.slice(added));
      if (added) await runtime.refreshData();
    } finally { setBusy(false); }
  }

  const folders = runtime.state.paperFolders.filter((folder: PaperFolder) => !folder.parent_id);
  return createPortal(<div className="integration-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="integration-modal quick-add-modal" role="dialog" aria-modal="true" aria-labelledby="quick-add-title">
      <header><div><h2 id="quick-add-title">Add to the library</h2></div><button className="modal-x" onClick={onClose} aria-label="Close">×</button></header>
      <nav className="quick-add-tabs" role="tablist" aria-label="How to add">{tabs.map(([id, label, icon]) =>
        <button key={id} type="button" role="tab" aria-selected={mode === id} onClick={() => switchMode(id)}><Icon name={icon} size={13}/>{label}</button>)}</nav>

      {mode === 'link' && (!preview ? <form className="quick-add-lookup" onSubmit={event => { event.preventDefault(); void lookup(); }}>
        <div className="quick-add-bar">
          <Icon name="link" size={16}/>
          <input autoFocus value={identifier} aria-label="Article link, DOI or arXiv identifier" placeholder="Paste a link, a DOI or an arXiv identifier"
            onChange={event => setIdentifier(event.target.value)}
            onPaste={event => { const pasted = event.clipboardData.getData('text').trim(); if (looksLikeIdentifier(pasted)) { event.preventDefault(); setIdentifier(pasted); void lookup(pasted); } }}/>
          <button className="button button-primary" disabled={busy || !identifier.trim()}>{busy ? 'Searching…' : 'Load'}</button>
        </div>
        <p className="quick-add-hint">E.g. https://arxiv.org/abs/2401.12345 · 10.1038/s41586-021-03819-2. The metadata and the open PDF are found for you.</p>
        {error && <p className="integration-error" role="alert">{error}</p>}
      </form> : <form className="quick-add-confirm" onSubmit={confirm}>
        <div className="quick-add-discovery"><span className="import-source-badge">Found via {preview.origin}</span><span className={`pdf-discovery ${preview.pdf_url ? 'available' : ''}`}>{preview.pdf_url ? '✓ PDF found — downloaded on import' : 'No open PDF found'}</span></div>
        <label className="full"><span>Title</span><input required value={preview.title} onChange={event => change('title', event.target.value)}/></label>
        <label className="full"><span>Authors</span><input value={preview.authors.join(', ')} onChange={event => setPreview({ ...preview, authors: event.target.value.split(',').map(item => item.trim()).filter(Boolean) })}/></label>
        <label><span>Publication</span><input value={preview.publication} onChange={event => change('publication', event.target.value)}/></label>
        <label><span>Date</span><input value={preview.published_at} onChange={event => change('published_at', event.target.value)}/></label>
        <label><span>DOI</span><input value={preview.doi} onChange={event => change('doi', event.target.value)}/></label>
        <label><span>URL</span><input type="url" value={preview.url} onChange={event => change('url', event.target.value)}/></label>
        <label className="full"><span>Abstract</span><textarea rows={5} value={preview.abstract} onChange={event => change('abstract', event.target.value)}/></label>
        {error && <p className="integration-error full" role="alert">{error}</p>}
        <footer className="full"><button type="button" className="button" onClick={() => { setPreview(null); setError(''); }}>Back</button><button className="button button-primary" autoFocus disabled={busy}>{busy ? (preview.pdf_url ? 'Downloading PDF…' : 'Importing…') : preview.pdf_url ? 'Add article + PDF' : 'Add article'}</button></footer>
      </form>)}

      {mode === 'pdf' && <div className="quick-add-lookup">
        <button type="button" className={`quick-add-drop${dragging ? ' is-dragging' : ''}`} onClick={() => fileInput.current?.click()}
          onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
          onDrop={event => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}>
          <Icon name="papers" size={22}/><strong>Drop PDF files here</strong><small>or click to choose them · one article per file</small>
        </button>
        <input ref={fileInput} type="file" accept="application/pdf" multiple hidden onChange={event => { addFiles(event.target.files); event.target.value = ''; }}/>
        {files.length > 0 && <ul className="quick-add-files">{files.map((file, index) => <li key={`${file.name}-${index}`}><Icon name="papers" size={13}/><span>{file.name}</span>
          <button type="button" className="text-link" aria-label={`Remove ${file.name}`} onClick={() => setFiles(current => current.filter((_, position) => position !== index))}>Remove</button></li>)}</ul>}
        {error && <p className="integration-error" role="alert">{error}</p>}
        <footer><button type="button" className="button" onClick={onClose}>Cancel</button><button type="button" className="button button-primary" disabled={busy || !files.length} onClick={() => void importPdfs()}>{busy ? 'Adding…' : `Add ${files.length || ''} ${files.length === 1 ? 'article' : 'articles'}`}</button></footer>
      </div>}

      {mode === 'manual' && <form className="quick-add-confirm quick-add-manual" onSubmit={createManually}>
        <label className="full"><span>Article title</span><input name="title" required autoFocus placeholder="Title of the article"/></label>
        <label className="full"><span>Authors</span><input name="authors" placeholder="Jane Doe, John Smith"/></label>
        <label><span>Publication</span><input name="publication" placeholder="Journal or conference"/></label>
        <label><span>Date</span><input name="published_at" placeholder="2026"/></label>
        <label><span>DOI</span><input name="doi" placeholder="10.0000/example"/></label>
        <label><span>URL</span><input name="url" type="url" placeholder="https://…"/></label>
        <label><span>Folder</span><select name="folder_id"><option value="">Unfiled</option>{folders.map((folder: PaperFolder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>
        <label><span>Tags</span><input name="tags" placeholder="methods, review"/></label>
        <label className="full"><span>Abstract</span><textarea name="abstract" rows={4}/></label>
        <label className="full"><span>PDF (optional)</span><input name="file" type="file" accept="application/pdf"/></label>
        {runtime.state.projects.length > 0 && <fieldset className="quick-add-projects full"><legend>Projects</legend>{runtime.state.projects.map((project: Project) => <label key={project.id}><input name="project_ids" type="checkbox" value={project.id} defaultChecked={Number(projectId) === project.id}/><span>{project.name}</span></label>)}</fieldset>}
        {error && <p className="integration-error full" role="alert">{error}</p>}
        <footer className="full"><button type="button" className="button" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? 'Adding…' : 'Add article'}</button></footer>
      </form>}

      {mode === 'zotero' && <div className="quick-add-lookup quick-add-zotero">
        {zotero.connection?.configured ? <>
          <p><strong>Zotero is connected.</strong> Synchronizing imports your references, collections, notes and available PDFs. Articles already in the library are updated, not duplicated.</p>
          {zotero.syncing && <p className="quick-add-hint" role="status">{zotero.progress?.message || 'Synchronizing…'}</p>}
          {zotero.error && <p className="integration-error" role="alert">{zotero.error}</p>}
          <footer><button type="button" className="button" onClick={() => { onClose(); void runtime.openSettings('integrations'); }}>Zotero settings</button>
            <button type="button" className="button button-primary" disabled={zotero.syncing || zotero.loading} onClick={() => { void zotero.synchronize(); onClose(); }}>{zotero.syncing ? 'Synchronizing…' : 'Sync now'}</button></footer>
        </> : <>
          <p><strong>Import your Zotero library.</strong> Connect your Zotero account once with an API key; then sync from here whenever you want.</p>
          <footer><button type="button" className="button button-primary" disabled={zotero.loading} onClick={() => { onClose(); void runtime.openSettings('integrations'); }}>{zotero.loading ? 'Checking…' : 'Connect Zotero'}</button></footer>
        </>}
      </div>}
    </section>
  </div>, document.body);
}
