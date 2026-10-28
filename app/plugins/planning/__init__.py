"""Planning plugin: tasks, the kanban board and the calendar."""
from __future__ import annotations


def register(registry, manifest) -> None:
    from fastapi import HTTPException
    from pydantic import Field

    from app.core.projects import canvas as agent_canvas
    from app.core.projects.canvas import NoteCanvasPlacement
    from app.plugins.planning import calendar, calendar_routes, routes, service, state
    from app.plugins.planning.models import CalendarEventInput, TaskCreate, TaskUpdate

    registry.routers += [routes.router, calendar_routes.router]
    registry.state_initializers.append(state.initialize)
    registry.state_migrations.append(state.migrate)
    registry.calendar_sources += [calendar.manual_events, calendar.task_events]

    class TaskDraft(TaskCreate):
        canvas: NoteCanvasPlacement | None = Field(default=None, description="Place the new task on its project canvas and link it.")

    def create_task(payload, identifier, values):
        placement = values.get("canvas")
        result = service.create_task(TaskCreate(**{k: v for k, v in values.items() if k != "canvas"}))
        if not placement:
            return {"id": result["id"]}
        try:
            return {"id": result["id"], "canvas": agent_canvas.place_new_note(result, placement, kind="task")}
        except (ValueError, HTTPException) as error:
            # The task exists; report why it could not be placed instead of losing it.
            return {"id": result["id"], "canvas_error": str(getattr(error, "detail", error))}

    def save_event(payload, identifier, values):
        return {"id": calendar.save_event(payload, int(identifier) if identifier else None)["id"]}

    registry.agent_actions.update({
        "task_create": {"model": TaskDraft, "state_key": "tasks", "apply": create_task, "areas": ["tasks", "calendar", "project", "canvas", "dashboard"],
                        "summary": "Create a task; canvas={connect_to, label} also places it on the project canvas."},
        "task_update": {"model": TaskUpdate, "state_key": "tasks", "areas": ["tasks", "calendar", "project", "canvas"],
                        "apply": lambda payload, identifier, values: {"id": service.update_task(int(identifier), payload)["id"]},
                        "summary": "Change fields of a task (only send changed fields)."},
        "event_create": {"model": CalendarEventInput, "state_key": "calendar_events", "apply": save_event, "areas": ["calendar"],
                         "summary": "Create a calendar event (starts_at ISO, ends_at, all_day, location, project_id)."},
        "event_update": {"model": CalendarEventInput, "state_key": "calendar_events", "apply": save_event, "partial": True,
                         "summary": "Change a manual calendar event."},
    })

    from app.plugins.planning import mcp
    registry.mcp_tools.append(mcp.install)
    registry.agent_guides["planning"] = GUIDE


GUIDE = """Tasks and calendar: list_tasks shows tasks and the board columns; list_events shows the
calendar over a period (events, task start/due dates, conference deadlines) so you can avoid
conflicts. task_create (title, description, status todo|doing|done, priority low|medium|high,
labels, checklist [{text, done}], start_date/due_date YYYY-MM-DD, column_id, project_id; canvas
like note_create), task_update (only changed fields), task_delete. event_create (title,
starts_at, ends_at ISO 8601, all_day, location, description, project_id), event_update,
event_delete. Use the user's dates literally; for a relative date ("next Monday") compute it
from today's date and say which date you used."""
