import { useMemo, useState, type DragEvent } from 'react';
import { useRuntime } from '../../app/runtime';
import { refreshState, toast } from '../../app/navigation';
import { Icon } from '../../components/Icon';
import { api } from '../../services/api';

type Column = { id: number; name: string; color: string; position: number; is_done?: boolean };
type Task = {
  id: number; title: string; status: 'todo' | 'doing' | 'done'; column_id?: number | null; project_id?: number | null;
  priority?: 'low' | 'medium' | 'high'; due_date?: string | null; labels?: string[]; checklist?: { text: string; done: boolean }[]; archived_at?: string | null;
};

const due = (value?: string | null) => value ? new Date(`${value}T00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
const late = (task: Task) => Boolean(task.due_date) && task.status !== 'done' && new Date(`${task.due_date}T23:59`) < new Date();

/** The project's tasks as a board, in the Atelier: drag a card to change its column. */
export function TasksBoard({ projectId, onAgent }: { projectId: number; onAgent: (taskId: number) => void }) {
  const { state } = useRuntime();
  const columns: Column[] = useMemo(() => [...(state.taskColumns || [])].sort((a: Column, b: Column) => a.position - b.position || a.id - b.id), [state.taskColumns]);
  const tasks: Task[] = (state.tasks || []).filter((task: Task) => task.project_id === projectId && !task.archived_at);
  const [moving, setMoving] = useState<number | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const [adding, setAdding] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  // A task without a known column sits in the first column of its status.
  const columnOf = (task: Task) => columns.find(column => column.id === task.column_id)?.id
    ?? (task.status === 'done' ? columns.find(column => column.is_done) : columns[task.status === 'doing' ? 1 : 0])?.id;

  async function move(taskId: number, columnId: number) {
    const task = tasks.find(item => item.id === taskId);
    if (!task || columnOf(task) === columnId) return;
    try {
      await api(`/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify({ column_id: columnId }) });
      await refreshState(['tasks']);
    } catch (reason) { toast((reason as Error).message, 'error'); }
  }
  async function create(columnId: number) {
    const text = title.trim();
    if (!text) { setAdding(null); return; }
    try {
      await api('/tasks', { method: 'POST', body: JSON.stringify({ title: text, project_id: projectId, column_id: columnId }) });
      setTitle('');
      await refreshState(['tasks']);
    } catch (reason) { toast((reason as Error).message, 'error'); }
  }
  // The same side panel as the Tasks page, over the editor.
  async function edit(taskId: number) {
    const { newTaskModal } = await import('../tasks/dialogs');
    newTaskModal(projectId, null, taskId, () => refreshState(['tasks']));
  }
  const drop = (columnId: number) => (event: DragEvent) => {
    event.preventDefault();
    setTarget(null);
    const id = Number(event.dataTransfer.getData('application/x-kavot-atelier-task') || moving);
    setMoving(null);
    if (id) void move(id, columnId);
  };

  if (!columns.length) return <p className="atelier-empty">No board columns yet.</p>;
  return <div className="atelier-board" role="list" aria-label="Tasks of the project">
    {columns.map(column => {
      const cards = tasks.filter(task => columnOf(task) === column.id);
      return <section key={column.id} className={`atelier-board-column ${target === column.id ? 'drop' : ''}`} role="listitem" aria-label={column.name}
        onDragOver={event => { if (moving) { event.preventDefault(); setTarget(column.id); } }} onDragLeave={() => setTarget(value => value === column.id ? null : value)} onDrop={drop(column.id)}>
        <header><i style={{ background: column.color }}/><strong>{column.name}</strong><small>{cards.length}</small>
          <button className="icon-button" aria-label={`Add a task to ${column.name}`} title="Add a task" onClick={() => { setAdding(column.id); setTitle(''); }}><Icon name="plus" size={12}/></button></header>
        <div className="atelier-board-cards">
          {adding === column.id && <form className="atelier-board-new" onSubmit={event => { event.preventDefault(); void create(column.id); }}>
            <input autoFocus value={title} onChange={event => setTitle(event.target.value)} placeholder="Task title" maxLength={240}
              onKeyDown={event => { if (event.key === 'Escape') setAdding(null); }} onBlur={() => { if (!title.trim()) setAdding(null); }}/>
          </form>}
          {cards.map(task => {
            const done = task.checklist?.filter(item => item.done).length || 0, total = task.checklist?.length || 0;
            // The whole card opens the task; pressing and moving it drags it instead (no click follows a drag).
            return <article key={task.id} className={`atelier-card ${moving === task.id ? 'moving' : ''}`} draggable
              role="button" tabIndex={0} aria-label={`Open the task ${task.title}`} title="Click to open · drag to move"
              onClick={() => void edit(task.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void edit(task.id); } }}
              onDragStart={event => { setMoving(task.id); event.dataTransfer.setData('application/x-kavot-atelier-task', String(task.id)); event.dataTransfer.effectAllowed = 'move'; }}
              onDragEnd={() => { setMoving(null); setTarget(null); }}>
              <div className="atelier-card-open">
                <span className={`atelier-priority ${task.priority || 'medium'}`} title={`${task.priority || 'medium'} priority`}/>
                <strong>{task.title}</strong>
              </div>
              {(task.due_date || total > 0 || (task.labels || []).length > 0) && <footer>
                {task.due_date && <span className={late(task) ? 'late' : ''}><Icon name="calendar" size={11}/>{due(task.due_date)}</span>}
                {total > 0 && <span><Icon name="check" size={11}/>{done}/{total}</span>}
                {(task.labels || []).slice(0, 3).map(label => <span key={label} className="atelier-card-label">{label}</span>)}
              </footer>}
              {task.status !== 'done' && <button className="atelier-card-agent" onClick={event => { event.stopPropagation(); onAgent(task.id); }} title="Give this task to an agent" aria-label={`Give “${task.title}” to an agent`}><Icon name="agents" size={12}/></button>}
            </article>;
          })}
          {!cards.length && adding !== column.id && <button className="atelier-board-empty" onClick={() => { setAdding(column.id); setTitle(''); }}>＋ Add a task</button>}
        </div>
      </section>;
    })}
  </div>;
}
