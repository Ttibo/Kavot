from app.core.storage.cloud_sync import client as cloud
from app.core.storage.cloud_sync.client import LocalSync


def summary(**values):
    return {"uploaded": 0, "downloaded": 0, "deleted_local": 0, "deleted_remote": 0,
            "conflicts": [], "preserved": [], "skipped": [], "errors": [], **values}


def make(tmp_path):
    root = tmp_path / "ws"
    root.mkdir()
    return LocalSync("https://cloud.example", root, tmp_path / "state.sqlite", vault=object())


def test_idle_passes_are_not_recorded(tmp_path):
    sync = make(tmp_path)
    assert sync.record_activity(0, 5, summary()) is False
    assert sync.activity() == {"passes": [], "events": []}


def test_passes_and_events_are_kept_newest_first(tmp_path):
    sync = make(tmp_path)
    sync.pass_events = [{"kind": "upload", "path": "a.md", "size": 3, "at": 1.0}]
    assert sync.record_activity(1.0, 40, summary(uploaded=1))
    sync.pass_events = [{"kind": "deleted_local", "path": "b.md", "size": None, "at": 2.0}]
    sync.record_activity(2.0, 30, summary(deleted_local=1))
    activity = sync.activity()
    assert [item["deleted_local"] for item in activity["passes"]] == [1, 0]
    assert activity["passes"][1]["uploaded"] == 1 and activity["passes"][1]["duration_ms"] == 40
    assert [(item["kind"], item["path"]) for item in activity["events"]] == [("deleted_local", "b.md"), ("upload", "a.md")]
    assert sync.pass_events == []


def test_repeated_failures_and_conflicts_share_one_row(tmp_path):
    sync = make(tmp_path)
    sync.pass_events = [{"kind": "upload", "path": "a.md", "size": 3, "at": 1.0}]
    sync.record_activity(1.0, 40, summary(uploaded=1))
    for _ in range(3):
        sync.record_activity(2.0, 10, error="Cloud unreachable.")
    for _ in range(2):
        sync.pass_events = [{"kind": "conflict", "path": "c.md", "size": 1, "at": 3.0}]
        sync.record_activity(3.0, 10, summary(conflicts=["c.md"]))
    activity = sync.activity()
    assert [(item["error"], item["conflict_count"], item["repeats"]) for item in activity["passes"]] == [
        (None, 1, 1), ("Cloud unreachable.", 0, 2), (None, 0, 0)]
    assert [item["kind"] for item in activity["events"]] == ["conflict", "upload"]


def test_history_is_bounded(tmp_path, monkeypatch):
    monkeypatch.setattr(cloud, "ACTIVITY_PASSES", 3)
    monkeypatch.setattr(cloud, "ACTIVITY_EVENTS", 4)
    sync = make(tmp_path)
    for index in range(6):
        sync.pass_events = [{"kind": "upload", "path": f"{index}.md", "size": 1, "at": index}]
        sync.record_activity(index, 1, summary(uploaded=1))
    activity = sync.activity()
    assert len(activity["passes"]) == 3
    assert [item["path"] for item in activity["events"]] == ["5.md", "4.md", "3.md", "2.md"]
