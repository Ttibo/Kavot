import { useEffect, useState } from 'react';
import { toast } from '../../app/navigation';
import { Icon } from '../../components/Icon';
import { DiffView } from '../atelier/DiffView';
import { setAtelierIntent } from '../atelier/intent';
import { cost, duration, tokens, totalTokens, type Diff, type Usage } from '../atelier/types';
import { openAtelierBeside } from '../projects/navigation';
import { agents, type Code, type Run, type Session } from './api';
import { budgetAlert, budgetOf, CONVERSATION_LIMIT, MESSAGE_LIMIT, MESSAGE_WARN } from './budget';

/** What the conversation works on: its code (each folder in a worktree) and the resources it reads. */
export function ContextBar({ session, pane }: { session: Session; pane: string }) {
  const code = session.code;
  if (!code || (!code.workspaces.length && !code.resources.length)) return null;
  const showFolder = (folderId: string) => {
    setAtelierIntent(code.project_id, 'code', { folderId });
    void openAtelierBeside(code.project_id, 'code', pane);
  };
  return <div className="atelier-context" aria-label="What this agent works on">
    <span className="atelier-context-label">{code.workspaces.some(space => space.worktree) ? 'Works in' : 'Reads'}</span>
    {code.workspaces.map((space, index) => {
      const changed = space.files?.length || 0;
      return <button key={space.folder_id} className={`atelier-context-folder ${!space.worktree && !space.commit ? 'closed' : ''}`} onClick={() => showFolder(space.folder_id)}
        title={`${space.name} — open its code beside\nWorktree: ${space.worktree || 'closed'}\nBranch ${space.branch} from ${space.base_branch || space.base_sha.slice(0, 8)}`}>
        <Icon name="code" size={12}/><strong>{space.name}</strong>{index === 0 && code.workspaces.length > 1 && <em>main</em>}
        <small>{space.base_branch || 'HEAD'}</small>{changed > 0 && <span className="atelier-context-count">{changed}</span>}
        {space.merged ? <span className="atelier-context-state">merged</span> : space.commit ? <span className="atelier-context-state">committed</span> : null}
      </button>;
    })}
    {code.resources.map(item => <button key={item.folder_id} className="atelier-context-folder resource" onClick={() => showFolder(item.folder_id)} title={`${item.name} — read only\n${item.path}`}>
      <Icon name={item.file ? 'notes' : 'folder'} size={12}/><strong>{item.name}</strong><small>read only</small></button>)}
  </div>;
}

/** The code changes of the conversation: review, commit (and merge), or discard. */
export function ChangesPanel({ session, onChanged, onClose }: { session: Session; onChanged: (code: Code | null) => void; onClose: () => void }) {
  const code = session.code!;
  const [diff, setDiff] = useState<Diff | null>(null);
  const [message, setMessage] = useState(session.title);
  const [merge, setMerge] = useState(true);
  const [busy, setBusy] = useState(false);
  const running = !!session.active_run_id;
  const open = code.status === 'open' || code.status === 'review';
  const files = code.workspaces.flatMap(space => space.files || []);
  const into = code.workspaces[0]?.base_branch || 'the checkout';
  useEffect(() => {
    if (running) return;
    setDiff(null);
    agents.diff(session.id).then(setDiff).catch(() => setDiff({ files: [], truncated: false }));
  }, [session.id, running, code.status, files.length]);
  async function act(action: () => Promise<Code>, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    try { onChanged(await action()); }
    catch (reason) { toast((reason as Error).message, 'error'); }
    finally { setBusy(false); }
  }
  return <aside className="atelier-changes" aria-label="Changes">
    <header><strong>Changes</strong><code className="atelier-muted">{code.workspaces[0]?.branch}</code><span className="atelier-head-spacer"/>
      {open && code.worktree_exists && <button className="text-link" disabled={busy || running} onClick={() => void act(() => agents.discard(session.id), 'Discard these changes? The worktrees and their branch are deleted.')}>Discard</button>}
      {code.status === 'accepted' && <button className="text-link" disabled={busy} onClick={() => void act(() => agents.discard(session.id), 'Delete the committed branch?')}>Delete the branch</button>}
      <button className="icon-button" aria-label="Close the changes" onClick={onClose}><Icon name="close" size={12}/></button></header>
    {open && files.length > 0 && <form className="atelier-commit" onSubmit={event => { event.preventDefault(); void act(() => agents.accept(session.id, message, merge)); }}>
      <input value={message} onChange={event => setMessage(event.target.value)} maxLength={2000} aria-label="Commit message" placeholder="Commit message"/>
      <div className="atelier-commit-row">
        <label className="atelier-check"><input type="checkbox" checked={merge} onChange={event => setMerge(event.target.checked)}/> then merge into <code>{into}</code></label>
        <span className="atelier-head-spacer"/>
        <button className="button button-primary button-small" disabled={busy || running || !message.trim()}>{merge ? 'Commit & merge' : 'Commit'}</button>
      </div>
    </form>}
    {code.status === 'accepted' && <div className="atelier-changes-banner static"><Icon name="check" size={13}/><span>Committed on <code>{code.workspaces[0]?.branch}</code></span><span className="atelier-head-spacer"/>
      <button className="button button-small button-primary" disabled={busy} onClick={() => void act(() => agents.merge(session.id))}>Merge into {into}</button></div>}
    <div className="atelier-changes-body">{running ? <p className="atelier-empty">The diff appears when the agent finishes.</p>
      : !diff ? <p className="atelier-empty">Loading the diff…</p>
      : (diff.folders?.length || 0) > 1 ? diff.folders!.map(item => <section key={item.folder_id} className="atelier-diff-folder">
          <h4><Icon name="code" size={13}/>{item.name}<small>{item.files.length ? `${item.files.length} file${item.files.length > 1 ? 's' : ''}` : 'no change'}</small></h4>
          {item.error ? <p className="atelier-warning">{item.error}</p> : <DiffView files={item.files} truncated={item.truncated} empty="No change in this folder."/>}
        </section>)
      : <DiffView files={diff.files} truncated={diff.truncated} empty="The agent did not change any file."/>}</div>
  </aside>;
}

export function UsagePanel({ session, run, onClose }: { session: Session; run: Run | null; onClose: () => void }) {
  const live = run?.status === 'running' ? run.usage || {} : {};
  const usage: Usage = Object.fromEntries((['input', 'output', 'cache_read', 'cache_write', 'reasoning', 'cost_usd', 'turns', 'duration_ms'] as const)
    .map(key => [key, (session.usage?.[key] || 0) + (live[key] || 0)]));
  const total = totalTokens(usage);
  const tiles: [string, string, string?][] = [
    ['Total', tokens(total), 'tokens'], ['Input', tokens(usage.input || 0)], ['Output', tokens(usage.output || 0)],
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
      {total > 0 && <p className={`agent-usage-summary ${budget.level}`} style={{ '--budget-hue': budget.hue } as React.CSSProperties}>
        <i className="agent-budget-dot" aria-hidden="true"/>
        <span>{budgetAlert(budget) || `${tokens(total)} tokens so far, ${cached}% read from the cache. The latest request used ${tokens(budget.last)}.`}</span></p>}
      <div className="atelier-usage-grid">{tiles.map(([label, value, unit]) => <div key={label}><span>{label}</span><strong>{value}</strong>{unit && <small>{unit}</small>}</div>)}</div>
      {total > 0 && <div className="atelier-usage-bar" aria-hidden="true">
        {(['input', 'output', 'cache_read', 'cache_write', 'reasoning'] as const).map(key => (usage[key] || 0) > 0 && <i key={key} className={key} style={{ flexGrow: usage[key] }} title={`${key.replace('_', ' ')}: ${usage[key]}`}/>)}
      </div>}
      <h4>Per message</h4>
      {history.length ? <table className="atelier-usage-table"><thead><tr><th>Message</th><th>Total</th><th>In</th><th>Out</th><th>Cache</th><th>Cost</th><th>Time</th></tr></thead>
        <tbody>{history.map((row, index) => {
          const rowTotal = totalTokens(row);
          return <tr key={index}><td title={row.prompt}>{row.prompt || `Message ${index + 1}`}</td>
          <td className={`agent-answer-usage ${rowTotal >= MESSAGE_LIMIT ? 'over' : rowTotal >= MESSAGE_WARN ? 'warn' : 'ok'}`}>{tokens(rowTotal)}</td><td>{tokens(row.input || 0)}</td><td>{tokens(row.output || 0)}</td>
          <td>{tokens((row.cache_read || 0) + (row.cache_write || 0))}</td><td>{cost(row.cost_usd) || '—'}</td><td>{duration(row.duration_ms || 0)}</td></tr>;
        })}</tbody></table>
        : <p className="atelier-muted">Each message to the agent adds a line here when it finishes.</p>}
      <p className="atelier-muted">A request is flagged past {tokens(MESSAGE_WARN)} tokens and over its limit past {tokens(MESSAGE_LIMIT)}; a conversation past {tokens(CONVERSATION_LIMIT)}.
        Each call of the agent rereads the conversation: cached tokens are billed about ten times less, but they grow with every message.</p>
      <p className="atelier-muted">Counted from what {session.engine} reports. The cost is the engine's estimate; it stays empty when the engine gives none (a subscription, for example).</p>
    </div></div>
  </aside>;
}
