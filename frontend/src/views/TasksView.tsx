import { useState } from 'react';
import { DeleteRecordButton } from '../components/CollectionControls';
import { workspaceColor } from '../styles/palette';
import { useRuntime } from '../app/runtime';
import { publish } from '../app/viewBridge';
import { EmptyState, cssVars } from '../components/common';
import { TaskCard, type Task } from '../features/tasks/TaskCard';
import { dueLabel, taskDigest } from '../features/tasks/text';
import { Icon } from '../components/Icon';
import { FitList, Pagination, useFitPagination, ViewHeader, ViewPage, ViewToolbar } from '../components/ViewLayout';
export function TasksView() {
  const { state, labels } = useRuntime();
  const [query, setQuery] = useState('');
  const [priority, setPriority] = useState('all');
  const tasks: Task[] = state.tasks.filter((task: Task) => (state.taskProjectFilter === 'all' || (state.taskProjectFilter === 'none' ? !task.project_id : task.project_id === Number(state.taskProjectFilter))) && (priority === 'all' || task.priority === priority) && [task.title, task.description, ...(task.labels || [])].join(' ').toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const project = state.projects.find((item: Project) => item.id === Number(state.taskProjectFilter));
  const resetKey = `${query}|${priority}|${state.taskProjectFilter}`;
  return <ViewPage className="tasks-view" label="Tasks">
    <ViewHeader icon="tasks" title={project ? `${project.name} · Tasks` : 'All tasks'} count={tasks.length}>
      <div className="view-switch" role="group" aria-label="Task view">{['kanban', 'list'].map(view => <button key={view} className={state.taskView === view ? 'active' : ''} aria-pressed={state.taskView === view} onClick={() => { state.taskView = view; localStorage.setItem('kavot-task-view', view); publish(); }}>{view === 'kanban' ? 'Kanban' : 'List'}</button>)}</div>
      <button className="button" data-action="task-archives"><Icon name="archive" size={14}/>Archives</button>
      <button className="button" data-action="new-column"><Icon name="plus" size={14}/>Column</button>
      <button className="button button-primary" data-action="new-task" data-project-id={project?.id}><Icon name="plus" size={14}/>New task</button>
    </ViewHeader>
    <ViewToolbar><input type="search" aria-label="Search tasks" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search title, description, tag…"/><label>Project <select aria-label="Filter by project" value={state.taskProjectFilter} onChange={event => { state.taskProjectFilter = event.target.value; publish(); }}><option value="all">All projects</option><option value="none">No project</option>{state.projects.map((project: Project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label>Priority <select value={priority} onChange={event => setPriority(event.target.value)}><option value="all">All priorities</option>{['low', 'medium', 'high'].map(value => <option key={value} value={value}>{labels[value]}</option>)}</select></label>{(query || priority !== 'all' || state.taskProjectFilter !== 'all') && <button className="text-link" onClick={() => { setQuery(''); setPriority('all'); state.taskProjectFilter = 'all'; publish(); }}>Reset filters</button>}</ViewToolbar>
    {state.taskView === 'kanban' ? <section className="view-body kanban" id="kanban">{state.taskColumns.map((column: any) => { const items = tasks.filter(task => task.column_id === column.id); return <div key={column.id} className="kanban-column" style={cssVars({ '--column-accent': column.color })} data-column-id={column.id} data-drop-column={column.id}><div className="kanban-head"><span className="column-drag-handle" draggable data-column-drag={column.id} title="Drag to move column"><b>⠿</b><i/>{column.name}</span><div><span className="count-badge">{items.length}</span><button className="column-menu" data-action="edit-column" data-column-id={column.id} title="Configure column">•••</button></div></div><FitList compact label={`${column.name} pages`} listClassName="task-stack" items={items} resetKey={resetKey} render={task => <TaskCard key={task.id} task={task}/>} empty={<div className="kanban-empty">Drop a card here</div>}/><button className="kanban-add" data-action="new-task" data-column-id={column.id} data-project-id={project?.id}>＋ Add card</button></div>; })}</section>
    : tasks.length ? <TaskTable tasks={tasks} resetKey={resetKey}/>
    : <div className="view-body"><EmptyState title="No tasks" action="new-task" actionLabel="New task">Create a task in this scope to see it here.</EmptyState></div>}
  </ViewPage>;
}

function TaskTable({ tasks, resetKey }: { tasks: Task[]; resetKey: string }) {
  const { state, labels, formatDate, truncate } = useRuntime();
  const fit = useFitPagination(tasks, { resetKey });
  return <div className="view-body fit-list">
    <div className="fit-body" ref={fit.ref}><div className="view-table-wrap"><table className="view-table" aria-label="Task list"><thead><tr><th scope="col">Task</th><th scope="col">Status</th><th scope="col">Project</th><th scope="col">Due date</th><th scope="col">Priority</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
      <tbody data-fit-list>{fit.pageItems.map(task => <tr key={task.id} className="task-list-row" draggable data-task-id={task.id}><td><div className="task-list-title"><strong>{task.title}</strong>{taskDigest(task.description).summary && <small>{truncate(taskDigest(task.description).summary, 110)}</small>}</div></td><td><select data-task-column-set={task.id} aria-label={`Status for ${task.title}`} defaultValue={task.column_id} key={`${task.id}-${task.column_id}`}>{state.taskColumns.map((column: any) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></td><td><span className="task-list-project"><i className="project-dot" style={{ background: workspaceColor(task.project_color || '#8c8c85') }}/>{task.project_name || 'General'}</span></td><td className={`task-list-due ${dueLabel(task.due_date, formatDate)?.tone || ''}`}>{dueLabel(task.due_date, formatDate)?.text || '—'}</td><td><span className={`priority-pill ${task.priority}`}>{labels[task.priority]}</span></td><td><div className="collection-record-actions"><DeleteRecordButton endpoint={'/tasks/' + task.id} title={task.title}/><button className="button button-small task-list-edit" data-action="edit-task" data-task-id={task.id}>Edit</button></div></td></tr>)}</tbody></table></div></div>
    <Pagination label="Task pages" page={fit.page} pages={fit.pages} total={fit.total} from={fit.from} to={fit.to} onPage={fit.setPage}/>
  </div>;
}

