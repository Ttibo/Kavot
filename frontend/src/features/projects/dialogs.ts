import { escapeHtml, state } from '../../app/state';
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

export function newProjectModal() {
  openModal(
    `<header class="modal-header"><h2>New project</h2><p>The project starts with an editable note containing its name and goal.</p></header><div class="modal-body"><form id="project-form" class="form-grid"><div class="form-field full"><label for="project-name">Project name</label><input id="project-name" name="name" required maxlength="120" placeholder="Ex. Systematic review on…"></div><div class="form-field full"><label for="project-description">Objective</label><textarea id="project-description" name="description" placeholder="Research question, scope, and expected result…"></textarea></div><div class="form-field"><label for="project-color">Project color</label><input id="project-color" name="color" type="color" value="#087e86"></div><div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button class="button button-primary">Create project</button></div></form></div>`,
    true,
  );
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
  openModal(
    `<header class="modal-header"><h2>Edit project</h2><p>Update its name, objective, or color.</p></header><div class="modal-body"><form id="project-edit-form" class="form-grid"><div class="form-field full"><label>Project name</label><input name="name" required maxlength="120" value="${escapeHtml(project.name)}"></div><div class="form-field full"><label>Objective</label><textarea name="description">${escapeHtml(project.description || "")}</textarea></div><div class="form-field"><label>Color</label><input name="color" type="color" value="${escapeHtml(project.color)}"></div><div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button class="button button-primary">Save</button></div></form></div>`,
  );
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
        else await navigate("dashboard");
      } catch (error) {
        toast(error.message, "error");
      }
    });
}
