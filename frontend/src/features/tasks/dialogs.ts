import { viewShown, escapeHtml, formatDate, labels, modal, state } from '../../app/state';
import { bindMarkdownBlockEditor, currentMarkdownBlockInput, markdownBlockEditorMarkup } from '../documents/markdown';
import { closeModal, openModal, projectOptions } from '../../components/dialogs/controller';
import { openSheet, type SheetHandle } from '../sheet/sheet';
import { api } from '../../services/api';
import { refreshData, toast } from '../../app/navigation';
import { renderDashboard } from '../../app/viewActions';
import { renderTaskContext } from './actions';
import { relativeTime } from './text';
import '../../styles/features/task-sheet.css';

let newTaskCount = 0;

/** Opens a task (or a new one) in the side panel, next to the page. */
export function newTaskModal(projectId = null, columnId = null, taskId = null, onSaved: ((record: any) => void | Promise<void>) | null = null) {
  const task = taskId ? state.tasks.find((item) => item.id === Number(taskId)) : null;
  void openSheet({
    key: task ? `task:${task.id}` : `task:new:${++newTaskCount}`,
    title: task ? "Task" : "New task",
    label: task ? "Task editor" : "New task editor",
    mount: (body, sheet) => mountTaskEditor(body, sheet, { task, projectId, columnId, onSaved }),
    // The task as a full page, in the item editor of its collection.
    openInTab: task ? async (pane) => {
      const { openCollectionInNotes } = await import('../collections/noteEditor');
      await openCollectionInNotes({ type: 'task', id: task.id, databaseId: 'tasks' }, { newTab: true, pane });
    } : undefined,
  });
}

function mountTaskEditor(body: HTMLElement, sheet: { close: (force?: boolean) => Promise<boolean> }, { task, projectId, columnId, onSaved }: {
  task: any; projectId: number | null; columnId: number | null; onSaved: ((record: any) => void | Promise<void>) | null;
}): SheetHandle {
  const selectedProject = task
    ? task.project_id
    : (projectId ??
      (state.taskProjectFilter !== "all" && state.taskProjectFilter !== "none"
        ? Number(state.taskProjectFilter)
        : null));
  const selectedColumn =
    task?.column_id || Number(columnId) || state.taskColumns[0]?.id;
  const checklistMarkdown = (task?.checklist || [])
    .map((item) => `- [${item.done ? "x" : " "}] ${item.text}`)
    .join("\n");
  const description = task?.description?.trim()
    ? `${task.description}${checklistMarkdown ? `\n\n## To do\n\n${checklistMarkdown}` : ""}`
    : checklistMarkdown
      ? `## To do\n\n${checklistMarkdown}`
      : "";
  const today = isoDay(0);
  const startDate = task ? task.start_date || "" : today;
  const descriptionEditor = markdownBlockEditorMarkup(description, {
    sourceId: "task-description-source",
    editorId: "task-description-editor",
    sourceClass: "task-description-source",
    ariaLabel: "Task description",
  });
  const project = state.projects.find((item) => item.id === selectedProject);
  const knownTags = [...new Set(state.tasks.flatMap((item) => item.labels || []))].sort();
  const dateField = (name: string, label: string, value: string, optional: boolean) => `<div class="task-sheet-field">
      <label for="task-${name}">${label}${optional ? " <span>Optional</span>" : ""}</label>
      <input id="task-${name}" type="date" name="${name}" value="${escapeHtml(value)}">
      <div class="task-date-quick" role="group" aria-label="${label} shortcuts">
        ${[[0, "Today"], [1, "Tomorrow"], [7, "In a week"]].map(([offset, text]) => `<button type="button" data-date-set="${name}" data-date-offset="${offset}">${text}</button>`).join("")}
        <button type="button" data-date-set="${name}" data-date-offset="clear" aria-label="Clear ${label.toLowerCase()}">Clear</button>
      </div>
    </div>`;
  body.innerHTML = `<form id="task-form" class="task-sheet in-panel" autocomplete="off" novalidate>
      <header class="task-sheet-header">
        <p class="task-sheet-meta"><span>${task ? "Task" : "New task"}</span>${project ? `<span><i class="project-dot" style="background:${escapeHtml(project.color || "#8c8c85")}"></i>${escapeHtml(project.name)}</span>` : ""}${task?.updated_at ? `<span>Updated ${escapeHtml(relativeTime(task.updated_at))}</span>` : ""}</p>
        <label class="sr-only" for="task-title">Task name</label>
        <textarea id="task-title" class="task-sheet-title" name="title" required maxlength="240" rows="1" autofocus placeholder="What needs to get done?">${escapeHtml(task?.title || "")}</textarea>
      </header>
      <div class="task-sheet-body">
        <section class="task-sheet-main" aria-label="Description">
          <div class="task-sheet-section-head">
            <strong>Description</strong>
            <span class="task-progress" data-task-progress hidden><span class="task-progress-bar"><i></i></span><small></small></span>
            <button type="button" class="task-sheet-link" data-task-reference>${linkIcon}Link a document</button>
          </div>
          <div class="markdown-block-shell task-markdown-shell">${descriptionEditor}</div>
          <p class="task-sheet-hint">Right-click for formatting and insertions · <kbd>[[</kbd> links a note, an article or an item · <kbd>- [ ]</kbd> starts a checklist</p>
          <div class="task-sheet-links" data-task-links hidden><h4>Linked documents</h4><div data-task-link-list></div></div>
        </section>
        <aside class="task-sheet-side" aria-label="Task details">
          <fieldset class="task-sheet-field"><legend>Status</legend><div class="task-segments">
            ${state.taskColumns.map((column) => `<label style="--segment-color:${escapeHtml(column.color || "#8c8c85")}"><input type="radio" name="column_id" value="${column.id}" ${column.id === Number(selectedColumn) ? "checked" : ""} required><span><i></i>${escapeHtml(column.name)}</span></label>`).join("")}
          </div></fieldset>
          <fieldset class="task-sheet-field"><legend>Priority</legend><div class="task-segments priority">
            ${["low", "medium", "high"].map((priority) => `<label class="${priority}"><input type="radio" name="priority" value="${priority}" ${(task?.priority || "medium") === priority ? "checked" : ""}><span>${labels[priority]}</span></label>`).join("")}
          </div></fieldset>
          <div class="task-sheet-field"><label for="task-project">Project</label><select id="task-project" name="project_id"><option value="">No project</option>${projectOptions(selectedProject)}</select></div>
          ${dateField("start_date", "Start", startDate, false)}
          ${dateField("due_date", "Deadline", task?.due_date || "", true)}
          <div class="task-sheet-field"><label for="task-tag-input">Tags <span>Optional</span></label>
            <div class="task-tags" data-task-tags><input id="task-tag-input" list="task-tag-suggestions" placeholder="Add a tag" aria-describedby="task-tags-help"></div>
            <datalist id="task-tag-suggestions">${knownTags.map((tag) => `<option value="${escapeHtml(tag)}"></option>`).join("")}</datalist>
            <input type="hidden" name="labels" value="${escapeHtml((task?.labels || []).join(", "))}">
            <small id="task-tags-help">Enter or comma to add · Backspace to remove the last one</small>
          </div>
        </aside>
      </div>
      <footer class="task-sheet-footer">
        ${task ? `<button type="button" class="button task-archive-action" data-sheet-archive>Archive</button>` : ""}
        <div class="task-unsaved" data-task-unsaved hidden role="alert"><span>Unsaved changes</span>
          <button type="button" class="button button-small" data-unsaved="discard">Discard</button>
          <button type="button" class="button button-small" data-unsaved="keep">Keep editing</button>
          <button type="button" class="button button-small button-primary" data-unsaved="save">Save</button></div>
        <span class="task-sheet-shortcut"><kbd>${navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}</kbd>+<kbd>Enter</kbd> to save</span>
        <button type="button" class="button" data-sheet-cancel>Cancel</button>
        <button type="submit" class="button button-primary">${task ? "Save" : "Create task"}</button>
      </footer>
    </form>`;
  const form = body.querySelector<HTMLFormElement>("#task-form")!;
  const editorRoot = body.querySelector<HTMLElement>("#task-description-editor")!;
  const source = body.querySelector<HTMLTextAreaElement>("#task-description-source")!;
  source.name = "description";
  bindMarkdownBlockEditor(editorRoot, source);
  const title = form.querySelector<HTMLTextAreaElement>("#task-title")!;
  const fitTitle = () => { title.style.height = "auto"; title.style.height = `${title.scrollHeight}px`; };
  title.addEventListener("input", fitTitle);
  title.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) { event.preventDefault(); currentMarkdownBlockInput(editorRoot, true); } });
  requestAnimationFrame(fitTitle);

  // Tags as chips; the hidden field keeps the comma-separated value the API expects.
  const tagsField = form.querySelector<HTMLInputElement>('[name="labels"]')!;
  const tagBox = form.querySelector<HTMLElement>("[data-task-tags]")!;
  const tagInput = form.querySelector<HTMLInputElement>("#task-tag-input")!;
  let tags = tagsField.value.split(",").map((tag) => tag.trim()).filter(Boolean);
  const renderTags = () => {
    tagBox.querySelectorAll(".task-tag").forEach((chip) => chip.remove());
    tagInput.before(...tags.map((tag) => {
      const chip = document.createElement("span");
      chip.className = "task-tag";
      chip.innerHTML = `${escapeHtml(tag)}<button type="button" aria-label="Remove ${escapeHtml(tag)}">×</button>`;
      chip.querySelector("button")!.addEventListener("click", () => { tags = tags.filter((item) => item !== tag); renderTags(); });
      return chip;
    }));
    tagsField.value = tags.join(", ");
    form.dispatchEvent(new Event("input"));
  };
  const addTag = () => {
    const value = tagInput.value.replace(/,/g, "").trim();
    if (value && !tags.some((tag) => tag.toLowerCase() === value.toLowerCase())) tags = [...tags, value];
    tagInput.value = "";
    renderTags();
  };
  tagInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === ",") { event.preventDefault(); addTag(); }
    else if (event.key === "Backspace" && !tagInput.value && tags.length) { tags = tags.slice(0, -1); renderTags(); }
  });
  tagInput.addEventListener("change", () => { if (knownTags.includes(tagInput.value)) addTag(); });
  tagInput.addEventListener("blur", addTag);
  tagBox.addEventListener("click", (event) => { if (event.target === tagBox) tagInput.focus(); });
  renderTags();

  form.querySelectorAll<HTMLButtonElement>("[data-date-set]").forEach((button) => button.addEventListener("click", () => {
    const field = form.querySelector<HTMLInputElement>(`[name="${button.dataset.dateSet}"]`)!;
    field.value = button.dataset.dateOffset === "clear" ? "" : isoDay(Number(button.dataset.dateOffset));
    form.dispatchEvent(new Event("input"));
  }));

  // Progress of the checklist and the documents the description links to, kept in sync with the text.
  const progress = form.querySelector<HTMLElement>("[data-task-progress]")!;
  const linksBox = form.querySelector<HTMLElement>("[data-task-links]")!;
  const linkList = form.querySelector<HTMLElement>("[data-task-link-list]")!;
  const refreshDescription = async () => {
    const items = editorRoot.querySelectorAll('.rich-content li[data-type="taskItem"]');
    const done = editorRoot.querySelectorAll('.rich-content li[data-type="taskItem"][data-checked="true"]').length;
    progress.hidden = !items.length;
    progress.querySelector("i")!.style.width = `${items.length ? (done / items.length) * 100 : 0}%`;
    progress.querySelector("small")!.textContent = `${done}/${items.length} steps`;
    const anchors = [...editorRoot.querySelectorAll<HTMLAnchorElement>(".rich-content a[href]")];
    const { describeLink } = await import("../documents/linkNavigation");
    const seen = new Set<string>();
    linkList.replaceChildren(...anchors.filter((anchor) => !seen.has(anchor.getAttribute("href")!) && seen.add(anchor.getAttribute("href")!)).map((anchor) => {
      const target = describeLink(anchor);
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `task-linked ${target.internal ? "internal" : "external"}`;
      chip.title = target.internal ? `Open ${target.title}` : target.href;
      chip.innerHTML = `<span>${escapeHtml(target.title)}</span><small>${escapeHtml(target.detail)}</small>`;
      chip.addEventListener("click", () => void import("../documents/linkNavigation").then(({ followLink }) => followLink(anchor)));
      return chip;
    }));
    linksBox.hidden = !anchors.length;
  };
  source.addEventListener("input", () => void refreshDescription());
  editorRoot.addEventListener("change", () => void refreshDescription());
  void refreshDescription();
  form.querySelector("[data-task-reference]")!.addEventListener("click", () => {
    const input = currentMarkdownBlockInput(editorRoot, true) as any;
    input?.kavotCommand?.("reference");
  });

  // Unsaved changes: closing asks to save, discard or keep editing.
  // Only the task's own fields: the editor's dialogs (properties, links) have inputs of their own.
  const fields = () => {
    const data = new FormData(form);
    return Object.fromEntries(TASK_FIELDS.map((name) => [name, data.get(name)]));
  };
  const snapshot = () => JSON.stringify(fields());
  let saved = snapshot();
  const dirty = () => snapshot() !== saved;
  const unsaved = form.querySelector<HTMLElement>("[data-task-unsaved]")!;
  const beforeClose = async () => {
    if (!dirty()) return true;
    unsaved.hidden = false;
    unsaved.querySelector<HTMLButtonElement>('[data-unsaved="save"]')!.focus();
    return new Promise<boolean>((resolve) => {
      unsaved.onclick = async (event) => {
        const choice = (event.target as HTMLElement).closest<HTMLElement>("[data-unsaved]")?.dataset.unsaved;
        if (!choice) return;
        unsaved.hidden = true;
        unsaved.onclick = null;
        resolve(choice === "discard" ? true : choice === "save" ? await save() : false);
      };
    });
  };
  form.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); form.requestSubmit(); }
  });

  async function save() {
    const data: Record<string, any> = fields();
    if (!String(data.title || "").trim()) { title.focus(); toast("Give the task a name", "error"); return false; }
    data.title = String(data.title).replace(/\s+/g, " ").trim();
    data.project_id = data.project_id ? Number(data.project_id) : null;
    data.column_id = Number(data.column_id);
    data.labels = String(data.labels || "").split(",").map((item) => item.trim()).filter(Boolean);
    data.checklist = [];
    if (!data.start_date) data.start_date = null;
    if (!data.due_date) data.due_date = null;
    try {
      const record = await api(task ? `/tasks/${task.id}` : "/tasks", { method: task ? "PATCH" : "POST", body: JSON.stringify(data) });
      saved = snapshot();
      const view = state.view;
      void (async () => {
        await refreshData();
        // Saving before opening a linked document: do not pull the user back to the tasks.
        if (state.view !== view) return;
        if (onSaved) await onSaved(record);
        else if (viewShown("dashboard")) renderDashboard();
        else await renderTaskContext();
      })();
      toast(task ? "Task saved" : "Task created");
      return true;
    } catch (error) {
      toast(error.message, "error");
      return false;
    }
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (await save()) await sheet.close(true);
  });
  form.querySelector("[data-sheet-cancel]")!.addEventListener("click", () => void sheet.close());
  form.querySelector("[data-sheet-archive]")?.addEventListener("click", async () => {
    try {
      await api(`/tasks/${task.id}/archive`, { method: "POST" });
      await sheet.close(true);
      await refreshData();
      if (viewShown("tasks")) await renderTaskContext();
      toast("Task archived");
    } catch (error) { toast(error.message, "error"); }
  });
  // Typing in the title or the description, or changing a field, can make the form dirty.
  requestAnimationFrame(() => { saved = snapshot(); title.focus({ preventScroll: true }); title.setSelectionRange(title.value.length, title.value.length); });
  return { beforeClose };
}

const TASK_FIELDS = ["title", "description", "column_id", "priority", "project_id", "start_date", "due_date", "labels"];
const linkIcon = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 7 3-3a5 5 0 0 1 7 7l-3 3M14 17l-3 3a5 5 0 0 1-7-7l3-3M8 16l8-8"/></svg>';

function isoDay(offset: number) {
  const day = new Date();
  day.setDate(day.getDate() + offset);
  return new Date(day.getTime() - day.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export function taskColumnModal(columnId = null) {
  const column = state.taskColumns.find((item) => item.id === Number(columnId));
  openModal(
    `<header class="modal-header"><h2>${column ? "Configure column" : "New column"}</h2><p>Add a stage that fits your research workflow.</p></header><div class="modal-body"><form id="task-column-form" class="form-grid"><div class="form-field full"><label>Name</label><input name="name" required maxlength="80" value="${escapeHtml(column?.name || "")}" placeholder="Ex. To review"></div><div class="form-field full"><label>Color</label><input name="color" type="color" value="${escapeHtml(column?.color || "#8c8c85")}"></div><div class="form-actions">${column ? `<button type="button" class="button button-danger" data-delete-column="${column.id}">Delete column</button>` : ""}<button type="button" class="button" data-close-modal>Cancel</button><button class="button button-primary">${column ? "Save" : "Add"}</button></div></form></div>`,
  );
  document
    .querySelector("#task-column-form")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const data: Record<string, any> = Object.fromEntries(new FormData((event.target as HTMLFormElement)));
      try {
        await api(column ? `/task-columns/${column.id}` : "/task-columns", {
          method: column ? "PATCH" : "POST",
          body: JSON.stringify(data),
        });
        closeModal();
        await refreshData();
        await renderTaskContext();
        toast(column ? "Column updated" : "Column added");
      } catch (error) {
        toast(error.message, "error");
      }
    });
}

export function deleteTaskColumnModal(columnId) {
  const column = state.taskColumns.find((item) => item.id === Number(columnId));
  if (!column) return;
  const destinations = state.taskColumns.filter(
    (item) => item.id !== column.id,
  );
  openModal(
    `<header class="modal-header"><h2>Delete “${escapeHtml(column.name)}”</h2><p>Cards are kept and moved to the selected column.</p></header><div class="modal-body"><form id="delete-column-form" class="form-grid"><div class="form-field full"><label>Move cards to</label><select name="move_to" required>${destinations.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join("")}</select></div><div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button class="button button-danger">Move and delete</button></div></form></div>`,
  );
  document
    .querySelector("#delete-column-form")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const moveTo = new FormData((event.target as HTMLFormElement)).get("move_to");
      try {
        await api(`/task-columns/${column.id}?move_to=${moveTo}`, {
          method: "DELETE",
        });
        closeModal();
        await refreshData();
        await renderTaskContext();
        toast("Column deleted; cards moved");
      } catch (error) {
        toast(error.message, "error");
      }
    });
}

export async function taskArchivesModal() {
  try {
    const archived = await api("/tasks?archived=true");
    openModal(
      `<header class="modal-header"><h2>Task archive</h2><p>Search, filter, restore, or permanently delete archived cards.</p></header><div class="modal-body"><div class="archive-filters"><input id="archive-search" type="search" placeholder="Title, description, tag…"><select id="archive-project"><option value="">All projects</option><option value="none">No project</option>${projectOptions()}</select><select id="archive-priority"><option value="">All priorities</option>${["low", "medium", "high"].map((priority) => `<option value="${priority}">${labels[priority]}</option>`).join("")}</select><select id="archive-column"><option value="">All columns</option>${state.taskColumns.map((column) => `<option value="${column.id}">${escapeHtml(column.name)}</option>`).join("")}</select><input id="archive-from" type="date" aria-label="Archived after"><input id="archive-to" type="date" aria-label="Archived before"></div><div class="archive-results-head"><strong id="archive-count"></strong><span>Permanent deletions cannot be undone.</span></div><div id="archive-results" class="archive-results"></div></div>`,
      true,
    );
    modal.classList.add("modal-archives");
    const renderArchiveResults = () => {
      const query = (document
        .querySelector("#archive-search") as HTMLInputElement)
        .value.trim()
        .toLowerCase();
      const project = (document.querySelector("#archive-project") as HTMLInputElement).value;
      const priority = (document.querySelector("#archive-priority") as HTMLInputElement).value;
      const column = Number(
        (document.querySelector("#archive-column") as HTMLInputElement).value || 0,
      );
      const from = (document.querySelector("#archive-from") as HTMLInputElement).value;
      const to = (document.querySelector("#archive-to") as HTMLInputElement).value;
      const items = archived.filter((task) => {
        const text =
          `${task.title} ${task.description} ${(task.labels || []).join(" ")}`.toLowerCase();
        const day = String(task.archived_at || "").slice(0, 10);
        return (
          (!query || text.includes(query)) &&
          (!project ||
            (project === "none"
              ? !task.project_id
              : task.project_id === Number(project))) &&
          (!priority || task.priority === priority) &&
          (!column || task.column_id === column) &&
          (!from || day >= from) &&
          (!to || day <= to)
        );
      });
      document.querySelector("#archive-count").textContent =
        `${items.length} archived task(s)`;
      document.querySelector("#archive-results").innerHTML = items.length
        ? items
            .map(
              (task) =>
                `<article class="archive-card"><div><span class="priority-pill ${task.priority}">${labels[task.priority]}</span><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(task.project_name || "No project")} · ${escapeHtml(task.column_name || "No column")} · archived on ${formatDate(task.archived_at)}</small></div><div><button class="button button-small" data-restore-task="${task.id}">Restore</button><button class="button button-small button-danger" data-delete-archived-task="${task.id}">Delete</button></div></article>`,
            )
            .join("")
        : `<div class="notes-list-empty">No task ne correspond aux filtres.</div>`;
    };
    document
      .querySelectorAll(".archive-filters input, .archive-filters select")
      .forEach((control) =>
        control.addEventListener("input", renderArchiveResults),
      );
    renderArchiveResults();
  } catch (error) {
    toast(error.message, "error");
  }
}
