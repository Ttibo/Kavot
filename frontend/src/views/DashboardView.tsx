import { useEffect, useState, type ReactNode } from 'react';
import { useRuntime } from '../app/runtime';
import { showView, viewVersion } from '../app/viewBridge';
import { refreshState } from '../app/navigation';
import { api } from '../services/api';
import { FitList, ViewHeader, ViewPage } from '../components/ViewLayout';
import { Icon } from '../components/Icon';
import { workspaceColor } from '../styles/palette';

const DAY = 86400000;
const timestamp = (value?: string) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const localDate = (value: string) => new Date(value.length === 10 ? `${value}T00:00:00` : value);
const dateLabel = (value?: string) => timestamp(value) ? localDate(value!).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'Date unavailable';
/** Whole days between two YYYY-MM-DD keys. */
const dayOffset = (key: string, today: string) => Math.round((Date.parse(`${key}T00:00:00`) - Date.parse(`${today}T00:00:00`)) / DAY);
const relativeDay = (key: string, today: string) => {
  const offset = dayOffset(key, today);
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Tomorrow';
  if (offset === -1) return 'Yesterday';
  const label = offset > 1 && offset < 7 ? localDate(key).toLocaleDateString(undefined, { weekday: 'long' }) : localDate(key).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return label.charAt(0).toUpperCase() + label.slice(1);
};
const relativeTime = (value?: string) => {
  const elapsed = Date.now() - timestamp(value);
  if (!timestamp(value)) return 'Date unavailable';
  if (elapsed < 60000) return 'Just now';
  if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / 3600000)} h ago`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)} d ago`;
  return dateLabel(value);
};
/** Note bodies may be HTML; the home card only shows a plain excerpt. */
const plainText = (value = '') => value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const priorityRank = (priority?: string) => ({ high: 0, medium: 1, low: 2 }[priority || ''] ?? 3);
const greeting = (hour: number) => hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

export function DashboardView() {
  const runtime = useRuntime();
  const { state } = runtime;
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [completing, setCompleting] = useState<Set<number>>(() => new Set());
  const version = viewVersion('dashboard');
  const now = new Date();
  const today = runtime.calendarLocalDateKey(now);
  useEffect(() => {
    const controller = new AbortController();
    const end = new Date(); end.setDate(end.getDate() + 7);
    const params = new URLSearchParams({ start: today, end: runtime.calendarLocalDateKey(end) });
    setLoading(true); setError(false);
    api<any[]>(`/calendar/events?${params}`, { signal: controller.signal }).then(items => {
      if (controller.signal.aborted) return;
      setEvents(items); state.calendarEvents = items;
    }).catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [today, version, retry, runtime, state]);

  const projects = [...state.projects].filter(p => p.status !== 'archived').sort((a, b) => timestamp(b.updated_at) - timestamp(a.updated_at));
  const projectById = new Map(state.projects.map(p => [p.id, p]));
  const tasks = state.tasks.filter(t => !t.archived_at && t.status !== 'done' && !completing.has(t.id)).sort((a, b) =>
    (timestamp(a.due_date) || Infinity) - (timestamp(b.due_date) || Infinity) || priorityRank(a.priority) - priorityRank(b.priority));
  const dueIn = (task: any) => task.due_date ? dayOffset(task.due_date.slice(0, 10), today) : Infinity;
  const overdue = tasks.filter(t => dueIn(t) < 0);
  const dueToday = tasks.filter(t => dueIn(t) === 0);
  // Home only lists what needs attention this week; the Tasks view holds the rest.
  const focusTasks = tasks.filter(t => dueIn(t) < 7 || t.priority === 'high');

  const reading = state.papers.filter(p => p.status === 'reading');
  const recent = state.papers.find(p => p.id === state.recentPaper?.paperId && p.status !== 'read' && p.status !== 'key');
  const paper = recent || reading[0];
  const queue = [...reading, ...state.papers.filter(p => p.status === 'to_read')].filter(p => p.id !== paper?.id);
  const savedPage = paper ? Number(state.readingProgress[String(paper.id)] || (recent ? state.recentPaper?.page : 1) || 1) : 1;
  const upcoming = events.filter(e => e.all_day ? String(e.ends_at || e.starts_at).slice(0, 10) >= today : timestamp(e.ends_at || e.starts_at) >= Date.now()).sort((a, b) => timestamp(a.starts_at) - timestamp(b.starts_at));
  const nextToday = upcoming.find(e => e.starts_at.slice(0, 10) <= today);
  const notes = [...state.notes].filter(n => !n.trashed_at).sort((a, b) => timestamp(b.updated_at) - timestamp(a.updated_at)).slice(0, 40);
  const [note, ...otherNotes] = notes;
  const noteProject = note?.project_id ? projectById.get(note.project_id) : undefined;
  const noteExcerpt = note ? plainText(note.content).slice(0, 240) : '';

  const completeTask = async (task: any) => {
    setCompleting(current => new Set(current).add(task.id));
    try {
      await api(`/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
      await refreshState(['tasks', 'taskColumns', 'projects']);
      runtime.toast(`“${task.title}” completed`);
      showView('dashboard');
    } catch (failure) {
      runtime.toast((failure as Error).message, 'error');
    } finally {
      setCompleting(current => { const next = new Set(current); next.delete(task.id); return next; });
    }
  };

  const openPaper = (item: any) => item.file_path
    ? { 'data-action': 'open-paper-workspace', 'data-paper-id': item.id }
    : { onClick: () => { state.libraryReadingPaperId = item.id; runtime.navigate('papers'); } };
  const empty = (title: string, text: string, action: ReactNode) => <div className="fit-empty"><div><strong>{title}</strong><p>{text}</p>{action}</div></div>;
  const panel = (className: string, icon: string, title: string, count: number | undefined, link: ReactNode, body: ReactNode) => <article className={`view-panel ${className}`}>
    <header className="view-panel-head"><h2><Icon name={icon} size={14}/>{title}</h2>{count !== undefined && <span className="view-header-count">{count}</span>}{link}</header>{body}
  </article>;
  const dueChip = (task: any) => {
    if (!task.due_date) return <span className="home-due is-none">No date</span>;
    const offset = dueIn(task);
    const tone = offset < 0 ? 'is-overdue' : offset === 0 ? 'is-today' : offset < 7 ? 'is-soon' : '';
    return <span className={`home-due ${tone}`} title={dateLabel(task.due_date)}>{offset < 0 ? `${-offset} d late` : relativeDay(task.due_date.slice(0, 10), today)}</span>;
  };
  // Only what needs attention today; nothing is shown when the day is clear.
  const pulse = [
    overdue.length > 0 && <button key="overdue" type="button" className="home-pill is-alert" data-nav="tasks"><Icon name="tasks" size={12}/>{overdue.length} overdue</button>,
    dueToday.length > 0 && <button key="today" type="button" className="home-pill is-accent" data-nav="tasks"><Icon name="check" size={12}/>{dueToday.length} due today</button>,
    nextToday && <button key="event" type="button" className="home-pill" onClick={() => runtime.openCalendarEvent(nextToday.id)}><Icon name="calendar" size={12}/>{nextToday.all_day ? nextToday.title : `${nextToday.starts_at.slice(11, 16)} · ${nextToday.title}`}</button>,
  ].filter(Boolean);

  return <ViewPage className="dashboard-view focus-home" label="Research Home">
    <ViewHeader icon="home" title={greeting(now.getHours())} subtitle={now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}>
      <button className="button" data-action="new-task"><Icon name="tasks" size={14}/>New task</button>
      <button className="button button-primary" data-action="new-note"><Icon name="notes" size={14}/>Quick note</button>
    </ViewHeader>
    <div className="home-strip">
      {pulse.length ? <div className="home-pulse" role="group" aria-label="Needs attention today">{pulse}</div> : <span className="home-strip-calm"><Icon name="check" size={12}/>Nothing urgent today</span>}
      {projects.length > 0 && <nav className="home-projects-strip" aria-label="Recent projects">
        {projects.slice(0, 4).map(project => <button key={project.id} type="button" className="home-pill" data-project-area="canvas" data-project-id={project.id} style={{ '--project-accent': workspaceColor(project.color) } as any}><i className="project-dot"/>{project.name}</button>)}
        <button type="button" className="text-link" data-nav="projects">All projects</button>
      </nav>}
    </div>
    <div className="view-body dashboard-grid">
      <article className="view-panel home-continue dashboard-reading" aria-label="Continue reading">
        <div className="home-continue-hero">
          <span className="section-eyebrow"><Icon name="papers" size={13}/> Continue reading</span>
          <h2>{paper?.title || 'Nothing in progress'}</h2>
          <p>{paper ? (paper.authors || []).slice(0, 3).join(', ') || paper.publication || 'Research article' : 'Open an article from your library. Your reading position is saved here.'}</p>
          <footer>
            {paper ? <button className="button button-primary" {...openPaper(paper)}>Resume reading <Icon name="arrow" size={14}/></button> : <button className="button button-primary" data-nav="papers">Open library <Icon name="arrow" size={14}/></button>}
            {paper?.file_path && <span className="home-meta">Page {savedPage}</span>}
          </footer>
        </div>
        <div className="home-continue-list">
          <span className="home-list-title">Up next{queue.length > 0 && ` · ${queue.length}`}<button type="button" className="text-link" data-nav="papers">Library</button></span>
          <FitList label="Reading queue pages" compact items={queue} render={item => <button key={item.id} className="view-row" {...openPaper(item)}>
            <span className={`home-status-dot${item.status === 'reading' ? ' is-reading' : ''}`}/>
            <span><strong>{item.title}</strong><small>{item.status === 'reading' ? 'In progress' : 'To read'}{item.authors?.length ? ` · ${item.authors[0]}` : ''}</small></span><Icon name="chevron" size={13}/></button>}
            empty={<p className="home-list-empty">Mark articles “To read” in the library to queue them here.</p>}/>
        </div>
      </article>
      <article className="view-panel home-continue dashboard-writing" aria-label="Continue writing">
        <div className="home-continue-hero">
          <span className="section-eyebrow"><Icon name="notes" size={13}/> Continue writing</span>
          <h2>{note ? note.title || 'Untitled note' : 'No notes yet'}</h2>
          <p>{note ? noteExcerpt || 'Empty note' : 'Capture an idea with Quick note; your latest note will wait for you here.'}</p>
          <footer>
            {note ? <button className="button button-primary" data-note={note.id}>Open note <Icon name="arrow" size={14}/></button> : <button className="button button-primary" data-action="new-note">Write a note <Icon name="arrow" size={14}/></button>}
            {note && <span className="home-meta">{noteProject && <><i className="project-dot" style={{ background: workspaceColor(noteProject.color) }}/>{noteProject.name} · </>}Edited {relativeTime(note.updated_at).toLowerCase()}</span>}
          </footer>
        </div>
        <div className="home-continue-list">
          <span className="home-list-title">Recent notes<button type="button" className="text-link" data-nav="notes">All notes</button></span>
          <FitList label="Recent note pages" compact items={otherNotes} render={item => <button key={item.id} className="view-row" data-note={item.id}>
            <Icon name="notes" size={13}/><span><strong>{item.title || 'Untitled note'}</strong><small>{relativeTime(item.updated_at)}</small></span><Icon name="chevron" size={13}/></button>}
            empty={<p className="home-list-empty">Your other recent notes will appear here.</p>}/>
        </div>
      </article>
      {panel('dashboard-tasks', 'tasks', 'This week', focusTasks.length, <button className="text-link" data-nav="tasks">All tasks</button>,
        <FitList label="Task pages" compact items={focusTasks} render={task => {
          const project = projectById.get(task.project_id);
          return <div className={`view-row home-task priority-${task.priority || 'medium'}`} key={task.id}>
            <button type="button" className="home-check" aria-label={`Mark “${task.title}” as done`} title="Mark as done" disabled={completing.has(task.id)} onClick={() => completeTask(task)}><Icon name="check" size={12}/></button>
            <button type="button" className="home-task-open" data-action="edit-task" data-task-id={task.id}>
              <span><strong>{task.title}</strong><small>{project ? <><i className="project-dot" style={{ background: workspaceColor(project.color) }}/>{project.name}</> : 'General'}{task.priority === 'high' && <em className="home-flag">High priority</em>}</small></span>
              {dueChip(task)}
            </button>
          </div>;
        }}
          empty={tasks.length
            ? empty('Nothing due this week', `${tasks.length} open ${tasks.length === 1 ? 'task is' : 'tasks are'} planned later.`, <button className="text-link" data-nav="tasks">See all tasks</button>)
            : empty('You’re all caught up', 'Add a task to plan your next research step.', <button className="text-link" data-action="new-task">Create a task</button>)}/>)}
      {panel('dashboard-events', 'calendar', 'Next 7 days', loading || error ? undefined : upcoming.length, <button className="text-link" data-nav="calendar">Calendar</button>,
        loading ? <p className="fit-empty" role="status">Loading your agenda…</p> : error ? <div className="fit-empty" role="alert"><div><p>Your agenda could not be loaded.</p><button className="text-link" onClick={() => setRetry(value => value + 1)}>Try again</button></div></div>
        : <FitList label="Event pages" compact items={upcoming} render={event => {
          const day = event.starts_at.slice(0, 10) < today ? today : event.starts_at.slice(0, 10);
          return <button className={`view-row home-event${day === today ? ' is-today' : ''}`} key={event.id} onClick={() => runtime.openCalendarEvent(event.id)}>
            <span className="home-date"><b>{localDate(day).getDate()}</b><small>{localDate(day).toLocaleDateString(undefined, { month: 'short' })}</small></span>
            <span><strong>{event.title}</strong><small>{relativeDay(day, today)} · {event.all_day ? 'All day' : event.starts_at.slice(11, 16)}</small></span>
            <Icon name="chevron" size={13}/>
          </button>;
        }}
          empty={empty('A clear week', 'No events in the next 7 days.', <button className="text-link" data-nav="calendar">Plan in calendar</button>)}/>)}
    </div>
  </ViewPage>;
}
