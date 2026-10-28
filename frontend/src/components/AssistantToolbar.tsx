import { Icon } from './Icon';
import type { ExternalEngine } from './ExternalAgentSettings';

export function AssistantToolbar({ engine, busy, onEngineChange, onNew, onHistory, historyOpen, onClose }: {
  engine: ExternalEngine; busy?: boolean; onEngineChange: (engine: ExternalEngine) => void;
  onNew?: () => void; onHistory?: () => void; historyOpen?: boolean; onClose?: () => void;
}) {
  return <header className="assistant-toolbar">
    <div className="assistant-engine"><Icon name="sparkle" size={16}/>
      <select id="agent-engine" aria-label="Assistant" title="Switch assistant" value={engine} disabled={busy}
        onChange={event => onEngineChange(event.target.value as ExternalEngine)}>
        <option value="codex">Codex</option><option value="claude">Claude Code</option><option value="opencode">OpenCode</option>
      </select>
    </div>
    <div className="assistant-toolbar-actions">
      <button type="button" aria-label="Session history" title="Session history" aria-expanded={!!historyOpen} disabled={busy || !onHistory} onClick={onHistory}><Icon name="archive" size={16}/></button>
      <button type="button" aria-label="New session" title="New session" disabled={busy || !onNew} onClick={onNew}><Icon name="plus" size={18}/></button>
      {onClose && <button type="button" aria-label="Close assistant" title="Close the assistant" onClick={onClose}><Icon name="close" size={16}/></button>}
    </div>
  </header>;
}
