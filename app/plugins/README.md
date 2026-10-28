# Writing a Kavot plugin

A plugin is a folder `app/plugins/<id>/` with a `plugin.json` manifest and a
Python package. It is a collection of data with its own views, settings and
connectors. Removing the folder removes the feature; the user's data stays in
the workspace and comes back with the plugin.

## Manifest

```json
{
  "id": "research",
  "name": "Research",
  "version": "1.0.0",
  "requires_core": ">=2.0",
  "description": "Conferences with their deadlines, and datasets.",
  "removable": true,
  "state_collections": ["conferences", "datasets"],
  "collections": [{
    "id": "conferences", "name": "Conferences", "record_kind": "conference", "position": 40,
    "source": "databases/conferences/items/", "views": ["table", "calendar"], "tools": [],
    "storage": {"driver": "domain", "domain": "research"},
    "state_key": "conferences", "removable": true, "title_field": "name",
    "search_fields": ["name", "acronym", "location", "notes"],
    "agent_actions": {"create": "conference_create", "update": "conference_update", "delete": "conference_delete"}
  }],
  "link_types": [
    {"id": "uses_dataset", "from": "conferences", "to": "datasets", "label": "uses dataset", "field": "dataset_ids"}
  ],
  "settings": [],
  "connectors": []
}
```

| Key | Meaning |
| --- | --- |
| `id` | Same as the folder name |
| `requires_core` | `>=X.Y`; the plugin is skipped on an older core |
| `removable` | `false` while the core still imports the plugin (see `tests/core/test_boundaries.py`) |
| `state_collections` | Keys the plugin owns in `kavot.state.json` |
| `collections[]` | Catalogue entries. `state_key` stores the items, `search_fields` are indexed, `title_field` names them, `agent_actions` tells agents which actions change them, `removable` lets the user hide it, `position` orders the catalogue |
| `link_types[]` | Relations between collections. With `field`, links are derived from that field of the `from` items |
| `settings[]`, `connectors[]` | Declared settings and connectors (listed by `GET /api/plugins`, with their `permissions`) |

Collections without code (fields, views, connectors only) are the next step: for
now a plugin with data also defines `register`.

## `register(registry, manifest)`

Defined in the package's `__init__.py`, called once at startup. Import your
modules inside it, so that loading the manifest stays cheap.

```python
def register(registry, manifest):
    from app.plugins.research import routes, service
    registry.routers.append(routes.router)                  # HTTP routes under /api
    registry.calendar_sources.append(service.calendar_events)  # (state, project_id) -> events
    registry.agent_actions["conference_create"] = {
        "model": ConferenceInput,                # validates the values
        "state_key": "conferences",              # where the items live
        "apply": lambda payload, identifier, values: {"id": service.save(payload)["id"]},
        "summary": "Create a conference.",       # one line shown by list_actions
        "areas": ["conferences"],                # named MCP tool in these views
        "partial": False,                        # True: updates may omit unchanged fields
    }
```

Other registries: `mcp_tools` (functions receiving a `ToolContext` with
`tool`, `lock`, `run`, `emit`, `active()`, `compact()`), `agent_guides`
(topic -> text read with `get_guide`), `search_sources` (yield
`core.search.documents.Document`, or `Unchanged(group)` when a group did not
change), `link_sources`, `card_builders` (collection id -> function
`(card, row, index)` that adds facts and an outline to an item's workspace map
card), `state_initializers` and `state_migrations`.

## Rules

- Read and write your data through the core (`store`, `databases`, the
  registries). Storage, journal, search, links and sync then apply to it.
- Do not import another plugin. Use `kavot://` addresses and link types.
- Keep MCP results small: return ids, titles and short text, and let agents
  `read` the rest.
- Turning a plugin off: `KAVOT_DISABLED_PLUGINS=research` or the
  `disabled_plugins` preference, at the next start.
