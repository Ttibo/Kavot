from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Response
from fastapi.responses import PlainTextResponse

from app.plugins.planning.models import CalendarEventInput
from app.plugins.planning import calendar
from app.core.records.repository import store


router = APIRouter(prefix="/calendar", tags=["calendar"])


@router.get("/events")
def events(start: str, end: str, project_id: int | None = None) -> list[dict[str, Any]]:
    return calendar.list_events(start, end, project_id)


@router.post("/events", status_code=201)
def create_event(payload: CalendarEventInput) -> dict[str, Any]:
    return calendar.save_event(payload)


@router.patch("/events/{event_id}")
def update_event(event_id: int, payload: CalendarEventInput) -> dict[str, Any]:
    return calendar.save_event(payload, event_id)


@router.delete("/events/{event_id}", status_code=204)
def delete_event(event_id: int) -> Response:
    store.delete("calendar_events", event_id, "Event")
    return Response(status_code=204)


@router.get("/export.ics", response_class=PlainTextResponse)
def export_events(start: str = "1900-01-01", end: str = "2999-12-31", project_id: int | None = None) -> str:
    rows = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Kavot//Local Calendar//EN"]
    for event in calendar.list_events(start, end, project_id):
        stamp = str(event["starts_at"]).replace("-", "").replace(":", "").replace("+00:00", "Z")
        rows.extend(["BEGIN:VEVENT", f"UID:{event['id']}@kavot.local", f"DTSTART:{stamp}", f"SUMMARY:{event['title']}", "END:VEVENT"])
    return "\r\n".join([*rows, "END:VCALENDAR", ""])
