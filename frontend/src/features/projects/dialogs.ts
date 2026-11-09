import { escapeHtml, modal, state } from '../../app/state';
import { closeModal, openModal } from '../../components/dialogs/controller';
import { api } from '../../services/api';
import { navigate, refreshData, render, toast } from '../../app/navigation';
import { openProjectArea } from './navigation';

const resourceTypeLabels = {
  url: 'Web link',
  github: 'GitHub repository',
  overleaf: 'Overleaf project',
  local_path: 'Local code folder',
};

export function addProjectResourceModal(projectId) {
  const project = state.projects.find((item) => item.id === Number(projectId)) || state.selectedProject;
  if (!project) return;
  const nativePickerAvailable = Boolean(window.pywebview?.api?.pick_project_resource_folder);
  openModal(
    `<header class="modal-header"><h2>Link a resource</h2><p>Keep the research project connected to its source material, repository, or local code folder.</p></header><div class="modal-body"><form id="project-resource-form" class="form-grid"><div class="form-field"><label for="project-resource-type">Resource type</label><select id="project-resource-type" name="resource_type">${Object.entries(resourceTypeLabels).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></div><div class="form-field"><label for="project-resource-title">Label <small>(optional)</small></label><input id="project-resource-title" name="title" maxlength="240" placeholder="Ex. Writing workspace"></div><div class="form-field full"><div class="field-heading"><label for="project-resource-target">Address or folder path</label>${nativePickerAvailable ? '<button type="button" class="text-link" id="pick-project-resource-folder">Choose folder</button>' : ''}</div><input id="project-resource-target" name="target" required maxlength="2000" placeholder="https://…"><small class="form-help" id="project-resource-help">Paste a link to a website, a GitHub repository, or an Overleaf project.</small></div><div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button class="button button-primary">Link resource</button></div></form></div>`,
  );
  const form = document.querySelector<HTMLFormElement>('#project-resource-form');
  const typeField = form?.querySelector<HTMLSelectElement>('[name="resource_type"]');
  const targetField = form?.querySelector<HTMLInputElement>('[name="target"]');
  const help = document.querySelector('#project-resource-help');
  const syncType = () => {
    const local = typeField?.value === 'local_path';
    if (targetField) targetField.placeholder = local ? '/Users/you/Code/my-project' : 'https://…';
    if (help) help.textContent = local ? 'Use an absolute path to a folder on this computer.' : 'Paste a link to a website, a GitHub repository, or an Overleaf project.';
  };
  typeField?.addEventListener('change', syncType);
  document.querySelector('#pick-project-resource-folder')?.addEventListener('click', async () => {
    const selected = await window.pywebview?.api?.pick_project_resource_folder?.();
    if (!selected || !targetField || !typeField) return;
    typeField.value = 'local_path';
    targetField.value = selected;
    syncType();
  });
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api(`/projects/${project.id}/external-resources`, {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      closeModal();
      await refreshData();
      state.selectedProject = state.projects.find((item) => item.id === project.id) || project;
      render();
      toast('Resource linked to project');
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

function projectFormMarkup(id, title, submitLabel, project = null) {
  const name = project ? escapeHtml(project.name) : '';
  const description = project ? escapeHtml(project.description || '') : '';
  const color = project ? escapeHtml(project.color) : '#087e86';
  return `<header class="modal-header"><h2>${title}</h2></header><div class="modal-body"><form id="${id}" class="project-form-compact"><div class="project-form-name"><input name="color" type="color" value="${color}" aria-label="Project color" title="Project color"><input name="name" required maxlength="120" value="${name}" placeholder="Project name" aria-label="Project name" autofocus></div><textarea name="description" rows="3" placeholder="Objective — research question, scope, expected result (optional)" aria-label="Objective">${description}</textarea><div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button class="button button-primary">${submitLabel}</button></div></form></div>`;
}

function openProjectFormModal(markup) {
  openModal(markup);
  modal.classList.add('modal-compact');
}

export function newProjectModal() {
  openProjectFormModal(projectFormMarkup('project-form', 'New project', 'Create project'));
  document
    .querySelector("#project-form")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData((event.target as HTMLFormElement));
      const payload = {
        name: form.get("name"),
        description: form.get("description"),
        color: form.get("color"),
      };
      try {
        const created = await api("/projects", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        closeModal();
        await refreshData();
        await openProjectArea(created.id, "canvas");
        toast("Project created");
      } catch (error) {
        toast(error.message, "error");
      }
    });
}

export function editProjectModal(projectId) {
  const project =
    state.projects.find((item) => item.id === Number(projectId)) ||
    state.selectedProject;
  if (!project) return;
  const returnToCanvas = state.primaryResource?.path === project.canvas_path;
  openProjectFormModal(projectFormMarkup('project-edit-form', 'Edit project', 'Save', project));
  document
    .querySelector("#project-edit-form")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await api(`/projects/${project.id}`, {
          method: "PATCH",
          body: JSON.stringify(Object.fromEntries(new FormData((event.target as HTMLFormElement)))),
        });
        closeModal();
        await refreshData();
        toast("Project updated");
        if (returnToCanvas) await openProjectArea(project.id, "canvas");
        else await navigate("notes");
      } catch (error) {
        toast(error.message, "error");
      }
    });
}
