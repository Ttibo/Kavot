"""Two devices editing the workspace at the same time: kavot.state.json merges record by record."""
from app.core.storage.cloud_sync.merge import merge_state


def note(id, title, updated="2026-01-01", **values):
    return {"id": id, "title": title, "updated_at": updated, **values}


BASE = {"version": 3, "notes": [note(1, "Intro"), note(2, "Methods")], "projects": [{"id": 1, "name": "Thesis"}]}


def test_different_records_changed_on_each_side_are_both_kept():
    local = {**BASE, "notes": [note(1, "Intro, rewritten", "2026-01-02"), note(2, "Methods")]}
    remote = {**BASE, "notes": [note(1, "Intro"), note(2, "Methods v2", "2026-01-03")]}
    merged = merge_state(BASE, local, remote)
    assert [n["title"] for n in merged["notes"]] == ["Intro, rewritten", "Methods v2"]


def test_new_records_from_both_sides_are_kept_and_a_clashing_id_moves():
    local = {**BASE, "notes": [*BASE["notes"], note(3, "Local idea")],
             "tasks": [{"id": 1, "title": "Read", "note_id": 3}]}
    remote = {**BASE, "notes": [*BASE["notes"], note(3, "Remote idea")]}
    merged = merge_state(BASE, local, remote)
    titles = {n["id"]: n["title"] for n in merged["notes"]}
    assert titles == {1: "Intro", 2: "Methods", 3: "Remote idea", 4: "Local idea"}
    # The local task pointed at the local note: it follows the new id.
    assert merged["tasks"] == [{"id": 1, "title": "Read", "note_id": 4}]


def test_a_field_changed_on_both_sides_takes_the_last_update():
    local = {**BASE, "notes": [note(1, "Local title", "2026-01-05", color="red"), note(2, "Methods")]}
    remote = {**BASE, "notes": [note(1, "Remote title", "2026-01-04", pinned=True), note(2, "Methods")]}
    merged = merge_state(BASE, local, remote)
    first = merged["notes"][0]
    assert first["title"] == "Local title" and first["color"] == "red" and first["pinned"] is True


def test_deletions_apply_unless_the_other_side_edited_the_record():
    local = {**BASE, "notes": [note(2, "Methods")]}                        # note 1 deleted here
    remote = {**BASE, "notes": [note(1, "Intro"), note(2, "Methods v2", "2026-01-02")]}
    assert [n["id"] for n in merge_state(BASE, local, remote)["notes"]] == [2]
    remote_edit = {**BASE, "notes": [note(1, "Intro edited", "2026-01-02"), note(2, "Methods")]}
    kept = merge_state(BASE, local, remote_edit)["notes"]
    assert {n["id"]: n["title"] for n in kept} == {1: "Intro edited", 2: "Methods"}


def test_without_a_common_version_nothing_is_lost():
    local = {"notes": [note(1, "A")]}
    remote = {"notes": [note(1, "B")], "tasks": [{"id": 1, "title": "T"}]}
    merged = merge_state(None, local, remote)
    assert sorted(n["title"] for n in merged["notes"]) == ["A", "B"] and merged["tasks"] == [{"id": 1, "title": "T"}]
