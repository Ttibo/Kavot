import { FormEvent, useEffect, useState } from 'react';
import { api } from '../services/api';

type AuthMode = 'none' | 'bearer' | 'header' | 'query';
type Source = {
  id: string; name: string; description: string; enabled: boolean;
  endpoint: string; default_endpoint: string; auth_mode: AuthMode;
  auth_name: string; api_key_configured: boolean;
};
type SourcesResponse = { sources: Source[] };

function SourceCard({ source, onSaved }: { source: Source; onSaved: (source: Source) => void }) {
  const [draft, setDraft] = useState(source);
  const [key, setKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => { setDraft(source); setKey(''); setClearKey(false); }, [source]);
  const dirty = draft.enabled !== source.enabled || draft.endpoint !== source.endpoint || draft.auth_mode !== source.auth_mode || draft.auth_name !== source.auth_name || Boolean(key.trim()) || clearKey;
  function update(patch: Partial<Source>) { setDraft(current => ({ ...current, ...patch })); setSaved(false); setError(''); }
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setSaved(false);
    try {
      const result = await api<SourcesResponse>('/integrations/scholarly-sources', {
        method: 'PUT', body: JSON.stringify({ sources: [{ id: source.id, enabled: draft.enabled, endpoint: draft.endpoint, auth_mode: draft.auth_mode, auth_name: draft.auth_name, api_key: key, clear_api_key: clearKey }] }),
      });
      onSaved(result.sources.find(item => item.id === source.id)!); setSaved(true);
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  return <article className="settings-card scholarly-source" aria-label={source.name}>
    <form onSubmit={save}>
      <fieldset disabled={busy}>
        <div className="scholarly-source-heading">
          <div><h3>{source.name}</h3><p>{source.description}</p></div>
          <label className="scholarly-source-toggle"><input type="checkbox" role="switch" aria-label={`Enable ${source.name}`} checked={draft.enabled} onChange={event => update({ enabled: event.target.checked })}/><span>{draft.enabled ? 'Enabled' : 'Disabled'}</span></label>
        </div>
        <details className="scholarly-source-details">
          <summary>API settings <span>{source.api_key_configured ? 'Key saved' : 'No saved key'}</span></summary>
          <div className="scholarly-source-fields">
            <label className="scholarly-source-endpoint"><span>API endpoint</span><input type="url" required aria-label={`${source.name} API endpoint`} value={draft.endpoint} onChange={event => update({ endpoint: event.target.value })}/><small>HTTPS base URL for a compatible {source.name} API.</small></label>
            <button type="button" className="button button-small" onClick={() => update({ endpoint: source.default_endpoint })}>Default endpoint</button>
            <label><span>Authentication</span><select aria-label={`${source.name} authentication`} value={draft.auth_mode} onChange={event => { const mode = event.target.value as AuthMode; update({ auth_mode: mode, auth_name: mode === 'query' ? 'api_key' : mode === 'bearer' ? 'Authorization' : mode === 'header' ? 'x-api-key' : '' }); }}><option value="none">No authentication</option><option value="bearer">Bearer token</option><option value="header">API key in header</option><option value="query">API key in query parameter</option></select></label>
            {draft.auth_mode !== 'none' && <>
              <label><span>{draft.auth_mode === 'query' ? 'Parameter name' : 'Header name'}</span><input required aria-label={`${source.name} authentication name`} value={draft.auth_name} onChange={event => update({ auth_name: event.target.value })}/></label>
              <label className="scholarly-source-secret"><span>API key or subscription token</span><input type="password" autoComplete="new-password" spellCheck={false} aria-label={`${source.name} API key`} value={key} onChange={event => { setKey(event.target.value); setClearKey(false); setSaved(false); }} placeholder={source.api_key_configured && !clearKey ? 'Leave blank to keep the saved key' : 'Optional · paste your key'}/><small>The key is sent only to this source. Saving does not validate your subscription.</small></label>
            </>}
            {source.api_key_configured && <button type="button" className="button button-small" aria-pressed={clearKey} onClick={() => { setClearKey(value => !value); setKey(''); setSaved(false); }}>{clearKey ? 'Cancel key removal' : 'Remove saved key'}</button>}
            {clearKey && <p className="scholarly-source-notice">The saved key will be removed when you save.</p>}
            {draft.endpoint.replace(/\/+$/, '') !== source.endpoint && source.api_key_configured && <p className="scholarly-source-notice">Changing the endpoint removes the old key. Enter a key for the new endpoint if needed.</p>}
          </div>
        </details>
        <footer className="scholarly-source-footer"><span role="status">{busy ? 'Saving…' : dirty ? 'Unsaved changes' : saved ? 'Settings saved' : source.enabled ? 'Available for lookups' : 'Excluded from automatic lookups'}</span><button className="button button-primary button-small" disabled={!dirty || busy}>Save {source.name}</button></footer>
        {error && <p className="scholarly-source-error" role="alert">{error}</p>}
      </fieldset>
    </form>
  </article>;
}

export function ScholarlySourcesSettings() {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setError('');
    api<SourcesResponse>('/integrations/scholarly-sources', { signal: controller.signal }).then(result => setSources(result.sources)).catch(reason => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, [attempt]);
  return <section className="scholarly-sources" aria-label="Scholarly sources">
    <header><h3>Scholarly sources</h3><p>Choose the services used for article lookups, imports, citations and PDF discovery. Disabling a source keeps existing articles and files.</p><p>Custom endpoints must use the selected source's API format. API access and PDF access depend on your provider's subscription.</p></header>
    {error ? <div role="alert"><p>{error}</p><button className="button" onClick={() => setAttempt(value => value + 1)}>Retry loading sources</button></div> : !sources ? <p role="status">Loading sources…</p> : sources.map(source => <SourceCard key={source.id} source={source} onSaved={updated => setSources(current => current!.map(item => item.id === updated.id ? updated : item))}/>)}
  </section>;
}
