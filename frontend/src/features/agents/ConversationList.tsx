import { useState } from 'react';
import { useOptionalRuntime } from '../../app/runtime';
import { Icon } from '../../components/Icon';
import type { ExternalEngine } from '../../components/ExternalAgentSettings';
import { relative, tokens, totalTokens } from '../atelier/types';
import { ENGINE_NAMES, needsAttention, STATUS_LABELS, statusOf, type Summary } from './api';

function dayGroup(value: string) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.floor((today.getTime() - new Date(value).setHours(0, 0, 0, 0)) / 86_400_000);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? 'Previous 7 days' : days < 30 ? 'Previous 30 days' : 'Older';
}

/** Every conversation, the ones that need the user first (running, changes to review, failed), then by day. */
export function ConversationList({ items, selected, engines, showProject, onSelect, onNew }: {
  items: Summary[]; selected: string | null; engines: ExternalEngine[]; showProject?: boolean;
  onSelect: (id: string) => void; onNew?: () => void;
}) {
  const runtime = useOptionalRuntime();
  const [query, setQuery] = useState('');
  const [engine, setEngine] = useState<ExternalEngine | 'all'>('all');
  const projectName = (id?: number) => id ? runtime?.state.projects.find((project: Project) => project.id === id)?.name : undefined;
  const shown = items.filter(item => (engine === 'all' || item.engine === engine)
    && (!query.trim() || item.title.toLowerCase().includes(query.trim().toLowerCase())));
  const groups: [string, Summary[]][] = [];
  for (const item of shown) {
    const label = needsAttention(statusOf(item)) ? 'Needs you' : dayGroup(item.updated_at);
    const group = groups.find(([name]) => name === label);
    if (group) group[1].push(item); else groups.push([label, [item]]);
  }
  groups.sort(([a], [b]) => Number(b === 'Needs you') - Number(a === 'Needs you'));
  return <nav className="atelier-run-list agent-conversations" aria-label="Conversations">
    {onNew && <button className={`atelier-run-item new ${!selected ? 'active' : ''}`} onClick={onNew}><Icon name="plus" size={12}/> New conversation</button>}
    {items.length > 6 && <input type="search" className="agent-conversation-search" aria-label="Search conversations" placeholder="Search" value={query} onChange={event => setQuery(event.target.value)}/>}
    {engines.length > 1 && items.length > 6 && <div className="chat-engine-filter" role="group" aria-label="Agent">
      <button aria-pressed={engine === 'all'} onClick={() => setEngine('all')}>All</button>
      {engines.map(id => <button key={id} aria-pressed={engine === id} onClick={() => setEngine(id)}>{ENGINE_NAMES[id]}</button>)}
    </div>}
    {groups.map(([label, group]) => <section key={label}><h4>{label}</h4>
      {group.map(item => {
        const status = statusOf(item);
        const project = showProject ? projectName(item.project_id) : undefined;
        return <button key={item.id} className={`atelier-run-item ${selected === item.id ? 'active' : ''}`} onClick={() => onSelect(item.id)} title={item.title}>
          <span className={`atelier-dot ${status === 'answered' || status === 'new' ? 'answered' : status}`}/>
          <span className="atelier-run-copy"><strong>{item.title || 'New conversation'}</strong>
            <small>{[STATUS_LABELS[status], ENGINE_NAMES[item.engine], project, (item.code?.workspaces || []).map(space => space.name).join(' + '),
              totalTokens(item.usage) ? `${tokens(totalTokens(item.usage))} tok` : '', relative(item.updated_at)].filter(Boolean).join(' · ')}</small></span>
        </button>;
      })}
    </section>)}
    {!shown.length && <p className="atelier-muted agent-conversations-empty">{items.length ? 'No conversation matches.' : 'Your conversations with the agents appear here.'}</p>}
  </nav>;
}
