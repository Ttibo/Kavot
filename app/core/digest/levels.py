"""A note at three levels of detail, so an agent pays only for the depth a request needs.

1. brief: title, project and folder, tags, relations (canvas arrows, links), the gist
   and what the deeper levels cost (~100 tokens);
2. detail: the brief, the full summary and the outline, one gist per section;
3. content: the text, window by window, or one section.

The gist is the agent digest when one matches the note's current text, otherwise
the note's opening sentences. An agent that reads a note in full without a current
digest is asked to save one: the next request then reads it at level 1 or 2.
"""
from __future__ import annotations

from typing import Any

from app.core.digest import cards, store

BRIEF_SUMMARY = 280
BRIEF_RELATIONS = 8
SAVE_HINT = ("You read this note in full and it has no current summary: call save_digest(ref, summary, sections) "
             "with what it says, so later requests read it at level 1 or 2 instead of in full.")


def ref(note_id: int | str) -> str:
    return f"kavot://notes/{note_id}"


def _index():
    from app.core.search.index import ensure_fresh
    return ensure_fresh()


def _card(note_id: int | str) -> dict[str, Any]:
    index = _index()
    if index.item("notes", str(note_id)) is None:
        raise ValueError("Unknown note, or not indexed yet. Use list_notes or search.")
    return cards.item_card("notes", str(note_id), index)


def _relations(note_id: int | str, allowed: set[str] | None) -> tuple[list[dict], int]:
    from app.core import links
    index = _index()
    found = []
    for link in links.neighbors(ref(note_id), limit=500)["links"]:
        # The project is shown on its own line.
        if link["relation"] == "in_project" or (allowed is not None and link["ref"] not in allowed):
            continue
        parts = links.parse(link["ref"])
        item = index.item(parts["collection"], parts["id"])
        found.append({"dir": "→" if link["direction"] == "out" else "←", "relation": link["relation"],
                      "ref": link["ref"], "title": item["title"] if item else None, "label": link.get("label")})
    return found[:BRIEF_RELATIONS], max(0, len(found) - BRIEF_RELATIONS)


def _place(note_id: int | str) -> dict[str, Any]:
    from app.core.records.repository import store as state_store
    state = state_store.read()
    note = next((n for n in state.get("notes", []) if str(n["id"]) == str(note_id)), None) or {}
    project = next((p for p in state.get("projects", []) if p["id"] == note.get("project_id")), None)
    folder = next((f for f in state.get("note_folders", []) if f["id"] == note.get("folder_id")), None)
    tags = (note.get("properties") or {}).get("tags") if isinstance(note.get("properties"), dict) else None
    return {"project": project and {"id": project["id"], "name": project.get("name")},
            "folder": folder and folder.get("name"), "tags": tags or note.get("tags") or None,
            "updated_at": str(note.get("updated_at") or "")[:16] or None}


def _summary(card: dict) -> dict[str, Any]:
    if card.get("summary_by"):
        return {"summary": card["summary"], "summary_source": "agent digest", "summary_at": card["summary_by"].get("at")}
    # Notes open with their title as H1: the gist starts after it.
    title = (card.get("title") or "").strip()
    gist = (card.get("gist") or "").strip()
    gist = gist[len(title):].strip() if title and gist.startswith(title) else gist
    if not gist:
        gist = next((e["gist"] for e in card.get("outline") or [] if e.get("gist")), "")
    result = {"summary": gist, "summary_source": "opening sentences"}
    if card.get("stale_digest"):
        result["summary_source"] = "opening sentences (the agent digest is outdated: the note changed)"
    return result


def gist(note_id: int | str, chars: int = 160) -> dict[str, Any]:
    """The one-line part of a brief, for lists of notes."""
    try:
        card = _card(note_id)
    except ValueError:
        return {}
    text = _summary(card)["summary"]
    return {"summary": text[:chars] + ("…" if len(text) > chars else ""), "tokens": card.get("cost", 0)}


def brief(note_id: int | str, allowed: set[str] | None = None) -> dict[str, Any]:
    """Level 1."""
    card = _card(note_id)
    relations, more = _relations(note_id, allowed)
    summary = _summary(card)
    text = summary["summary"]
    outline = card.get("outline") or []
    return {"ref": card["ref"], "level": 1, "title": card["title"], **_place(note_id),
            "summary": text[:BRIEF_SUMMARY] + ("…" if len(text) > BRIEF_SUMMARY else ""),
            "summary_source": summary["summary_source"], "relations": relations,
            **({"more_relations": more} if more else {}),
            "sections": len(outline), "cost": {"level_2": 60 + sum(12 + len(e.get("gist") or "") // 4 for e in outline),
                                               "level_3": card.get("cost", 0)}}


def detail(note_id: int | str, allowed: set[str] | None = None) -> dict[str, Any]:
    """Level 2: the brief with the whole summary and the outline."""
    card = _card(note_id)
    result = brief(note_id, allowed)
    result.update(level=2, **_summary(card), keywords=card.get("keywords") or None,
                  outline=[{k: e.get(k) for k in ("ref", "title", "level", "gist", "cost") if e.get(k) not in (None, "")}
                           for e in card.get("outline") or []],
                  **({"outline_more": card["outline_more"]} if card.get("outline_more") else {}))
    return result


def needs_digest(note_ref: str) -> bool:
    digest = store.get(note_ref)
    return not digest or not digest["fresh"]


def content(note_id: int | str, section: str | None = None, limit: int = 6000) -> dict[str, Any]:
    """Level 3: the text from the start or from a section, window by window (follow `next`)."""
    from app.core.records import api
    address = ref(note_id) + (f"#{section}" if section else "")
    result = api.read(address, limit=limit)
    result["level"] = 3
    return result


def line(entry: dict[str, Any]) -> str:
    """A brief as one prompt line."""
    place = " · ".join(filter(None, [entry["project"]["name"] if entry.get("project") else "",
                                     ("folder " + entry["folder"]) if entry.get("folder") else ""]))
    relations = "; ".join(f"{r['dir']} {r.get('title') or r['ref']}" + (f" ({r['label']})" if r.get("label") else "")
                          for r in entry.get("relations", [])[:5])
    parts = [f'{entry["ref"]} "{entry["title"]}"', place,
             f"links: {relations}" if relations else "",
             entry.get("summary") or "",
             (f"level 2 ~{entry['cost']['level_2']} tok, full ~{entry['cost']['level_3']} tok"
              if entry["cost"]["level_2"] < entry["cost"]["level_3"] else f"full ~{entry['cost']['level_3']} tok")]
    return " — ".join(part for part in parts if part)
