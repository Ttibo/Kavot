import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getRuntime } from '../../app/runtime';
import { AgentMessageContent } from '../../components/AgentMessageContent';
import { Icon } from '../../components/Icon';
import { relative, tokens, totalTokens } from '../atelier/types';
import { MESSAGE_LIMIT, MESSAGE_WARN, usageOfRun } from './budget';
import type { AgentEvent, Message, Mode, Proposal, Run, Session } from './api';

type Item =
  | { kind: 'user'; at: string; text: string; mode?: Mode; focus?: string }
  | { kind: 'agent'; at: string; text: string; final?: boolean; runId?: string; proposals?: Proposal[]; mode?: Mode; live?: boolean }
  | { kind: 'tool' | 'error' | 'status'; at: string; label: string; detail: string };

const QUIET = /^(Session started|Step |Run finished|Tool result|Sortie de l'outil|Done|Connecting to Kavot tools)/;
// Kavot's MCP server reports its own tool calls ("Workspace search"…): the CLI's line for the same call is left out.
const KAVOT_CALL = /^(mcp__kavot__|kavot_)/i;
const MODE_LABELS: Record<Mode, string> = { answer: '/plan', propose: '/edit', auto: '/auto' };

/** What the agent did, as thread items. `all` keeps the steps hidden by default (tool results, Kavot's own calls). */
function eventItems(events: AgentEvent[], all = false): Item[] {
  const items: Item[] = [];
  for (const event of events) {
    if (event.kind === 'raw') continue;
    if (!all && (event.kind === 'log' || QUIET.test(event.label) || KAVOT_CALL.test(event.label))) continue;
    if (event.kind === 'log') { items.push({ kind: 'tool', at: event.at, label: event.label, detail: event.detail }); continue; }
    if (event.kind === 'message') items.push({ kind: 'agent', at: event.at, text: event.detail });
    else if (event.kind === 'tool' || event.kind === 'error') items.push({ kind: event.kind, at: event.at, label: event.label, detail: event.detail });
    // The agent's reasoning reads as one of its steps.
    else if (event.kind === 'thinking') items.push({ kind: 'tool', at: event.at, label: event.label, detail: event.detail });
    else if (event.kind === 'write' || event.kind === 'proposal' || event.kind === 'status') items.push({ kind: 'status', at: event.at, label: event.label, detail: event.detail });
  }
  return items;
}

/** The conversation in time order: each request, what the agent did, its answer; without duplicates. */
function timeline(messages: Message[], run: Run | null, all = false): Item[] {
  const items: Item[] = [];
  const answered = new Set(messages.map(message => message.run_id).filter(Boolean));
  for (const message of messages) {
    const at = message.at || '';
    if (message.role === 'user') {
      const focus = message.context?.focus?.map((item: { title?: string }) => item.title).filter(Boolean).join(', ') || message.context?.view_label;
      items.push({ kind: 'user', at, text: message.content, mode: message.mode, focus });
      continue;
    }
    items.push(...eventItems(message.events || [], all));
    if (message.content) items.push({ kind: 'agent', at, text: message.content, final: true, runId: message.run_id, proposals: message.proposals, mode: message.mode });
    if (message.error) items.push({ kind: 'error', at, label: message.status === 'cancelled' ? 'Stopped' : 'Error', detail: message.error === 'Stopped.' ? '' : message.error });
  }
  // The request in progress, or one finished since the conversation was loaded.
  if (run && !answered.has(run.id)) {
    items.push(...eventItems(run.events || [], all));
    if (run.status === 'completed' && run.response) items.push({ kind: 'agent', at: '', text: run.response, final: true, runId: run.id, proposals: run.proposals, mode: run.mode });
  }
  const result: Item[] = [];
  for (const item of items) {
    const previous = result[result.length - 1];
    if (item.kind === 'agent' && item.final) {
      // The final answer usually repeats the agent's last streamed message.
      const lastIndex = result.map(entry => entry.kind).lastIndexOf('agent');
      const userIndex = result.map(entry => entry.kind).lastIndexOf('user');
      const last = result[lastIndex];
      if (last?.kind === 'agent' && lastIndex > userIndex && last.text.trim() === item.text.trim()) { result[lastIndex] = item; continue; }
    }
    if (item.kind === 'tool' && previous?.kind === 'tool' && previous.label === item.label && (!previous.detail || previous.detail === item.detail)) {
      result[result.length - 1] = item;
      continue;
    }
    result.push(item);
  }
  return result;
}

/** A tool call in one line: the file, command, pattern or Kavot address it used. */
function describeTool(detail: string) {
  try {
    const input = JSON.parse(detail);
    if (input && typeof input === 'object')
      return String(input.file_path || input.path || input.command || input.pattern || input.query || input.ref || input.url || input.kind || '');
  } catch { /* Plain text detail (Codex, OpenCode). */ }
  const first = detail.split('\n').find(line => line.trim()) || '';
  return first.length > 140 ? `${first.slice(0, 139)}…` : first;
}

/** What one answer cost, under it: tokens (cached included) and model calls, coloured past the request thresholds. */
function AnswerUsage({ session, runId }: { session: Session | null; runId?: string }) {
  const usage = usageOfRun(session, runId);
  const total = totalTokens(usage);
  if (!usage || !total) return null;
  const level = total >= MESSAGE_LIMIT ? 'over' : total >= MESSAGE_WARN ? 'warn' : 'ok';
  const cached = usage.cache_read ? Math.round(100 * usage.cache_read / total) : 0;
  return <small className={`agent-answer-usage ${level}`} title={`Input ${tokens(usage.input || 0)} · output ${tokens(usage.output || 0)} · cache read ${tokens(usage.cache_read || 0)}`}>
    {tokens(total)} tokens{cached ? ` · ${cached}% cached` : ''}{usage.turns && usage.turns > 1 ? ` · ${usage.turns} calls` : ''}</small>;
}

function ToolLine({ label, detail, open }: { label: string; detail: string; open?: boolean }) {
  const target = describeTool(detail);
  const icon = /edit|write|patch|file change/i.test(label) ? 'edit' : /bash|command|shell|exec/i.test(label) ? 'code' : /read|glob|grep|search|list|map|context/i.test(label) ? 'search' : 'sparkle';
  const body = <><Icon name={icon} size={12}/><strong>{label}</strong>{target && <code>{target}</code>}</>;
  return detail && detail.trim() !== target.trim()
    ? <details className="atelier-tool" open={open}><summary>{body}</summary><pre>{detail}</pre></details>
    : <div className="atelier-tool">{body}</div>;
}

function elapsed(from?: string) {
  const seconds = from ? Math.max(0, Math.round((Date.now() - new Date(from).getTime()) / 1000)) : 0;
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function ProposalCard({ proposal, mode, busy, folded, onDecide, onNavigate }: {
  proposal: Proposal; mode?: Mode; busy?: boolean; folded?: boolean; onDecide: (decision: 'apply' | 'dismiss') => void; onNavigate?: () => void;
}) {
  const kind = proposal.kind || proposal.action?.kind;
  const isDeletion = kind?.endsWith('_delete') ?? false;
  const isNewNote = kind === 'note_create';
  const isNewProject = kind === 'project_create';
  const isNote = isNewNote || ['note_update', 'note_block_update', 'note_block_insert', 'note_block_delete', 'note_content_replace', 'note_script_set'].includes(kind || '');
  const content = typeof proposal.after === 'string' ? proposal.after : proposal.after?.content;
  const noteId = proposal.result?.id || proposal.action?.id;
  return <article className={'assistant-change ' + proposal.status}>
    <header><Icon name={isNewNote || isNewProject ? 'plus' : 'edit'} size={16}/><div><strong>{proposal.label}</strong><small>{proposal.target}</small></div></header>
    {isNote && content !== undefined ? <details className="assistant-note-preview" open={proposal.status === 'pending' && !folded}><summary>{isNewNote ? 'Note preview' : 'Note after the change'}</summary><AgentMessageContent content={content} onNavigate={onNavigate}/></details> : null}
    <details className="assistant-diff" open={isDeletion && proposal.status === 'pending'}><summary>{isDeletion ? 'Items affected by the deletion' : 'View the change'}</summary><pre>{proposal.diff}</pre></details>
    {proposal.action?.values?.url && /^https?:\/\//i.test(proposal.action.values.url) && <a href={proposal.action.values.url} target="_blank" rel="noreferrer">Open the source ↗</a>}
    {proposal.action?.values?.doi && <a href={'https://doi.org/' + encodeURIComponent(proposal.action.values.doi)} target="_blank" rel="noreferrer">DOI : {proposal.action.values.doi}</a>}
    {proposal.status === 'pending' && mode === 'answer' && <small>Sent in /plan: ask again in /edit to apply it.</small>}
    {proposal.status === 'pending' ? <div className="assistant-change-actions">
      <button className="assistant-apply" type="button" disabled={busy || mode === 'answer'} onClick={() => onDecide('apply')}
        aria-label={isDeletion ? 'Approve this deletion' : isNewNote ? 'Create this note' : isNewProject ? 'Create this project' : 'Apply this change'}>
        {isDeletion ? 'Approve the deletion' : isNewNote ? 'Create the note' : isNewProject ? 'Create the project' : 'Apply'}</button>
      <button type="button" disabled={busy} onClick={() => onDecide('dismiss')}>Dismiss</button></div>
      : <span className="assistant-change-status">{proposal.status === 'applied' ? '✓ ' + (isNewNote ? 'Note created' : isNewProject ? 'Project created' : 'Change applied') : 'Dismissed'}</span>}
    {proposal.status === 'applied' && isNote && noteId && <AgentMessageContent content={'[Open the note](./?view=notes&note_id=' + noteId + ')'} onNavigate={onNavigate}/>}
    {proposal.status === 'applied' && proposal.result?.kind === 'paper_import' && <button type="button" onClick={async () => { await getRuntime().openPaper(proposal.result!.id!); onNavigate?.(); }}>Open the article</button>}
  </article>;
}

/** Where each conversation was read, kept when its view is rebuilt (a hidden tab, a redrawn pane). */
const positions = new Map<string, { pinned: boolean; top: number; requests: number }>();
const ACTIONS_KEY = 'kavot-agent-actions-expanded';

export function Thread({ session, run, name, busy, empty, onDecide, onApplyAll, onNavigate }: {
  session: Session | null; run: Run | null; name: string; busy?: boolean; empty: React.ReactNode;
  onDecide: (runId: string, proposalId: string, decision: 'apply' | 'dismiss') => void;
  onApplyAll?: (runId: string, proposalIds: string[]) => void; onNavigate?: () => void;
}) {
  const [, tick] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const shown = useRef<string | undefined>(undefined);
  // Every step of the agent, unfolded, or grouped as "N actions" (the default); the choice is remembered.
  const [allActions, setAllActions] = useState(() => { try { return localStorage.getItem(ACTIONS_KEY) === 'true'; } catch { return false; } });
  const toggleActions = () => setAllActions(value => { try { localStorage.setItem(ACTIONS_KEY, String(!value)); } catch { /* Kept for this session. */ } return !value; });
  const items = useMemo(() => timeline(session?.messages || [], run, allActions), [session?.messages, run, allActions]);
  const running = run?.status === 'running';
  const requests = (session?.messages || []).filter(message => message.role === 'user').length;
  const seen = useRef({ requests, running });
  // Reading above the end: a button brings the latest back.
  const [away, setAway] = useState(false);
  const toEnd = () => {
    const element = scroller.current;
    if (!element) return;
    pinned.current = true; setAway(false);
    element.scrollTop = element.scrollHeight;
  };
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => tick(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (shown.current !== session?.id) {
      shown.current = session?.id;
      // A conversation reopened where it was read, unless something was asked since: then at its end.
      const saved = session?.id ? positions.get(session.id) : undefined;
      pinned.current = !saved || saved.pinned || saved.requests !== requests;
      if (element && !pinned.current && saved) element.scrollTop = saved.top;
      seen.current = { requests, running };
    }
    // A new request, or an answer starting: the conversation follows it.
    if (requests > seen.current.requests || (running && !seen.current.running)) pinned.current = true;
    seen.current = { requests, running };
    if (pinned.current && element) element.scrollTop = element.scrollHeight;
    setAway(!pinned.current);
  }, [session?.id, items.length, run?.draft, run?.status, requests]);
  // Answers finish drawing after they mount (Markdown, proposals): while the reader is at the end, stay there.
  useEffect(() => {
    const element = scroller.current;
    const content = element?.firstElementChild;
    if (!element || !content) return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) element.scrollTop = element.scrollHeight;
      else {
        const saved = session?.id ? positions.get(session.id) : undefined;
        if (saved && element.scrollTop < saved.top && element.scrollHeight > saved.top) element.scrollTop = saved.top;
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [session?.id, items.length > 0]);
  const lastUser = [...(session?.messages || [])].reverse().find(message => message.role === 'user');
  const applyAll = (item: Extract<Item, { kind: 'agent' }>) => {
    const pending = (item.proposals || []).filter(proposal => proposal.status === 'pending');
    return onApplyAll && item.runId && item.mode !== 'answer' && pending.length > 1 && <div className="assistant-apply-all">
      <span>{pending.length} changes proposed</span>
      <button className="assistant-apply" type="button" disabled={busy || running} onClick={() => onApplyAll(item.runId!, pending.map(proposal => proposal.proposal_id))}>Apply all</button>
    </div>;
  };
  // While the agent works, what it is doing now (its latest step, even when steps are grouped).
  const current = running ? [...eventItems(run?.events || [], true)].reverse().find(item => item.kind === 'tool' || item.kind === 'status') : undefined;
  const errors = run && !running ? run.proposal_errors || [] : [];
  return <div className="atelier-thread-scroll" ref={scroller} aria-live="polite"
    onScroll={event => {
      const el = event.currentTarget;
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      setAway(!pinned.current);
      if (session?.id) positions.set(session.id, { pinned: pinned.current, top: el.scrollTop, requests });
    }}>
    {!items.length && !running ? empty : <div className="atelier-messages">
      {items.some(item => item.kind === 'tool') || allActions ? <div className="atelier-thread-tools">
        <button type="button" aria-pressed={allActions} onClick={toggleActions} title={allActions ? 'Group the steps of the agent' : 'Show every step of the agent, unfolded'}>
          <Icon name={allActions ? 'archive' : 'sparkle'} size={12}/>{allActions ? 'Group actions' : 'Show every action'}
        </button>
      </div> : null}
      {groupActions(items, allActions).map(({ item, index, tools }) => tools
        ? <details key={index} className="atelier-actions">
            <summary><Icon name="sparkle" size={12}/><strong>{tools.length} actions</strong><span>{tools[tools.length - 1].label}</span></summary>
            {tools.map((tool, offset) => <ToolLine key={offset} label={tool.label} detail={tool.detail}/>)}
          </details>
        : item.kind === 'user'
        ? <div key={index} className="atelier-bubble user"><p>{item.text}</p>
            <small>{item.mode && item.mode !== 'answer' ? <span className="agent-bubble-mode">{MODE_LABELS[item.mode]}</span> : null}{item.focus ? <span title={item.focus}>{item.focus}</span> : null}{relative(item.at)}</small></div>
        : item.kind === 'agent' ? <div key={index} className="agent-answer">
            <div className="atelier-bubble agent"><AgentMessageContent content={item.text} onNavigate={onNavigate}/></div>
            {item.final && <AnswerUsage session={session} runId={item.runId}/>}
            {item.final && !!item.proposals?.length && <section className="external-proposals" aria-label="Proposed changes">
              {/* One answer often proposes a change per section of a note: they apply together, in order. */}
              {applyAll(item)}
              {item.proposals.map(proposal => <ProposalCard key={proposal.proposal_id} proposal={proposal} mode={item.mode} busy={busy || running}
                folded={item.proposals!.length > 1}
                onDecide={decision => item.runId && onDecide(item.runId, proposal.proposal_id, decision)} onNavigate={onNavigate}/>)}
              {item.proposals.length > 2 && applyAll(item)}
            </section>}
          </div>
        : item.kind === 'tool' ? <ToolLine key={index} label={item.label} detail={item.detail} open={allActions}/>
        : item.kind === 'error' ? <div key={index} className="atelier-warning"><strong>{item.label}</strong> {item.detail}</div>
        : <div key={index} className="atelier-system"><span>{item.label}</span>{item.detail && <code>{item.detail}</code>}</div>)}
      {running && run?.draft && <div className="atelier-bubble agent streaming"><AgentMessageContent content={run.draft}/></div>}
      {running && <div className="atelier-working"><i className="atelier-spinner"/>{name} is working · {elapsed(run?.started_at || lastUser?.at)}
        {current && 'label' in current && <span className="atelier-working-step" title={current.label}>{current.label}</span>}</div>}
      {!!errors.length && <section className="assistant-proposal-errors" role="alert">
        <strong>{run?.proposals?.length ? 'Some changes could not be prepared' : 'The change was not prepared'}</strong>
        {errors.map((message, index) => <p key={index}>{message}</p>)}
      </section>}
    </div>}
    {away && <button type="button" className="atelier-jump" onClick={toEnd} aria-label="Go to the latest message"><Icon name="arrow" size={12}/>Latest</button>}
  </div>;
}

type ToolItem = Extract<Item, { label: string }>;
type Block = { item: Item; index: number; tools?: ToolItem[] };

/** Consecutive steps of the agent folded into one "N actions" line, unless every action is shown. */
function groupActions(items: Item[], all: boolean): Block[] {
  const blocks: Block[] = [];
  items.forEach((item, index) => {
    const last = blocks[blocks.length - 1];
    if (!all && item.kind === 'tool' && last) {
      if (last.tools) { last.tools.push(item); return; }
      if (last.item.kind === 'tool') { last.tools = [last.item as ToolItem, item]; return; }
    }
    blocks.push({ item, index });
  });
  return blocks;
}
