import { escapeHtml, formatDate, state } from '../../app/state';
import { projectOptions } from '../../components/dialogs/controller';
import { newTaskModal } from '../tasks/dialogs';
import { conferenceModal } from '../research/actions';
import { api } from '../../services/api';
import { toast } from '../../app/navigation';
import { openSheet, type SheetHandle } from '../sheet/sheet';
import '../../styles/features/task-sheet.css';
import { showView } from '../../app/viewBridge';

export const calendarSourceLabels = {
  task_start: "Task start",
  task_due: "Task deadline",
  conference: "Conference",
  conference_deadline: "Deadline",
  manual: "Kavot event",
};

const calendarDayKey = (value) => String(value || "").slice(0, 10);

export const calendarLocalDateKey = (value) => {
  const pad = (part) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
};

export function calendarEventOccursOn(event, dayKey) {
  const first = calendarDayKey(event.starts_at);
  const last = calendarDayKey(event.ends_at || event.starts_at);
  return dayKey >= first && dayKey <= last;
}

export function calendarMonthRange(cursor) {
  const start = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const end = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
  const pad = (value) => String(value).padStart(2, "0");
  const serialize = (value) =>
    `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  return { start: serialize(start), end: serialize(end) };
}

export function calendarDayAgenda(dayKey) {
  const events = state.calendarEvents.filter(
    (event) =>
      calendarEventOccursOn(event, dayKey) &&
      (state.calendarSourceFilter === "all" || event.source === state.calendarSourceFilter),
  );
  void openSheet({
    key: `agenda:${dayKey}:${events.length}`,
    title: formatDate(dayKey),
    label: `Agenda of ${formatDate(dayKey)}`,
    mount: (body) => {
      body.innerHTML = `<div class="calendar-agenda-panel"><p>${events.length} item${events.length === 1 ? "" : "s"} on this day</p>
        <div class="calendar-agenda-list">${events.map((event) => `<button data-agenda-event="${escapeHtml(event.id)}" style="--event-color:${escapeHtml(event.color || "#087e86")}"><i></i><span><strong>${escapeHtml(event.title)}</strong><small>${escapeHtml(calendarSourceLabels[event.source] || event.source)}${!event.all_day && event.starts_at ? ` · ${escapeHtml(String(event.starts_at).slice(11, 16))}` : ""}${event.location ? ` · ${escapeHtml(event.location)}` : ""}</small></span></button>`).join("")}</div>
        <button type="button" class="button" data-agenda-new>+ New event on this day</button></div>`;
      body.querySelectorAll<HTMLElement>("[data-agenda-event]").forEach((button) =>
        button.addEventListener("click", () => openCalendarEvent(button.dataset.agendaEvent)));
      body.querySelector("[data-agenda-new]")!.addEventListener("click", () => calendarEventModal(null, dayKey));
    },
  });
}

export function openCalendarEvent(eventId) {
  const event = state.calendarEvents.find((item) => String(item.id) === String(eventId));
  if (!event) return;
  if (event.source === "manual") return calendarEventModal(event);
  if (event.source === "task_start" || event.source === "task_due")
    return newTaskModal(null, null, event.entity_id);
  if (event.source === "conference" || event.source === "conference_deadline")
    return conferenceModal(event.entity_id);
  if (event.web_url) window.open(event.web_url, "_blank", "noopener");
}

let newEventCount = 0;

/** Opens a calendar event (or a new one on a day) in the side panel. */
export function calendarEventModal(event = null, selectedDay: string | null = null) {
  void openSheet({
    key: event ? `event:${event.entity_id}` : `event:new:${++newEventCount}`,
    title: event ? "Event" : "New event",
    label: event ? "Event editor" : "New event editor",
    mount: (body, sheet) => mountEventEditor(body, sheet, event, selectedDay),
  });
}

const EVENT_FIELDS = ["title", "all_day", "start_date", "start_time", "end_date", "end_time", "project_id", "location", "description"];

function mountEventEditor(body: HTMLElement, sheet: { close: (force?: boolean) => Promise<boolean> }, event: any, selectedDay: string | null): SheetHandle {
  const day = selectedDay || calendarLocalDateKey(new Date());
  const start = String(event?.starts_at || `${day}T09:00`);
  const end = String(event?.ends_at || "");
  const allDay = event ? event.all_day !== false : true;
  const projectId = event?.project_id || (state.calendarProjectFilter !== "all" ? Number(state.calendarProjectFilter) : null);
  const project = state.projects.find((item) => item.id === projectId);
  const quick = (name: string) => `<div class="task-date-quick" role="group" aria-label="Date shortcuts">${[[0, "Today"], [1, "Tomorrow"], [7, "In a week"]]
    .map(([offset, text]) => `<button type="button" data-event-day="${name}" data-offset="${offset}">${text}</button>`).join("")}</div>`;
  body.innerHTML = `<form id="calendar-event-form" class="task-sheet in-panel event-sheet" autocomplete="off" novalidate>
    <header class="task-sheet-header">
      <p class="task-sheet-meta"><span>${event ? "Event" : "New event"}</span>${project ? `<span><i class="project-dot" style="background:${escapeHtml(project.color || "#8c8c85")}"></i>${escapeHtml(project.name)}</span>` : ""}<span>Kavot calendar · exported with ICS</span></p>
      <label class="sr-only" for="event-title">Title</label>
      <textarea id="event-title" class="task-sheet-title" name="title" required maxlength="240" rows="1" placeholder="What is happening?">${escapeHtml(event?.title || "")}</textarea>
    </header>
    <div class="task-sheet-body">
      <section class="task-sheet-side event-when" aria-label="When">
        <label class="event-all-day"><input type="checkbox" name="all_day" ${allDay ? "checked" : ""}><span><strong>All day</strong><small>Shown as a date in the calendar</small></span></label>
        <div class="event-range">
          <div class="task-sheet-field"><label for="event-start-date">Starts</label>
            <div class="event-moment"><input id="event-start-date" type="date" name="start_date" required value="${escapeHtml(start.slice(0, 10))}"><input type="time" name="start_time" aria-label="Start time" value="${escapeHtml(start.slice(11, 16) || "09:00")}"></div>${quick("start")}</div>
          <div class="task-sheet-field"><label for="event-end-date">Ends <span>Optional</span></label>
            <div class="event-moment"><input id="event-end-date" type="date" name="end_date" value="${escapeHtml(end.slice(0, 10))}"><input type="time" name="end_time" aria-label="End time" value="${escapeHtml(end.slice(11, 16) || "")}"></div>${quick("end")}</div>
        </div>
        <div class="task-sheet-field"><label for="event-project">Project</label><select id="event-project" name="project_id"><option value="">No project</option>${projectOptions(projectId)}</select></div>
        <div class="task-sheet-field"><label for="event-location">Location <span>Optional</span></label><input id="event-location" name="location" value="${escapeHtml(event?.location || "")}" placeholder="Room, city or link"></div>
      </section>
      <section class="task-sheet-main" aria-label="Description">
        <div class="task-sheet-section-head"><strong>Notes</strong></div>
        <textarea class="event-description" name="description" placeholder="Agenda, people, what to prepare…">${escapeHtml(event?.description || "")}</textarea>
      </section>
    </div>
    <footer class="task-sheet-footer">
      ${event ? '<button type="button" class="button task-archive-action" data-event-delete>Delete</button><span class="event-delete-confirm" data-event-confirm hidden>Delete this event? <button type="button" class="button button-small button-danger" data-event-delete-confirm>Delete</button><button type="button" class="button button-small" data-event-delete-cancel>Keep</button></span>' : ""}
      <div class="task-unsaved" data-task-unsaved hidden role="alert"><span>Unsaved changes</span>
        <button type="button" class="button button-small" data-unsaved="discard">Discard</button>
        <button type="button" class="button button-small" data-unsaved="keep">Keep editing</button>
        <button type="button" class="button button-small button-primary" data-unsaved="save">Save</button></div>
      <span class="task-sheet-shortcut"><kbd>${navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}</kbd>+<kbd>Enter</kbd> to save</span>
      <button type="button" class="button" data-sheet-cancel>Cancel</button>
      <button type="submit" class="button button-primary">${event ? "Save" : "Add event"}</button>
    </footer>
  </form>`;
  const form = body.querySelector<HTMLFormElement>("#calendar-event-form")!;
  const title = form.querySelector<HTMLTextAreaElement>("#event-title")!;
  const fitTitle = () => { title.style.height = "auto"; title.style.height = `${title.scrollHeight}px`; };
  title.addEventListener("input", fitTitle);
  const allDayBox = form.querySelector<HTMLInputElement>('[name="all_day"]')!;
  const showTimes = () => form.querySelectorAll<HTMLInputElement>('input[type="time"]').forEach((input) => { input.hidden = allDayBox.checked; });
  allDayBox.addEventListener("change", showTimes);
  showTimes();
  const startDate = form.querySelector<HTMLInputElement>('[name="start_date"]')!;
  const endDate = form.querySelector<HTMLInputElement>('[name="end_date"]')!;
  // An end before the start follows it, so the range always stays valid.
  startDate.addEventListener("change", () => { if (endDate.value && endDate.value < startDate.value) endDate.value = startDate.value; });
  form.querySelectorAll<HTMLButtonElement>("[data-event-day]").forEach((button) => button.addEventListener("click", () => {
    const target = button.dataset.eventDay === "start" ? startDate : endDate;
    const value = new Date(); value.setDate(value.getDate() + Number(button.dataset.offset));
    target.value = calendarLocalDateKey(value);
    target.dispatchEvent(new Event("change", { bubbles: true }));
  }));
  const fields = () => { const data = new FormData(form); return Object.fromEntries(EVENT_FIELDS.map((name) => [name, data.get(name)])); };
  let saved = JSON.stringify(fields());
  const dirty = () => JSON.stringify(fields()) !== saved;
  async function save() {
    const data = fields();
    if (!String(data.title || "").trim()) { title.focus(); toast("Give the event a title", "error"); return false; }
    const all = !!data.all_day;
    const moment = (date, time) => date ? `${date}T${all || !time ? "00:00" : time}` : null;
    const payload = {
      title: String(data.title).replace(/\s+/g, " ").trim(),
      starts_at: moment(data.start_date, data.start_time),
      ends_at: moment(data.end_date, data.end_time),
      all_day: all,
      project_id: data.project_id ? Number(data.project_id) : null,
      location: data.location || "",
      description: data.description || "",
    };
    try {
      await api(event ? `/calendar/events/${event.entity_id}` : "/calendar/events", { method: event ? "PUT" : "POST", body: JSON.stringify(payload) });
      saved = JSON.stringify(fields());
      if (state.view === "calendar") await renderCalendar();
      toast(event ? "Event updated" : "Event added");
      return true;
    } catch (error) {
      toast(error.message, "error");
      return false;
    }
  }
  form.addEventListener("submit", async (submitEvent) => { submitEvent.preventDefault(); if (await save()) await sheet.close(true); });
  form.addEventListener("keydown", (keyEvent) => { if (keyEvent.key === "Enter" && (keyEvent.ctrlKey || keyEvent.metaKey)) { keyEvent.preventDefault(); form.requestSubmit(); } });
  title.addEventListener("keydown", (keyEvent) => { if (keyEvent.key === "Enter" && !keyEvent.ctrlKey && !keyEvent.metaKey) { keyEvent.preventDefault(); startDate.focus(); } });
  form.querySelector("[data-sheet-cancel]")!.addEventListener("click", () => void sheet.close());
  const confirmBox = form.querySelector<HTMLElement>("[data-event-confirm]");
  form.querySelector("[data-event-delete]")?.addEventListener("click", () => { confirmBox!.hidden = false; });
  form.querySelector("[data-event-delete-cancel]")?.addEventListener("click", () => { confirmBox!.hidden = true; });
  form.querySelector("[data-event-delete-confirm]")?.addEventListener("click", async () => {
    try {
      await api(`/calendar/events/${event.entity_id}`, { method: "DELETE" });
      await sheet.close(true);
      if (state.view === "calendar") await renderCalendar();
      toast("Event deleted");
    } catch (error) { toast(error.message, "error"); }
  });
  const unsaved = form.querySelector<HTMLElement>("[data-task-unsaved]")!;
  const beforeClose = async () => {
    if (!dirty()) return true;
    unsaved.hidden = false;
    unsaved.querySelector<HTMLButtonElement>('[data-unsaved="save"]')!.focus();
    return new Promise<boolean>((resolve) => {
      unsaved.onclick = async (clickEvent) => {
        const choice = (clickEvent.target as HTMLElement).closest<HTMLElement>("[data-unsaved]")?.dataset.unsaved;
        if (!choice) return;
        unsaved.hidden = true;
        unsaved.onclick = null;
        resolve(choice === "discard" ? true : choice === "save" ? await save() : false);
      };
    });
  };
  requestAnimationFrame(() => { fitTitle(); saved = JSON.stringify(fields()); title.focus({ preventScroll: true }); });
  return { beforeClose };
}

export function renderCalendar() { showView("calendar"); }
