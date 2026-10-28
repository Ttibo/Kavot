import { useRuntime } from '../app/runtime';
import { ProjectTrashSettings } from './ProjectTrashSettings';

export function ProjectArchiveSettings() {
  const { state } = useRuntime();
  const archived = state.projects.filter((project: Project) => project.status === 'archived');
  return <>
    <article className="settings-card"><h3>Archived projects</h3><p>Archived projects are hidden from the workspace and the dashboard. Their notes, tasks and files are kept.</p>
      {archived.length ? <ul className="settings-archive-list">{archived.map((project: Project) => <li key={project.id}>
        <span><i className="template-color-dot" style={{ background: project.color }}/><strong>{project.name}</strong>{project.updated_at && <small>{' · archived '}{new Date(project.updated_at).toLocaleDateString('en-US')}</small>}</span>
        <span className="form-actions"><a className="button button-small" href={`/api/projects/${project.id}/export`} download>Export</a><button className="button button-small" data-action="unarchive-project" data-project-id={project.id}>Restore</button><button className="button button-small danger" data-action="delete-project" data-project-id={project.id}>Delete</button></span>
      </li>)}</ul> : <p>No archived projects.</p>}
    </article>
    <article className="settings-card"><h3>Archived tasks</h3><p>Search, restore or permanently delete archived task cards.</p><button className="button" data-action="task-archives">Open task archive</button></article>
    <ProjectTrashSettings/>
  </>;
}
