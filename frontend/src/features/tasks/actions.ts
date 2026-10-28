import { showView } from '../../app/viewBridge';

export async function renderTaskContext() {
  renderTasks();
}

export function renderTasks() { showView("tasks"); }
