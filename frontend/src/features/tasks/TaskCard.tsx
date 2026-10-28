import { DeleteRecordButton } from '../../components/CollectionControls';
import { workspaceColor } from '../../styles/palette';
import { getPalette } from '../../app/colors';
import { useRuntime } from '../../app/runtime';
import { cssVars } from '../../components/common';
import { Icon } from '../../components/Icon';
import { dueLabel, taskDigest } from './text';
export interface Task {
  id: number; title: string; description: string; column_id: number; status: string; priority: string;
  project_id: number | null; project_name?: string; project_color?: string; labels?: string[];
  checklist?: { done: boolean }[]; start_date?: string; due_date?: string; updated_at?: string;
}
export function TaskCard({ task }: { task: Task }) {
  const { formatDate, labels, truncate, state } = useRuntime();
  const digest = taskDigest(task.description, task.checklist);
  const palette = getPalette();
  const finished = !!state.taskColumns.find((column: { id: number; is_done?: boolean }) => column.id === task.column_id)?.is_done;
  const due = finished ? null : dueLabel(task.due_date, formatDate);
  return <article className={`task-card ${task.project_id ? 'project-task' : 'global-task'} ${finished ? 'is-done' : ''} ${due ? 'due-' + due.tone : ''}`} draggable data-task-id={task.id} data-action="edit-task" role="button" tabIndex={0} aria-label={`Edit task ${task.title}`}>
    {!!task.labels?.length && <div className="trello-labels">{task.labels.slice(0, 5).map((label, index) => <span key={`${label}-${index}`} style={cssVars({ '--label-color': palette[index % palette.length] })}>{label}</span>)}</div>}
    <h3 className="task-card-title">{finished && <span className="task-done-mark" aria-label="Done">✓</span>}{task.title}</h3>
    {digest.summary && <p className="task-description">{truncate(digest.summary, 140)}</p>}
    {(due || task.start_date || digest.total > 0 || digest.links > 0) && <div className="task-meta-row">
      {due ? <span className={`task-due ${due.tone}`}>◷ {due.text}</span> : task.start_date && !finished && <span>▶ {formatDate(task.start_date)}</span>}
      {digest.total > 0 && <span className="task-steps" title={`${digest.done} of ${digest.total} steps done`}><span className="task-steps-bar"><i style={{ width: `${(digest.done / digest.total) * 100}%` }}/></span>{digest.done}/{digest.total}</span>}
      {digest.links > 0 && <span className="task-links-count" title={`${digest.links} linked document${digest.links > 1 ? 's' : ''}`}><Icon name="link" size={11}/>{digest.links}</span>}
    </div>}
    <div className="task-card-bottom"><span className={`priority-pill ${task.priority}`}>{labels[task.priority]}</span><span className="task-project"><i className="project-dot" style={{ background: workspaceColor(task.project_color || '#8c8c85') }}/>{task.project_name || 'No project'}</span></div>
    <DeleteRecordButton endpoint={'/tasks/' + task.id} title={task.title}/>
  </article>;
}
