import type { CSSProperties } from 'react';
import { Icon } from '../../components/Icon';
import { billedTokens, cost, duration, tokens, totalTokens, type Usage } from './format';
import type { Run, Session } from './api';
import { budgetAlert, budgetOf, CONVERSATION_LIMIT, MESSAGE_LIMIT, MESSAGE_WARN } from './budget';

export function UsagePanel({ session, run, onClose }: { session: Session; run: Run | null; onClose: () => void }) {
  const live = run?.status === 'running' ? run.usage || {} : {};
  const usage: Usage = Object.fromEntries((['input', 'output', 'cache_read', 'cache_write', 'reasoning', 'cost_usd', 'turns', 'duration_ms'] as const)
    .map(key => [key, (session.usage?.[key] || 0) + (live[key] || 0)]));
  const total = totalTokens(usage);
  const tiles: [string, string, string?][] = [
    ['Billed as', tokens(billedTokens(usage)), 'tokens'], ['Processed', tokens(total), 'tokens'], ['Input', tokens(usage.input || 0)], ['Output', tokens(usage.output || 0)],
    ['Cache read', tokens(usage.cache_read || 0)], ['Cache write', tokens(usage.cache_write || 0)],
    ...(usage.reasoning ? [['Reasoning', tokens(usage.reasoning)] as [string, string]] : []),
    ['Cost', cost(usage.cost_usd) || '—'], ['Turns', String(usage.turns || 0)], ['Agent time', duration(usage.duration_ms || 0)],
  ];
  const history = session.usage_history || [];
  const budget = budgetOf(session, run);
  const cached = total ? Math.round(100 * (usage.cache_read || 0) / total) : 0;
  return <aside className="atelier-changes" aria-label="Usage">
    <header><strong>Usage</strong><span className="atelier-muted">{session.engine}{session.model ? ` · ${session.model}` : ''}</span><span className="atelier-head-spacer"/>
      <button className="icon-button" aria-label="Close the usage" onClick={onClose}><Icon name="close" size={12}/></button></header>
    <div className="atelier-changes-body"><div className="atelier-usage">
      {run?.status === 'running' && <p className="atelier-live"><i className="atelier-spinner"/>Counting while the agent works…</p>}
      {total > 0 && <p className={`agent-usage-summary ${budget.level}`} style={{ '--budget-hue': budget.hue } as CSSProperties}>
        <i className="agent-budget-dot" aria-hidden="true"/>
        <span>{budgetAlert(budget) || `${tokens(budget.total)} tokens billed so far (${tokens(total)} processed, ${cached}% read from the cache). The latest request: ${tokens(budget.last)}.`}</span></p>}
      <div className="atelier-usage-grid">{tiles.map(([label, value, unit]) => <div key={label}><span>{label}</span><strong>{value}</strong>{unit && <small>{unit}</small>}</div>)}</div>
      {total > 0 && <div className="atelier-usage-bar" aria-hidden="true">
        {(['input', 'output', 'cache_read', 'cache_write', 'reasoning'] as const).map(key => (usage[key] || 0) > 0 && <i key={key} className={key} style={{ flexGrow: usage[key] }} title={`${key.replace('_', ' ')}: ${usage[key]}`}/>)}
      </div>}
      <h4>Per message</h4>
      {history.length ? <table className="atelier-usage-table"><thead><tr><th>Message</th><th title="Cached tokens count a tenth">Billed</th><th>In</th><th>Out</th><th>Cache</th><th>Cost</th><th>Time</th></tr></thead>
        <tbody>{history.map((row, index) => {
          const rowTotal = billedTokens(row);
          return <tr key={index}><td title={row.prompt}>{row.prompt || `Message ${index + 1}`}</td>
          <td className={`agent-answer-usage ${rowTotal >= MESSAGE_LIMIT ? 'over' : rowTotal >= MESSAGE_WARN ? 'warn' : 'ok'}`}>{tokens(rowTotal)}</td><td>{tokens(row.input || 0)}</td><td>{tokens(row.output || 0)}</td>
          <td>{tokens((row.cache_read || 0) + (row.cache_write || 0))}</td><td>{cost(row.cost_usd) || '—'}</td><td>{duration(row.duration_ms || 0)}</td></tr>;
        })}</tbody></table>
        : <p className="atelier-muted">Each message to the agent adds a line here when it finishes.</p>}
      <p className="atelier-muted">A request is flagged past {tokens(MESSAGE_WARN)} tokens and over its limit past {tokens(MESSAGE_LIMIT)}; a conversation past {tokens(CONVERSATION_LIMIT)}.
        Each call of the agent rereads the conversation; cached tokens are billed about ten times less, so they count a tenth here.</p>
      <p className="atelier-muted">Counted from what {session.engine} reports. The cost is the engine's estimate; it stays empty when the engine gives none (a subscription, for example).</p>
    </div></div>
  </aside>;
}
