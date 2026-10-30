"""Atelier: resource folders, document previews and chats without code."""
import zipfile
from pathlib import Path

import pytest


def office(path: Path, parts: dict[str, str]) -> Path:
    with zipfile.ZipFile(path, "w") as archive:
        for name, content in parts.items():
            archive.writestr(name, content)
    return path


W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'


@pytest.fixture()
def resources(tmp_path):
    folder = tmp_path / "data"
    folder.mkdir()
    office(folder / "brief.docx", {"word/document.xml": f"""<w:document {W}><w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Goals</w:t></w:r></w:p>
        <w:p><w:r><w:t>Ship the </w:t></w:r><w:r><w:t>exporter.</w:t></w:r></w:p>
        <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Metric</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Target</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
        </w:body></w:document>"""})
    office(folder / "results.xlsx", {
        "xl/workbook.xml": f'<workbook {S}><sheets><sheet name="Runs" sheetId="1" r:id="rId1"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
        "xl/sharedStrings.xml": f'<sst {S}><si><t>model</t></si><si><t>score</t></si><si><t>sd3.5</t></si></sst>',
        "xl/worksheets/sheet1.xml": f'<worksheet {S}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
                                    f'<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>0.91</v></c></row></sheetData></worksheet>',
    })
    office(folder / "talk.pptx", {"ppt/slides/slide2.xml": '<p:sld xmlns:p="p" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>',
                                  "ppt/slides/slide1.xml": '<p:sld xmlns:p="p" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>First</a:t></a:r></a:p></p:sld>'})
    (folder / "scores.csv").write_text("model;score\nsd3.5;0.91\n")
    (folder / "figure.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    (folder / "tool.exe").write_bytes(b"MZ")
    return folder


@pytest.fixture()
def project(client):
    return client.post("/api/projects", json={"name": "Resources test"}).json()


def test_resource_folder_previews(client, project, resources):
    base = f"/api/atelier/projects/{project['id']}"
    folder = client.post(f"{base}/folders", json={"path": str(resources), "kind": "resources"}).json()
    assert folder["kind"] == "resources" and folder["commits"] == []
    url = f"{base}/folders/{folder['id']}"

    document = client.get(f"{url}/preview", params={"path": "brief.docx"}).json()
    assert document["blocks"] == [{"type": "heading", "level": 1, "text": "Goals"}, {"type": "paragraph", "text": "Ship the exporter."},
                                  {"type": "table", "rows": [["Metric", "Target"]]}]
    sheet = client.get(f"{url}/preview", params={"path": "results.xlsx"}).json()["sheets"][0]
    assert sheet["name"] == "Runs" and sheet["rows"] == [["model", "score"], ["sd3.5", "", "0.91"]]
    assert client.get(f"{url}/preview", params={"path": "talk.pptx"}).json()["slides"] == [["First"], ["Second"]]
    assert client.get(f"{url}/preview", params={"path": "scores.csv"}).json()["sheets"][0]["rows"] == [["model", "score"], ["sd3.5", "0.91"]]
    assert client.get(f"{url}/preview", params={"path": "tool.exe"}).status_code == 422

    image = client.get(f"{url}/raw", params={"path": "figure.png"})
    assert image.status_code == 200 and image.headers["content-security-policy"] == "sandbox"
    assert client.get(f"{url}/raw", params={"path": "tool.exe"}).status_code == 422
    # Opening with the system's app is for documents, never for programs.
    assert client.post(f"{url}/open", json={"path": "tool.exe", "editor": "default"}).status_code == 422


def test_chat_with_resources(client, project, resources, monkeypatch):
    from app.plugins.atelier import runs
    seen = {}

    def execute(project_id, run, prompt, config):
        seen["prompt"], seen["cwd"] = prompt, run["cwd"]
        seen["command"] = runs._command("claude", "claude", {"model": "", "effort": "", "executable": ""}, run, prompt)[0]
        run.update(status="answered", response="It is a data folder.")
        runs._sync(run)
        with runs._lock:
            runs._live.pop(run["id"], None)
        runs._persist(project_id, run)

    monkeypatch.setattr(runs, "_engine", lambda engine: {"model": "", "executable": ""})
    monkeypatch.setattr(runs, "_execute", execute)
    base = f"/api/atelier/projects/{project['id']}"
    folder = client.post(f"{base}/folders", json={"path": str(resources), "kind": "resources"}).json()

    created = client.post(f"{base}/runs", json={"engine": "claude", "prompt": "What is in the data?", "resource_folder_ids": [folder["id"]]})
    assert created.status_code == 201, created.text
    run = client.get(f"{base}/runs/{created.json()['id']}").json()
    assert run["status"] == "answered" and run["workspaces"] == [] and run["resources"][0]["name"] == "data"
    assert seen["cwd"] == str(resources.resolve())
    assert "must never change" in seen["prompt"] and "do not create or edit files" in seen["prompt"]
    assert seen["command"][seen["command"].index("--tools") + 1] == "Read,Glob,Grep", "A chat only reads"
    assert client.post(f"{base}/runs/{run['id']}/discard").status_code == 409
    assert client.delete(f"{base}/folders/{folder['id']}").status_code == 204, "An answered chat does not hold its resources"

    # A chat with nothing linked runs in an empty folder of its own, removed with the chat.
    alone = client.post(f"{base}/runs", json={"engine": "claude", "prompt": "Plan the paper"}).json()
    assert Path(seen["cwd"]).is_dir() and "chats" in seen["cwd"]
    assert client.delete(f"{base}/runs/{alone['id']}").status_code == 204
    assert not Path(seen["cwd"]).exists()


def test_single_linked_file(client, project, resources, monkeypatch):
    """A file can be linked alone: only it is listed and read, never its neighbours."""
    from app.plugins.atelier import runs
    base = f"/api/atelier/projects/{project['id']}"
    item = client.post(f"{base}/folders", json={"path": str(resources / "results.xlsx"), "kind": "resources"}).json()
    assert item["file"] and item["available"] and item["name"] == "results.xlsx"
    url = f"{base}/folders/{item['id']}"
    assert [entry["name"] for entry in client.get(f"{url}/tree").json()["entries"]] == ["results.xlsx"]
    assert client.get(f"{url}/preview", params={"path": "results.xlsx"}).json()["sheets"][0]["name"] == "Runs"
    assert client.get(f"{url}/preview", params={"path": "brief.docx"}).status_code == 404
    assert client.get(f"{url}/file", params={"path": "scores.csv"}).status_code == 404

    script = client.post(f"{base}/folders", json={"path": str(resources / "scores.csv"), "kind": "code"}).json()
    assert script["file"] and script["kind"] == "code"

    seen = {}

    def execute(project_id, run, prompt, config):
        seen["prompt"], seen["cwd"] = prompt, run["cwd"]
        seen["command"] = runs._command("claude", "claude", {"model": "", "effort": "", "executable": ""}, run, prompt)[0]
        run.update(status="answered", response="ok")
        with runs._lock:
            runs._live.pop(run["id"], None)
        runs._persist(project_id, run)

    monkeypatch.setattr(runs, "_engine", lambda engine: {"model": "", "executable": ""})
    monkeypatch.setattr(runs, "_execute", execute)
    created = client.post(f"{base}/runs", json={"engine": "claude", "prompt": "Read it", "resource_folder_ids": [item["id"]]})
    assert created.status_code == 201, created.text
    assert "## File: results.xlsx" in seen["prompt"] and "sd3.5" in seen["prompt"], "The file is given as its text"
    assert str(resources) not in " ".join(seen["command"]), "Its folder is not opened to the agent"
    assert "chats" in seen["cwd"]


def test_workspace_document_preview(client, resources):
    """A .docx placed in the workspace (notes, project folders) is previewed in the editor."""
    import shutil
    from app.core.kernel.config import settings
    target = settings.notes_path / "general" / "brief.docx"
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(resources / "brief.docx", target)
    shown = client.get("/api/atelier/workspace/preview", params={"path": "notes/general/brief.docx"}).json()
    assert shown["blocks"][0] == {"type": "heading", "level": 1, "text": "Goals"}
    assert client.get("/api/atelier/workspace/preview", params={"path": "../outside.docx"}).status_code == 422
    (settings.notes_path / "general" / "tool.exe").write_bytes(b"MZ")
    assert client.post("/api/atelier/workspace/open", json={"path": "notes/general/tool.exe"}).status_code == 422
