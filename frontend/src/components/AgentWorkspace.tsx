import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { ExternalAgentWorkspace } from './ExternalAgentWorkspace';
import { AssistantToolbar } from './AssistantToolbar';
import { type ExternalAgentConfiguration, type ExternalEngine } from './ExternalAgentSettings';
import '../styles/components/agent-workspace.css';
import '../styles/components/assistant-chat.css';

export function AgentWorkspace({ project, visible, onClose }: { project?: Project; visible?: boolean; onClose?: () => void }) {
  const [engine, setEngine] = useState<ExternalEngine>('codex');
  const [configured, setConfigured] = useState<ExternalAgentConfiguration | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const load = () => { void api<ExternalAgentConfiguration>('/external-agents/settings')
      .then(value => setConfigured(Array.isArray(value.engines) ? value : null)).catch(() => setConfigured(null)); };
    load(); window.addEventListener('kavot:external-agent-settings-updated', load);
    return () => window.removeEventListener('kavot:external-agent-settings-updated', load);
  }, []);
  const chosen = configured?.engines.find(item => item.id === engine);
  return <>
    {chosen?.enabled ? <ExternalAgentWorkspace key={engine} engine={engine} name={chosen.name} project={project} fresh visible={visible}
      defaultModel={chosen.model} defaultEffort={chosen.effort} onBusyChange={setBusy} onEngineChange={setEngine} onClose={onClose}/>
      : <><AssistantToolbar engine={engine} busy={busy} onEngineChange={setEngine} onClose={onClose}/>
        <div className="agent-panel-body agent-live-body"><p>Enable {chosen?.name || engine} in Settings → AI and agents to get started.</p></div></>}
  </>;
}
