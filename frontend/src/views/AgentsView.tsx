import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { toast } from '../app/navigation';
import { ViewPage } from '../components/ViewLayout';
import { Icon } from '../components/Icon';
import { AgentTerminal } from '../features/agents/AgentTerminal';
import '../styles/features/agents-view.css';

type AgentEngine = 'claude' | 'codex' | 'opencode';
type Engine = { id: AgentEngine; name: string; detected_path: string | null };
type AgentConsole = { id: string; engine: AgentEngine; name: string; cwd: string; started_at: string; status: 'running' | 'exited'; exit_code: number | null };

const settings = () => api<{ engines: Engine[] }>('/external-agents/settings');
const consoles = {
  list: () => api<AgentConsole[]>('/agents/consoles'),
  open: (engine: AgentEngine) => api<AgentConsole>('/agents/consoles', { method: 'POST', body: JSON.stringify({ engine }) }),
  close: (id: string) => api<void>(`/agents/consoles/${id}`, { method: 'DELETE' }),
};

/** Advanced: the agent CLIs in a terminal inside the app, with all their own options (slash commands, permissions,
 * models), connected to Kavot's tools. They work on the whole workspace; the Agents page gives the view's context. */
export function AgentsView() {
  const [engines, setEngines] = useState<Engine[] | null>(null);
  const [list, setList] = useState<AgentConsole[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void settings().then(value => setEngines(value.engines)).catch(() => setEngines([]));
    void consoles.list().then(found => { setList(found); setActive(current => current || found.at(-1)?.id || null); }).catch(() => {});
  }, []);

  async function start(engine: Engine) {
    setBusy(true);
    try {
      const created = await consoles.open(engine.id);
      setList(previous => [...previous, created]);
      setActive(created.id);
    } catch (error) { toast((error as Error).message, 'error'); }
    finally { setBusy(false); }
  }

  async function close(item: AgentConsole) {
    if (item.status === 'running' && !window.confirm(`Stop ${item.name}? Its conversation stays in its own history (resume it from the agent).`)) return;
    await consoles.close(item.id).catch(() => {});
    setList(previous => {
      const next = previous.filter(entry => entry.id !== item.id);
      if (active === item.id) setActive(next.at(-1)?.id || null);
      return next;
    });
  }

  const installed = (engines || []).filter(engine => engine.detected_path);
  const exited = (id: string, code: number | null) => setList(previous => previous.map(entry => entry.id === id ? { ...entry, status: 'exited', exit_code: code } : entry));
  return <ViewPage className="agents-view" label="Terminal">
    <aside className="agents-side">
      <section>
        <h3>New agent</h3>
        {engines === null ? <p className="agents-hint">Looking for installed agents…</p>
          : installed.length ? <div className="agents-engines">{installed.map(engine =>
            <button key={engine.id} type="button" className="button" disabled={busy} onClick={() => void start(engine)}><Icon name="plus" size={13}/>{engine.name}</button>)}</div>
          : <p className="agents-hint">No agent installed: install Claude Code, Codex or OpenCode in Settings → AI and agents.</p>}
      </section>
      <section>
        <h3>Running</h3>
        {list.length ? <ul className="agents-list">{list.map(item => <li key={item.id} className={item.id === active ? 'active' : ''}>
          <button type="button" className="agents-list-open" onClick={() => setActive(item.id)}>
            <span className={`agents-status ${item.status}`} aria-label={item.status === 'running' ? 'Running' : 'Stopped'}/>
            <span>{item.name}</span><small>{new Date(item.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small></button>
          <button type="button" className="icon-button" aria-label={`Close ${item.name}`} title="Close" onClick={() => void close(item)}><Icon name="close" size={13}/></button>
        </li>)}</ul> : <p className="agents-hint">None yet.</p>}
      </section>
    </aside>
    <div className="agents-stage">
      {list.map(item => <AgentTerminal key={item.id} consoleId={item.id} visible={item.id === active} onExit={code => exited(item.id, code)}/>)}
      {!list.length && <div className="agents-empty"><Icon name="agents" size={28}/><p>An agent in a terminal, with all its own options. It works in your workspace folder and reaches your notes, library and tasks through Kavot's tools; its changes appear in the app as they are made.</p>
        {installed.length > 0 && <div className="agents-engines">{installed.map(engine => <button key={engine.id} type="button" className="button button-primary" disabled={busy} onClick={() => void start(engine)}>{engine.name}</button>)}</div>}</div>}
    </div>
  </ViewPage>;
}
