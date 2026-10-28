"""Plugins are discovered from their manifests and fill the core's registries."""
from app.core.kernel import plugins
from app.core.kernel.registry import Registry


def test_manifests_fill_the_registry(client):
    registry = plugins.load()
    assert {"papers", "planning", "research"} <= set(registry.plugins)
    from app.core.records import databases
    # Same catalogue order as before the plugins existed.
    assert [item["id"] for item in databases.builtins()] == ["articles", "notes", "tasks", "conferences", "datasets"]
    assert databases.optional_builtins() == {"conferences", "datasets"}
    assert {"task_create", "conference_create", "paper_import"} <= set(registry.agent_actions)
    assert "cites" in registry.link_types and "planning" in registry.agent_guides


def test_a_removable_plugin_can_be_disabled(monkeypatch):
    monkeypatch.setenv("KAVOT_DISABLED_PLUGINS", "research,planning")
    registry = plugins.load(Registry())
    assert "research" not in registry.plugins
    assert "conferences" not in registry.state_collections
    # Planning is still required by the core, so it stays loaded.
    assert "planning" in registry.plugins


def test_plugin_listing(client):
    listed = {item["id"]: item for item in client.get("/api/plugins").json()}
    assert listed["research"]["enabled"] and listed["research"]["removable"]
    zotero = next(item for item in listed["papers"]["connectors"] if item["id"] == "zotero")
    assert zotero["label"] == "Zotero" and zotero["permissions"] == ["network:api.zotero.org"]
    assert {"id": "conferences", "name": "Conferences", "removable": True} in listed["research"]["collections"]


def test_manifest_validation(tmp_path):
    folder = tmp_path / "demo"
    folder.mkdir()
    (folder / "plugin.json").write_text('{"id": "other", "name": "Demo", "version": "1", "requires_core": ">=2.0"}')
    try:
        plugins.read_manifest(folder)
    except plugins.PluginError as error:
        assert "must match its folder" in str(error)
    else:
        raise AssertionError("A manifest whose id differs from its folder must be rejected.")
