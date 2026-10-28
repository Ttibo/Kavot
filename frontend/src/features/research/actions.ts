import { escapeHtml, state } from '../../app/state';
import { refreshData, render, toast } from '../../app/navigation';
import { closeModal } from '../../components/dialogs/controller';
import { collectionField, collectionInput, openCollectionComposer } from '../../components/dialogs/collectionComposer';
import { api } from '../../services/api';
import { showView } from '../../app/viewBridge';

export const conferenceStatusLabels = {
  watching: "Watching",
  planned: "Planned",
  submitted: "Submitted",
  accepted: "Accepted",
  rejected: "Rejected",
  archived: "Archived",
};

export const datasetStatusLabels = {
  available: "Available",
  requested: "Requested",
  restricted: "Restricted access",
  archived: "Archived",
};

function registryProject(filter = state.view === "datasets" ? state.datasetProjectFilter : state.conferenceProjectFilter) {
  if (filter === "all") return null;
  return state.projects.find(
    (item) => item.id === Number(filter),
  );
}

function relationCheckboxes(items, selectedIds, name, emptyLabel) {
  if (!items.length) return `<p class="relation-empty">${escapeHtml(emptyLabel)}</p>`;
  return items
    .map(
      (item) =>
        `<label class="relation-check"><input type="checkbox" name="${name}" value="${item.id}" ${selectedIds.includes(item.id) ? "checked" : ""}><span>${escapeHtml(item.acronym || item.name)}</span></label>`,
    )
    .join("");
}

function renderRegistryReturnView() {
  if (state.view === "conferences") return renderConferences();
  if (state.view === "datasets") return renderDatasets();
  return render();
}

function deadlineRow(deadline: {kind?: string; label?: string; due_at?: string} = {}) {
  return `<div class="deadline-form-row"><select name="deadline_kind" aria-label="Deadline type"><option value="abstract" ${deadline.kind === "abstract" ? "selected" : ""}>Abstract</option><option value="submission" ${!deadline.kind || deadline.kind === "submission" ? "selected" : ""}>Submission</option><option value="notification" ${deadline.kind === "notification" ? "selected" : ""}>Notification</option><option value="camera_ready" ${deadline.kind === "camera_ready" ? "selected" : ""}>Camera-ready</option><option value="workshop" ${deadline.kind === "workshop" ? "selected" : ""}>Workshop</option><option value="other" ${deadline.kind === "other" ? "selected" : ""}>Other</option></select><input name="deadline_label" aria-label="Deadline label" maxlength="160" required value="${escapeHtml(deadline.label || "")}" placeholder="Label"><input name="deadline_due_at" aria-label="Deadline date and time" type="datetime-local" required value="${escapeHtml(String(deadline.due_at || "").slice(0, 16))}"><button type="button" class="icon-button remove-deadline" aria-label="Remove deadline">×</button></div>`;
}

export function conferenceModal(conferenceId = null, options: { record?: any; projectId?: number; onSaved?: (record: any) => void | Promise<void> } = {}) {
  const conference = options.record || state.conferences.find((item) => item.id === Number(conferenceId));
  const selectedProject = options.projectId !== undefined ? state.projects.find(project => project.id === options.projectId) : registryProject();
  const projectIds = conference?.project_ids || (selectedProject ? [selectedProject.id] : []);
  const field = (name: string, label: string, control: string, help = '') => collectionField('conference', name, label, control, help);
  openCollectionComposer({
    id: 'conference-form', title: conference ? 'Edit conference' : 'New conference', eyebrow: 'Research watch',
    description: 'Plan your participation and keep every deadline in sight.',
    main: `<div class="collection-title-field">${field('name', 'Conference name <span>Required</span>', collectionInput(conference?.name || '', 'required maxlength="240" placeholder="Which conference are you following?"'))}</div>
      <div class="collection-field-pair">${field('acronym', 'Acronym', collectionInput(conference?.acronym || '', 'maxlength="40" placeholder="e.g. NeurIPS"'))}${field('edition', 'Edition', collectionInput(conference?.edition || '', 'maxlength="80" placeholder="e.g. 2027"'))}</div>
      <section class="collection-deadlines" aria-labelledby="conference-deadlines-heading"><div class="collection-section-heading"><div><h3 id="conference-deadlines-heading">Deadlines</h3><p>Automatically added to your calendar.</p></div><button type="button" class="button button-small" id="add-deadline">＋ Add deadline</button></div><div id="deadline-rows">${(conference?.deadlines || []).map(deadlineRow).join('')}</div><p class="deadline-empty-hint">Add a submission, notification or other key date.</p></section>
      <div class="collection-writing-field">${field('notes', 'Research notes <span>Optional</span>', `<textarea maxlength="10000" placeholder="Topics, submission requirements, ideas for your contribution…">${escapeHtml(conference?.notes || '')}</textarea>`)}</div>`,
    details: `<div class="collection-section-heading"><div><h3>Participation</h3><p>When, where and how you take part.</p></div></div>
      ${field('status', 'Status', `<select>${Object.entries(conferenceStatusLabels).map(([value, label]) => `<option value="${value}" ${conference?.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select>`)}
      <div class="collection-field-pair">${field('starts_at', 'Start date', collectionInput(conference?.starts_at || '', 'type="date"'))}${field('ends_at', 'End date', collectionInput(conference?.ends_at || '', 'type="date"'))}</div>
      ${field('location', 'Location', collectionInput(conference?.location || '', 'maxlength="240" placeholder="City, venue or online"'))}
      ${field('url', 'Website', collectionInput(conference?.url || '', 'type="url" maxlength="1000" placeholder="https://…"'))}
      <fieldset class="registry-fieldset"><legend>Related projects</legend><div class="relation-options">${relationCheckboxes(state.projects, projectIds, 'project_ids', 'No projects yet.')}</div></fieldset>
      <fieldset class="registry-fieldset"><legend>Related datasets</legend><div class="relation-options">${relationCheckboxes(state.datasets, conference?.dataset_ids || [], 'dataset_ids', 'No datasets yet.')}</div></fieldset>`,
    actions: `${conference ? '<button type="button" class="button button-danger collection-delete" id="delete-conference">Delete conference</button>' : '<span class="collection-footer-hint">Only the name is required.</span>'}<button type="button" class="button" id="cancel-conference">Cancel</button><button type="submit" class="button button-primary">${conference ? 'Save changes' : 'Create conference'}</button>`,
  });
  const rows = document.querySelector("#deadline-rows");
  document.querySelector("#add-deadline").addEventListener("click", () => {
    rows.insertAdjacentHTML("beforeend", deadlineRow());
    rows.lastElementChild.querySelector("input")?.focus();
  });
  rows.addEventListener("click", (event) => (event.target as HTMLElement).closest(".remove-deadline")?.closest(".deadline-form-row")?.remove());
  document.querySelector("#cancel-conference").addEventListener("click", closeModal);
  document.querySelector("#delete-conference")?.addEventListener("click", async () => {
    if (!confirm("Delete this conference and all its deadlines?")) return;
    await api(`/conferences/${conference.id}`, { method: "DELETE" });
    closeModal();
    await refreshData();
    renderRegistryReturnView();
    toast("Conference deleted");
  });
  document.querySelector("#conference-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData((event.target as HTMLFormElement));
    const deadlines = [...(event.target as HTMLElement).querySelectorAll(".deadline-form-row")].map((row) => ({
      kind: (row.querySelector("[name='deadline_kind']") as HTMLInputElement).value,
      label: (row.querySelector("[name='deadline_label']") as HTMLInputElement).value,
      due_at: (row.querySelector("[name='deadline_due_at']") as HTMLInputElement).value,
      timezone: "Europe/Paris",
      notes: "",
    }));
    const payload = { name: form.get("name"), acronym: form.get("acronym"), edition: form.get("edition"), status: form.get("status"), starts_at: form.get("starts_at") || null, ends_at: form.get("ends_at") || null, location: form.get("location"), url: form.get("url"), notes: form.get("notes"), project_ids: form.getAll("project_ids").map(Number), dataset_ids: form.getAll("dataset_ids").map(Number), deadlines };
    try {
      const saved = await api(conference ? `/conferences/${conference.id}` : "/conferences", { method: conference ? "PATCH" : "POST", body: JSON.stringify(payload) });
      closeModal();
      await refreshData();
      if (options.onSaved) await options.onSaved(saved);
      else renderRegistryReturnView();
      toast(conference ? "Conference updated" : "Conference added");
    } catch (error) { toast(error.message, "error"); }
  });
}

export function renderConferences() { showView("conferences"); }

export function renderDatasets() { showView("datasets"); }

export function datasetModal(datasetId = null, options: { record?: any; projectId?: number; onSaved?: (record: any) => void | Promise<void> } = {}) {
  const dataset = options.record || state.datasets.find((item) => item.id === Number(datasetId));
  const selectedProject = options.projectId !== undefined ? state.projects.find(project => project.id === options.projectId) : registryProject();
  const projectIds = dataset?.project_ids || (selectedProject ? [selectedProject.id] : []);
  const field = (name: string, label: string, control: string, help = '') => collectionField('dataset', name, label, control, help);
  openCollectionComposer({
    id: 'dataset-form', title: dataset ? 'Edit dataset' : 'New dataset', eyebrow: 'Research data',
    description: 'Document your data and connect it to your research.',
    main: `<div class="collection-title-field">${field('name', 'Dataset name <span>Required</span>', collectionInput(dataset?.name || '', 'required maxlength="240" placeholder="Give your dataset a name"'))}</div>
      <div class="collection-writing-field">${field('description', 'Description <span>Optional</span>', `<textarea maxlength="10000" placeholder="What does this dataset contain? Describe its source, scope and intended use…">${escapeHtml(dataset?.description || '')}</textarea>`)}</div>
      <div class="collection-writing-field collection-writing-secondary">${field('notes', 'Usage notes <span>Optional</span>', `<textarea maxlength="10000" placeholder="Preprocessing, limitations, citation guidelines or next steps…">${escapeHtml(dataset?.notes || '')}</textarea>`)}</div>`,
    details: `<div class="collection-section-heading"><div><h3>Access & provenance</h3><p>Make this data easy to find and reuse.</p></div></div>
      ${field('access_status', 'Access status', `<select>${Object.entries(datasetStatusLabels).map(([value, label]) => `<option value="${value}" ${dataset?.access_status === value ? 'selected' : ''}>${label}</option>`).join('')}</select>`)}
      <div class="collection-field-pair">${field('version', 'Version', collectionInput(dataset?.version || '', 'maxlength="120" placeholder="e.g. 1.0"'))}${field('license', 'Licence', collectionInput(dataset?.license || '', 'maxlength="120" placeholder="e.g. CC BY 4.0"'))}</div>
      ${field('url', 'Source URL', collectionInput(dataset?.url || '', 'type="url" maxlength="1000" placeholder="https://…"'))}
      ${field('local_path', 'Local path', collectionInput(dataset?.local_path || '', 'maxlength="1000" placeholder="/path/to/dataset"'), 'Reference a file or folder on this device.')}
      <fieldset class="registry-fieldset"><legend>Related projects</legend><div class="relation-options">${relationCheckboxes(state.projects, projectIds, 'project_ids', 'No projects yet.')}</div></fieldset>
      <fieldset class="registry-fieldset"><legend>Related conferences</legend><div class="relation-options">${relationCheckboxes(state.conferences, dataset?.conference_ids || [], 'conference_ids', 'No conferences yet.')}</div></fieldset>`,
    actions: `${dataset ? '<button type="button" class="button button-danger collection-delete" id="delete-dataset">Delete dataset</button>' : '<span class="collection-footer-hint">Only the name is required.</span>'}<button type="button" class="button" id="cancel-dataset">Cancel</button><button type="submit" class="button button-primary">${dataset ? 'Save changes' : 'Create dataset'}</button>`,
  });
  document.querySelector("#cancel-dataset").addEventListener("click", closeModal);
  document.querySelector("#delete-dataset")?.addEventListener("click", async () => {
    if (!confirm("Delete this dataset?")) return;
    await api(`/datasets/${dataset.id}`, { method: "DELETE" });
    closeModal();
    await refreshData();
    renderRegistryReturnView();
    toast("Dataset deleted");
  });
  document.querySelector("#dataset-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData((event.target as HTMLFormElement));
    const payload = { name: form.get("name"), version: form.get("version"), license: form.get("license"), access_status: form.get("access_status"), url: form.get("url"), local_path: form.get("local_path"), description: form.get("description"), notes: form.get("notes"), project_ids: form.getAll("project_ids").map(Number), conference_ids: form.getAll("conference_ids").map(Number) };
    try {
      const saved = await api(dataset ? `/datasets/${dataset.id}` : "/datasets", { method: dataset ? "PATCH" : "POST", body: JSON.stringify(payload) });
      closeModal();
      await refreshData();
      if (options.onSaved) await options.onSaved(saved);
      else renderRegistryReturnView();
      toast(dataset ? "Dataset updated" : "Dataset added");
    } catch (error) { toast(error.message, "error"); }
  });
}
