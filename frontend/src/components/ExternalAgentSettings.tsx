import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../services/api';
import { ExternalModelPicker } from './ExternalModelPicker';
import '../styles/components/external-agents.css';

export type ExternalEngine = 'codex' | 'claude' | 'opencode';
type ExternalEngineSettings = {
  id: ExternalEngine; name: string; enabled: boolean; executable: string;
  detected_path: string | null; model: string; effort: string; access: 'read' | 'write';
  answer_model: string; answer_effort: string; digest_model: string;
};
export type ExternalAgentConfiguration = { engines: ExternalEngineSettings[] };
type InstallPlan = { available: boolean; method?: string; command?: string; message?: string };
type InstallJob = { id: string; engine: ExternalEngine; status: 'running' | 'done' | 'failed'; lines: string[]; path: string | null; error: string };

const help: Record<ExternalEngine, string> = {
  codex: 'Sign in with your ChatGPT account or an OpenAI API key.',
  claude: 'Sign in with your Claude account or an Anthropic API key.',
  opencode: 'Connect the providers you want to use (Anthropic, OpenAI, local models…).',
};

export function ExternalAgentSettings() {
  const [config, setConfig] = useState<ExternalAgentConfiguration | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState<ExternalEngine | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [installs, setInstalls] = useState<Partial<Record<ExternalEngine, InstallJob>>>({});
  const load = () => api<ExternalAgentConfiguration>('/external-agents/settings').then(value => {
    if (!Array.isArray(value.engines)) throw new Error('External engine settings are unavailable.');
    setConfig(previous => previous ? { engines: value.engines.map(engine => {
      const edited = previous.engines.find(item => item.id === engine.id);
      return edited ? { ...edited, detected_path: engine.detected_path } : engine;
    }) } : value);
  });
  useEffect(() => { void load().catch(reason => setError(reason.message)); }, []);

  function change(id: ExternalEngine, patch: Partial<ExternalEngineSettings>) {
    setConfig(previous => previous && ({ engines: previous.engines.map(engine => engine.id === id ? { ...engine, ...patch } : engine) }));
    setStatus('');
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!config) return;
    setBusy(true); setError(''); setStatus('');
    try {
      const engines = Object.fromEntries(config.engines.map(({ id, enabled, executable, model, effort, access, answer_model, answer_effort, digest_model }) =>
        [id, { enabled, executable, model, effort, access, answer_model, answer_effort, digest_model }]));
      const saved = await api<ExternalAgentConfiguration>('/external-agents/settings', { method: 'PATCH', body: JSON.stringify({ engines }) });
      setConfig(saved); setStatus('External engines saved.');
      window.dispatchEvent(new Event('kavot:external-agent-settings-updated'));
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  async function install(id: ExternalEngine, name: string) {
    setError(''); setStatus('');
    try {
      const plan = await api<InstallPlan>(`/external-agents/settings/${id}/install`);
      if (!plan.available) throw new Error(plan.message || `${name} cannot be installed automatically.`);
      if (!window.confirm(`Install ${name} with the ${plan.method}?\n\n${plan.command}\n\nThe program is downloaded from its publisher and installed for your user account only.`)) return;
      let job = await api<InstallJob>(`/external-agents/settings/${id}/install`, { method: 'POST' });
      setInstalls(previous => ({ ...previous, [id]: job }));
      while (job.status === 'running') {
        await new Promise(resolve => window.setTimeout(resolve, 1000));
        job = await api<InstallJob>(`/external-agents/installs/${job.id}`);
        setInstalls(previous => ({ ...previous, [id]: job }));
      }
      if (job.status === 'failed') throw new Error(job.error);
      await load();
      setStatus(`${name} installed · ${job.path}. Sign in to finish.`);
      window.dispatchEvent(new Event('kavot:external-agent-settings-updated'));
    } catch (reason) { setError((reason as Error).message); }
  }

  async function signIn(id: ExternalEngine, name: string) {
    setError(''); setStatus('');
    try {
      const result = await api<{ command: string }>(`/external-agents/settings/${id}/login`, { method: 'POST' });
      setStatus(`A terminal opened with “${result.command}”. Finish signing in to ${name} there, then check the program.`);
    } catch (reason) { setError((reason as Error).message); }
  }

  async function check(id: ExternalEngine) {
    setChecking(id); setError(''); setStatus('');
    try {
      const result = await api<{ path: string; version: string }>(`/external-agents/settings/${id}/check`, {
        method: 'POST', body: JSON.stringify({ executable: config?.engines.find(engine => engine.id === id)?.executable || '' }),
      });
      setStatus(`${result.version} · ${result.path}`);
    } catch (reason) { setError((reason as Error).message); }
    finally { setChecking(null); }
  }

  return <form className="external-agent-settings" onSubmit={event => void save(event)}>
    <header><h3>External agent tools</h3><p>Enable the tools installed on this computer. Each tool uses its own sign-in and sessions. Kavot keeps the conversations opened from its chat.</p></header>
    {!config ? <p>{error || 'Looking for installed tools…'}</p> : <>
      <div className="external-engine-grid">{config.engines.map(engine => <article className="settings-card external-engine-card" key={engine.id}>
        <div className="external-engine-heading"><div><h4>{engine.name}</h4><small>{engine.detected_path ? 'Installed' : 'Not installed'}</small></div>
          <label className="llm-checkbox"><input type="checkbox" checked={engine.enabled} disabled={busy} onChange={event => change(engine.id, { enabled: event.target.checked })}/> Activer</label></div>
        <p>{help[engine.id]}</p>
        <label>Program path<input aria-label={`Chemin ${engine.name}`} value={engine.executable} disabled={busy} onChange={event => change(engine.id, { executable: event.target.value })} placeholder={engine.detected_path || 'Detected automatically if left empty'}/></label>
        <ExternalModelPicker engine={engine.id} name={engine.name} model={engine.model} effort={engine.effort} executable={engine.executable} disabled={busy} settings onChange={(model, effort) => change(engine.id, { model, effort })}/>
        <ExternalModelPicker engine={engine.id} name={engine.name} model={engine.answer_model} effort={engine.answer_effort} executable={engine.executable} disabled={busy} settings purpose="Questions"
          onChange={(answer_model, answer_effort) => change(engine.id, { answer_model, answer_effort })}/>
        <small>Used for questions (/answer) when the conversation keeps the default model. A smaller model and a lower effort cost several times less.</small>
        {engine.id !== 'opencode' && <><ExternalModelPicker engine={engine.id} name={engine.name} model={engine.digest_model} effort="" executable={engine.executable} disabled={busy} settings purpose="Summaries" withEffort={false}
          onChange={digest_model => change(engine.id, { digest_model })}/>
        <small>Summarizes the notes agents read, in the background, so later requests read the summary instead of the note. Off: the chat model writes them.</small></>}
        <div className="external-engine-actions">
          <button type="button" className={`button button-small${engine.detected_path ? '' : ' button-primary'}`} disabled={busy || installs[engine.id]?.status === 'running'} onClick={() => void install(engine.id, engine.name)}>
            {installs[engine.id]?.status === 'running' ? 'Installing…' : engine.detected_path ? 'Update' : 'Install'}</button>
          {engine.detected_path && <button type="button" className="button button-small" disabled={busy} onClick={() => void signIn(engine.id, engine.name)}>Sign in</button>}
          {engine.detected_path && <button type="button" className="button button-small" disabled={busy || !!checking} onClick={() => void check(engine.id)}>{checking === engine.id ? 'Checking…' : 'Check'}</button>}
        </div>
        {installs[engine.id] && installs[engine.id]!.lines.length > 0 && <pre className="external-engine-log" aria-live="polite">{installs[engine.id]!.lines.slice(-8).join('\n')}</pre>}
      </article>)}</div>
      <p className="settings-hint">Choose /plan or /edit directly in the chat. In /edit, every change can be reviewed and then applied. “Check” verifies the installation; the model list shows whether you are signed in.</p>
      <div className="llm-save"><button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : 'Save external engines'}</button>
        {status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}</div>
    </>}
  </form>;
}
