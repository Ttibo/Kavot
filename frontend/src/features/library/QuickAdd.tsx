import { FormEvent, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRuntime } from '../../app/runtime';
import { api } from '../../services/api';

type Preview = {
  title: string; authors: string[]; abstract: string; publication: string; published_at: string;
  doi: string; url: string; tags: string[]; metadata: Record<string, unknown>; origin: string;
  pdf_url?: string | null;
};
type AddMode = 'quick' | 'manual';

export function QuickAdd({ onClose, projectId = null }: { onClose: () => void; projectId?: number | null }) {
  const runtime = useRuntime();
  const [mode, setMode] = useState<AddMode>('quick');
  const [identifier, setIdentifier] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const switchMode = (nextMode: AddMode) => { setMode(nextMode); setError(''); };
  async function lookup(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { setPreview(await api('/library/import-preview', { method: 'POST', body: JSON.stringify({ identifier }) })); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  const change = (key: keyof Preview, value: string) => preview && setPreview({ ...preview, [key]: value });
  async function confirm(event: FormEvent) {
    event.preventDefault(); if (!preview) return; setBusy(true); setError('');
    try {
      const result = await api<{ paper: Paper; created: boolean; pdf: { found: boolean; imported: boolean; error?: string | null } }>('/library/import', { method: 'POST', body: JSON.stringify({ ...preview, project_ids: projectId ? [projectId] : [] }) });
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
  const folders = runtime.state.paperFolders.filter((folder: any) => !folder.parent_id);
  return createPortal(<div className="integration-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="integration-modal quick-add-modal" role="dialog" aria-modal="true" aria-labelledby="quick-add-title">
      <header><div><span className="eyebrow">Article library</span><h2 id="quick-add-title">Add an article</h2><p>Find its metadata from a DOI, URL or arXiv identifier, or enter it yourself.</p></div><button className="modal-x" onClick={onClose} aria-label="Close">×</button></header>
      <nav className="quick-add-tabs" aria-label="Article entry method"><button type="button" aria-selected={mode === 'quick'} onClick={() => switchMode('quick')}>Quick add</button><button type="button" aria-selected={mode === 'manual'} onClick={() => switchMode('manual')}>Add manually</button></nav>
      {mode === 'quick' && (!preview ? <form className="quick-add-lookup" onSubmit={lookup}>
        <label><span>Identifier or article URL</span><input autoFocus required value={identifier} onChange={event => setIdentifier(event.target.value)} placeholder="10.1038/…, arXiv:2401.12345, or https://…"/></label>
        {error && <p className="integration-error" role="alert">{error}</p>}
        <footer><button type="button" className="button" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy || !identifier.trim()}>{busy ? 'Searching…' : 'Find metadata'}</button></footer>
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
        <footer className="full"><button type="button" className="button" onClick={() => { setPreview(null); setError(''); }}>Back</button><button className="button button-primary" disabled={busy}>{busy ? (preview.pdf_url ? 'Downloading PDF…' : 'Importing…') : preview.pdf_url ? 'Import article + PDF' : 'Import article'}</button></footer>
      </form>)}
      {mode === 'manual' && <form className="quick-add-confirm quick-add-manual" onSubmit={createManually}>
        <label className="full"><span>Article title</span><input name="title" required autoFocus placeholder="Title of the article"/></label>
        <label className="full"><span>Authors</span><input name="authors" placeholder="Jane Doe, John Smith"/></label>
        <label><span>Publication</span><input name="publication" placeholder="Journal or conference"/></label>
        <label><span>Date</span><input name="published_at" placeholder="2026"/></label>
        <label><span>DOI</span><input name="doi" placeholder="10.0000/example"/></label>
        <label><span>URL</span><input name="url" type="url" placeholder="https://…"/></label>
        <label><span>Folder</span><select name="folder_id"><option value="">Unfiled</option>{folders.map((folder: any) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>
        <label><span>Tags</span><input name="tags" placeholder="methods, review"/></label>
        <label className="full"><span>Abstract</span><textarea name="abstract" rows={5}/></label>
        <label className="full"><span>PDF (optional)</span><input name="file" type="file" accept="application/pdf"/></label>
        <fieldset className="quick-add-projects full"><legend>Projects</legend>{runtime.state.projects.map((project: Project) => <label key={project.id}><input name="project_ids" type="checkbox" value={project.id} defaultChecked={Number(projectId) === project.id}/><span>{project.name}</span></label>)}</fieldset>
        {error && <p className="integration-error full" role="alert">{error}</p>}
        <footer className="full"><button type="button" className="button" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? 'Adding…' : 'Add article'}</button></footer>
      </form>}
    </section>
  </div>, document.body);
}
