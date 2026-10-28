# FastAPI backend

The backend has a **core** that knows no domain, and **plugins** that bring the
domains (articles, planning, research). A plugin declares its data in a
manifest and plugs code into the core's registries; the core never writes a
plugin's files for it, and a plugin never writes the index or the disk except
through the core.

```text
app/
├─ main.py, factory.py     ASGI entry point and application assembly
├─ api/                    routes of the core, mounted under /api with the plugins' routers
├─ models/                 Pydantic schemas of the core (notes, collections, projects)
├─ core/
│  ├─ kernel/              config, atomic files, user settings, startup (lifespan),
│  │                       plugin loader (plugins.py) and registries (registry.py)
│  ├─ records/             kavot.state.json repository, collection catalogue, custom
│  │                       collection records and schemas, migrations, read API (api.py)
│  ├─ links/               typed links between kavot:// addresses, with provenance
│  ├─ journal/             append-only change journal with the author of each change
│  ├─ search/              local index (SQLite FTS5) and optional local embeddings
│  ├─ digest/              workspace map: cards, data profiles, themes, agent summaries
│  ├─ workspace/           HTML notes, assets, local files, PDF/image extraction
│  ├─ projects/            projects, canvases, project code, trash
│  ├─ automation/          workflow and watcher engines
│  ├─ agents/              agent sessions, context, actions and the MCP server
│  └─ storage/             backups, online backups, cloud sync and sharing
├─ plugins/
│  ├─ papers/              library, PDF, citations, discovery, Zotero, article watches
│  ├─ planning/            tasks, board, calendar
│  └─ research/            conferences and datasets
├─ resources/              card templates and window script
└─ docs/                   MCP integration
```

`../desktop.py` runs the pywebview window and the local server.
`../frontend/static/` is produced by Vite and served by FastAPI; it contains no
source to edit.

## Data

- `kavot.state.json` is the transactional index (`core/records/repository.py`).
  Its keys are the core's plus those declared by plugins (`state_collections`).
- Heavy documents stay in their own folders: notes as HTML files, articles in
  `library/`, custom collection items in `databases/<id>/items/`.
- `.kavot-local/` holds per-device derived data: the search index and the
  change journal. It is excluded from sync and backups.
- `.meta_kavot/` holds extractions (PDF, images) and the summaries kept by agents
  (`digests/`); it is synced, because it is costly to produce again.
- Every item has an address: `kavot://<collection>/<id>`, with an optional
  `#anchor` (a note block, `page-<n>` of a PDF). `core/records/api.py` reads any
  address; `core/links` lists the links of one.

User data and preferences must never be moved together with the source code.

## Registries

| Registry (`core/kernel/registry.py`) | Filled from | Read by |
| --- | --- | --- |
| `collections`, `state_collections` | manifest | catalogue, repository, agent collections, search |
| `routers` | `register()` | `api/router.py` |
| `agent_actions` | `register()` | agent actions and MCP write tools |
| `mcp_tools`, `agent_guides` | `register()` | MCP server |
| `link_types`, `link_sources` | manifest, `register()` | `core/links` |
| `search_sources` | `register()` | `core/search` |
| `card_builders` | `register()` | `core/digest` (workspace map cards) |
| `calendar_sources` | `register()` | Planning's calendar |
| `state_initializers`, `state_migrations` | `register()` | repository |
| `settings`, `connectors` | manifest | `GET /api/plugins` |

See [plugins/README.md](plugins/README.md) to write a plugin.

## Tests

```sh
python -m pip install -e ".[dev]"
python -m pytest
```

`tests/core` covers the HTTP surface (no route may disappear), plugin loading,
records, links, journal, search and the MCP budget. `test_boundaries.py` lists
the imports from the core to plugins that remain to be moved behind registries.
