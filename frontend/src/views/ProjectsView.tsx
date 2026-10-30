import { useRuntime } from '../app/runtime';
import { EmptyState } from '../components/common';
import { ViewHeader, ViewPage } from '../components/ViewLayout';
import { WorkspaceTable } from '../components/WorkspaceTable';
export function ProjectsView() {
  const { state } = useRuntime();
  return <ViewPage className="projects-view" label="Projects"><ViewHeader icon="projects" title="Projects" count={state.projects.length} subtitle="Each project starts with an editable note, visible in its canvas."><button className="button button-primary" data-action="new-project">＋ New project</button></ViewHeader>{state.projects.length ? <WorkspaceTable name="Projects" storageKey="projects" rows={state.projects} columns={[
    { id: 'name', label: 'Project', value: (p: Project) => p.name, render: p => <button className="text-link" data-project-area="canvas" data-project-id={p.id}>{p.name}</button> },
    { id: 'status', label: 'Status', value: p => p.status || 'active', render: p => <span className={`status-pill ${p.status}`}>{p.status || 'active'}</span> },
    { id: 'description', label: 'Objectif', value: p => p.description || '—' },
    { id: 'notes', label: 'Notes', value: p => state.notes.filter(n => n.project_id === p.id).length },
    { id: 'papers', label: 'Articles', value: p => state.papers.filter(n => n.projects.some(link => link.id === p.id)).length },
    { id: 'actions', label: 'Actions', value: () => '', render: p => <div className="project-table-actions"><button className="text-link" data-project-area="atelier" data-project-id={p.id}>Atelier</button><button className="text-link" data-action="edit-project" data-project-id={p.id}>Edit</button><a href={`/api/projects/${p.id}/export`} download>Export</a>{p.status === 'archived' ? <button className="text-link" data-action="unarchive-project" data-project-id={p.id}>Restore</button> : <button className="text-link" data-action="archive-project" data-project-id={p.id}>Archive</button>}<button className="text-link" data-action="delete-project" data-project-id={p.id}>Delete</button></div> },
  ]}/> : <EmptyState title="No projects yet" action="new-project" actionLabel="Create the first project">Create a project to start its visual canvas and connect local resources.</EmptyState>}</ViewPage>;
}
