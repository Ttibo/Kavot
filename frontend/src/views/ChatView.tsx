import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';
import { Icon } from '../components/Icon';
import { ViewHeader, ViewPage } from '../components/ViewLayout';
import { ExternalAgentWorkspace } from '../components/ExternalAgentWorkspace';
import { type ExternalAgentConfiguration, type ExternalEngine } from '../components/ExternalAgentSettings';
import '../styles/components/agent-workspace.css';
import '../styles/components/assistant-chat.css';
import '../styles/features/chat.css';

type ChatSession = { id: string; engine: ExternalEngine; title: string; messages?: unknown[]; updated_at: string; active_run_id: string | null };
type Opened = { engine: ExternalEngine; sessionId: string; fresh: boolean; mount: number };

const ENGINE_NAMES: Record<ExternalEngine, string> = { codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode' };

function dayGroup(value: string) {
  const date = new Date(value);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.floor((today.getTime() - new Date(date).setHours(0, 0, 0, 0)) / 86_400_000);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? 'Previous 7 days' : days < 30 ? 'Previous 30 days' : 'Older';
}

const shortTime = (value: string) => {
  const date = new Date(value);
  return dayGroup(value) === 'Today' ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

/** Every conversation with the agent CLIs: browse, resume and chat full page. */
export function ChatView() {
  const [configured, setConfigured] = useState<ExternalAgentConfiguration | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [engineFilter, setEngineFilter] = useState<ExternalEngine | 'all'>('all');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const enabled = useMemo(() => configured?.engines.filter(engine => engine.enabled) || [], [configured]);

  useEffect(() => {
    const load = () => { void api<ExternalAgentConfiguration>('/external-agents/settings')
      .then(value => setConfigured(Array.isArray(value.engines) ? value : null)).catch(() => setConfigured(null)); };
    load(); window.addEventListener('kavot:external-agent-settings-updated', load);
    return () => window.removeEventListener('kavot:external-agent-settings-updated', load);
  }, []);

  const loadSessions = useCallback(async () => {
    const lists = await Promise.all(enabled.map(engine => api<ChatSession[]>(`/external-agents/sessions?engine=${engine.id}`).catch(() => [] as ChatSession[])));
    setSessions(lists.flat().sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))));
  }, [enabled]);
  useEffect(() => { void loadSessions(); }, [loadSessions]);

  // Open the latest conversation, or a new one with the first enabled CLI.
  useEffect(() => {
    if (opened || !enabled.length) return;
    const latest = sessions[0];
    if (latest) setOpened({ engine: latest.engine, sessionId: latest.id, fresh: false, mount: 0 });
    else setOpened({ engine: enabled[0].id, sessionId: '', fresh: true, mount: 0 });
  }, [enabled, sessions, opened]);

  const open = (session: ChatSession) => { if (!busy) setOpened(current => ({ engine: session.engine, sessionId: session.id, fresh: false, mount: (current?.mount || 0) + 1 })); };
  const startNew = (engine: ExternalEngine) => { if (!busy) setOpened(current => ({ engine, sessionId: '', fresh: true, mount: (current?.mount || 0) + 1 })); };
  const followSession = useCallback((id: string) => {
    setOpened(current => current && id && current.sessionId !== id ? { ...current, sessionId: id, fresh: false } : current);
    void loadSessions();
  }, [loadSessions]);

  const shown = sessions.filter(session => (engineFilter === 'all' || session.engine === engineFilter)
    && (!query.trim() || session.title.toLowerCase().includes(query.trim().toLowerCase())));
  const groups = shown.reduce<[string, ChatSession[]][]>((result, session) => {
    const label = dayGroup(session.updated_at);
    const group = result.find(([name]) => name === label);
    if (group) group[1].push(session); else result.push([label, [session]]);
    return result;
  }, []);
  const chosen = opened && configured?.engines.find(engine => engine.id === opened.engine);

  return <ViewPage className="chat-view" label="Chat">
    <ViewHeader icon="chat" title="Chat" count={sessions.length}>
      {enabled.length > 1
        ? <details className="chat-new-menu"><summary className="button button-primary"><Icon name="plus" size={13}/>New chat</summary>
          <div role="menu">{enabled.map(engine => <button key={engine.id} role="menuitem" disabled={busy} onClick={event => { startNew(engine.id); event.currentTarget.closest('details')?.removeAttribute('open'); }}>{engine.name}</button>)}</div></details>
        : <button className="button button-primary" disabled={busy || !enabled.length} onClick={() => enabled[0] && startNew(enabled[0].id)}><Icon name="plus" size={13}/>New chat</button>}
    </ViewHeader>
    <div className="chat-layout">
      <aside className="chat-sessions" aria-label="Conversations">
        <div className="chat-sessions-tools">
          <input type="search" aria-label="Search conversations" placeholder="Search conversations" value={query} onChange={event => setQuery(event.target.value)}/>
          {enabled.length > 1 && <div className="chat-engine-filter" role="group" aria-label="Agent">
            <button aria-pressed={engineFilter === 'all'} onClick={() => setEngineFilter('all')}>All</button>
            {enabled.map(engine => <button key={engine.id} aria-pressed={engineFilter === engine.id} onClick={() => setEngineFilter(engine.id)}>{engine.name}</button>)}
          </div>}
        </div>
        <div className="chat-session-list">
          {groups.map(([label, items]) => <section key={label}><h2>{label}</h2>
            {items.map(session => <button key={session.id} className={`chat-session ${opened?.sessionId === session.id ? 'active' : ''}`} disabled={busy && opened?.sessionId !== session.id} onClick={() => open(session)} title={session.title}>
              <span className="chat-session-title">{session.active_run_id && <span className="chat-running" aria-label="Running"/>}<strong>{session.title || 'New conversation'}</strong></span>
              <span className="chat-session-meta"><span className={`chat-engine ${session.engine}`}>{ENGINE_NAMES[session.engine] || session.engine}</span><time dateTime={session.updated_at}>{shortTime(session.updated_at)}</time></span>
            </button>)}
          </section>)}
          {!shown.length && <p className="chat-empty">{sessions.length ? 'No conversation matches.' : enabled.length ? 'Your conversations with the agents will appear here.' : 'Enable an agent in Settings → AI and agents.'}</p>}
        </div>
      </aside>
      <section className="chat-thread" aria-label="Conversation">
        {opened && chosen?.enabled
          ? <ExternalAgentWorkspace key={`${opened.engine}-${opened.mount}`} engine={opened.engine} name={chosen.name}
            defaultModel={chosen.model} defaultEffort={chosen.effort} sessionId={opened.sessionId} fresh={opened.fresh}
            onSessionChange={followSession} onBusyChange={setBusy} onEngineChange={startNew}/>
          : <div className="chat-blank"><Icon name="chat" size={28}/><h2>Chat with your agents</h2><p>Enable Codex, Claude Code or OpenCode in Settings → AI and agents, then start a conversation.</p>
            <button className="button" onClick={() => window.dispatchEvent(new Event('kavot:open-settings'))}>Open settings</button></div>}
      </section>
    </div>
  </ViewPage>;
}
