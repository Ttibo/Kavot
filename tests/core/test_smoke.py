"""The HTTP surface used by the interface keeps working."""


def test_core_reads(client):
    for path in ("/api/health", "/api/projects", "/api/tasks", "/api/task-columns", "/api/conferences",
                 "/api/datasets", "/api/databases", "/api/workflows", "/api/watchers", "/api/papers",
                 "/api/notes", "/api/calendar/events?start=2026-01-01&end=2026-12-31"):
        response = client.get(path)
        assert response.status_code == 200, (path, response.text)


def test_create_items(client):
    project = client.post("/api/projects", json={"name": "Thesis"}).json()
    conference = client.post("/api/conferences", json={"name": "NeurIPS", "acronym": "NeurIPS", "status": "planned",
                                                       "project_ids": [project["id"]]})
    assert conference.status_code == 201, conference.text
    task = client.post("/api/tasks", json={"title": "Write intro", "project_id": project["id"]})
    assert task.status_code == 201, task.text
    assert any(t["title"] == "Write intro" for t in client.get("/api/tasks").json())
    assert any(c["name"] == "NeurIPS" for c in client.get("/api/conferences").json())


def test_no_route_lost(client):
    """Moving code between the core and plugins must not drop an endpoint the interface calls."""
    from pathlib import Path
    expected = set(Path(__file__).with_name("routes.snapshot.txt").read_text().split("\n")) - {""}
    paths = client.app.openapi()["paths"]
    current = {f"{method.upper()} {path}" for path, operations in paths.items() for method in operations}
    assert expected <= current, sorted(expected - current)
