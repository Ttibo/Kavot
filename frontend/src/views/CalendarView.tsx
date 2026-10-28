import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRuntime } from '../app/runtime';
import { publish, viewVersion } from '../app/viewBridge';
import { api } from '../services/api';
import { EmptyState, Loading, cssVars } from '../components/common';
import { Icon } from '../components/Icon';
import { ViewHeader, ViewPage, ViewToolbar } from '../components/ViewLayout';
interface CalendarEvent { id: string | number; source: string; title: string; starts_at: string; ends_at?: string; all_day: boolean; color?: string; }
export function CalendarView() {
  const runtime = useRuntime(); const { state } = runtime;
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const cursor = state.calendarCursor;
  const month = cursor.getTime(); const project = state.calendarProjectFilter;
  const version = viewVersion('calendar');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    const params = new URLSearchParams(runtime.calendarMonthRange(new Date(month)));
    if (project !== 'all') params.set('project_id', project);
    api<CalendarEvent[]>(`/calendar/events?${params}`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      state.calendarEvents = result; setEvents(result); setLoading(false);
    }).catch(reason => { if (!controller.signal.aborted) { setError(reason.message); setLoading(false); } });
    return () => controller.abort();
  }, [month, project, version, runtime, state]);
  // Each day shows as many events as its cell can hold; the rest goes behind “+N more”.
  const grid = useRef<HTMLDivElement>(null);
  const [perDay, setPerDay] = useState(3);
  useLayoutEffect(() => {
    const element = grid.current;
    if (!element) return;
    const measure = () => {
      const box = element.querySelector<HTMLElement>('.calendar-day-events');
      if (!box) return;
      const sample = element.querySelector<HTMLElement>('.calendar-event');
      const pitch = (sample?.offsetHeight || 18) + 3;
      setPerDay(Math.max(1, Math.floor((box.clientHeight + 3) / pitch)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [loading, error]);
  const move = (offset: number) => { state.calendarCursor = new Date(cursor.getFullYear(), cursor.getMonth() + offset, 1); publish(); };
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = new Date(first); start.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  const today = runtime.calendarLocalDateKey(new Date());
  return <ViewPage className="calendar-view" label="Calendar">
    <ViewHeader icon="calendar" title={new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(cursor)} count={events.length} subtitle="Research planning · local calendar">
      <button className="view-page-button" aria-label="Previous month" onClick={() => move(-1)}><Icon name="back" size={13}/></button><button className="button" onClick={() => { state.calendarCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1); publish(); }}>Today</button><button className="view-page-button" aria-label="Next month" onClick={() => move(1)}><Icon name="chevron" size={13}/></button>
      <a className="button" href={`/api/calendar/export.ics${project === 'all' ? '' : `?project_id=${project}`}`} download>Export ICS</a><button className="button button-primary" onClick={() => runtime.calendarEventModal()}><Icon name="plus" size={14}/>Event</button>
    </ViewHeader>
    <ViewToolbar><label>Project <select aria-label="Filter by project" value={state.calendarProjectFilter} onChange={event => { state.calendarProjectFilter = event.target.value; publish(); }}><option value="all">All projects</option>{state.projects.map((project: Project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label>Source <select value={state.calendarSourceFilter} onChange={event => { state.calendarSourceFilter = event.target.value; publish(); }}><option value="all">All sources</option>{Object.entries(runtime.calendarSourceLabels).map(([value, label]) => <option key={value} value={value}>{String(label)}</option>)}</select></label><div className="calendar-legend"><span className="tasks">Tasks</span><span className="deadlines">Deadlines</span><span>Events</span></div></ViewToolbar>
  {loading ? <div className="view-body"><Loading>Preparing calendar…</Loading></div> : error ? <div className="view-body"><EmptyState icon="!" title="Calendar unavailable">{error}</EmptyState></div> : <section className="view-body calendar-shell"><div className="calendar-weekdays">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => <span key={day}>{day}</span>)}</div><div className="calendar-grid" ref={grid}>{Array.from({ length: 42 }, (_, index) => { const day = new Date(start); day.setDate(start.getDate() + index); const key = runtime.calendarLocalDateKey(day); const items = events.filter(event => runtime.calendarEventOccursOn(event, key) && (state.calendarSourceFilter === 'all' || event.source === state.calendarSourceFilter)); return <article key={key} data-calendar-day={key} className={`calendar-day ${day.getMonth() !== cursor.getMonth() ? 'outside' : ''} ${key === today ? 'today' : ''}`} onDoubleClick={event => { if (!(event.target as HTMLElement).closest('button')) runtime.calendarEventModal(null, key); }}><header><span>{day.getDate()}</span>{key === today && <small>Today</small>}</header><div className="calendar-day-events">{items.slice(0, items.length > perDay ? perDay - 1 : perDay).map(event => <button key={event.id} className={`calendar-event source-${event.source}`} style={cssVars({ '--event-color': event.color || '#087e86' })} title={event.title} onClick={() => runtime.openCalendarEvent(event.id)}><i/><span>{event.title}</span>{!event.all_day && <time>{event.starts_at.slice(11, 16)}</time>}</button>)}{items.length > perDay && <button className="calendar-more" onClick={() => runtime.calendarDayAgenda(key)}>+{items.length - perDay + 1} more</button>}</div></article>; })}</div></section>}
  </ViewPage>;
}
