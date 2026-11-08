# Local Kavot MCP

## Flow

```text
Agents page (chat) → POST /api/external-agents/sessions/<id>/messages
   context of the view (note, canvas selection, citation graph, picks) + mode
        → agent CLI (Claude Code: one process per conversation, kept between messages;
          Codex, OpenCode: one process per message, resumed)
                 ↕ Streamable HTTP, loopback, bearer token of the conversation
        Kavot MCP server (app/mcp), running with the app
                 ↕
        /edit: proposals approved in the chat · /auto: applied · /answer: none
                 ↓
        domain actions (validation, conflict checks) → local files → the app reloads
```

Advanced: the **Terminal** page (`app/core/agents/consoles.py`, xterm.js) runs an
agent CLI in a pseudo-terminal with all its own options, on the workspace session
(whole workspace, changes applied at once); Settings can also open one in an
external window (`terminal.py`).

## Code

Everything the agent sees of Kavot is in `app/mcp/`:

| Module | Role |
| --- | --- |
| `server.py` | Builds the server (MCP SDK 1.x or 2.x), serves it on loopback with the app, maps each token to its session |
| `session.py` | The workspace session (terminal agents) and conversation sessions (a chat request: view, mode, proposals) |
| `context_view.py` | The compact view context returned by `get_context` |
| `tools/` | The tools, one module per area (`workspace`, `notes`, `records`, `changes`), each with `install(ctx)` like plugins |
| `actions.py`, `organization.py`, `collections.py` | Validation and application of changes |
| `schemas.py`, `instructions.py` | Compact schemas and results; the instructions and guides the agent reads |

Conversations are `app/core/agents/sessions.py` (routes `external_agents.py`), the
view context `context.py`; terminals `consoles.py` and `terminal.py` (routes `agents.py`).

## Connection and lifetime

The server starts with the desktop app (`KAVOT_DESKTOP`), or at the first agent
use, on `http://127.0.0.1:<free port>/mcp`, and stops with the app. Every agent
gets a token naming its session: one per conversation process (detached when the
process ends), and a workspace token for terminals (new at each start). Tokens
travel in the CLI's environment, never in browser code; browser origins are
refused, and the SDK checks the Host header.

A conversation's Claude Code process (`_ClaudeWorker`) receives messages on stdin
(`--input-format stream-json`): it does not restart, reload its configuration and
replay the conversation for each message. It stops after 10 minutes without a
message, when the model or access changes, or when a request is stopped; the
next message resumes the conversation (`--resume`).

## Changes and conflicts

In a conversation, by mode: **/answer** makes no change, **/edit** keeps each
change as a proposal approved in the chat, **/auto** applies it. Terminal agents
apply at once; their CLI asks the user before each tool call. Kavot validates
every change like the app's own edits and checks conflicts: a note or canvas
changed in the app since the agent read it is refused ("read it again"), never
overwritten. The open app reloads after each change.

## Token budget

Tool definitions are sent to the model on every turn and every result stays in
its context. The server stays small: short instructions with guides on demand
(`get_guide`), one compact JSON text block per result, `search` then `read`
instead of paging through collections, compacted schemas, and few named write
tools (the note edits and `canvas_edit`); every other change goes through
`apply_action` after `get_action_schema`, many at once with `apply_actions`.
`tests/core/test_mcp.py` fails if the tool list grows past its budget.

## Tools

| Tool | Purpose |
| --- | --- |
| `get_context`, `read_source` | The view of the request (project, target note, selection, canvas, graph, picked sources), and a picked source's text |
| `workspace_overview` | Collections with counts, projects, recent changes, guide topics |
| `search`, `read` | Snippets with `kavot://` addresses; open an address passage by passage |
| `explore` | Workspace map down to an item's sections, with the token cost of each child |
| `get_links`, `get_history` | Linked items with provenance; recent changes with their author |
| `save_digest` | Keeps the agent's summary of an item it read, until the source changes |
| `get_guide` | Detailed rules for one kind of task |
| `list_notes`, `get_note`, `read_note` | Notes by level (brief, outline, text); HTML with block ids before editing |
| `get_canvas`, `get_note_format_guide`, `list_scripts`, `get_script` | Canvases, note format, script library |
| `get_organization`, `list_collections`, `get_collection`, `list_records`, `get_record` | Folders, projects, collections and their items |
| `list_actions`, `get_action_schema`, `apply_action`, `apply_actions` | Every change kind, its schema, and applying it |
| Named write tools | `note_create`, `note_block_update/insert/delete`, `note_update`, `note_content_replace`, `note_properties_update`, `canvas_edit` |
| Plugin tools | Planning: `list_tasks`, `list_events`. Papers: `get_article_pack`, `get_watch_research_context`, `search_articles`, `get_related_articles`, `get_article_details` |

## Workspace map: from macro to micro

`explore(ref)` lets an agent orient itself before reading anything. Each level
summarizes the one below and shows the token cost of opening each child, so the
agent decides how far to go:

| Level | Address | What the card holds |
| --- | --- | --- |
| Workspace | no ref, `kavot://workspace` | collections with item counts and cost, projects with their description, keywords, themes, recent changes |
| Project, collection | `kavot://projects/<id>`, `kavot://collections/<id>` | summary, counts, a profile of the data (types, ranges, frequent values per field), keywords, themes, one line per item |
| Item | `kavot://notes/12`, `kavot://articles/5`, `kavot://files/<path>`, any record | kind, facts (authors and DOI, tags, file size, image size...), summary, keywords, outline |
| Section, page | `#<block id>`, `#page-<n>` in the outline | heading and first sentence, with its cost |
| Text | `read(ref)` | the passages themselves |

`depth=2` adds each child's outline titles, or an item's links. Cards are built
from data Kavot already has, with no model call: note headings, PDF extractions
(one outline entry per page with its numbered or named headings), image text,
profiles of CSV/JSON files and of collection items, and keywords that are frequent
in the item but rare in the workspace (TF-IDF over the index vocabulary).

The index now also covers the user's own files under `notes/`, `projects/` and
`databases/`: text (`.md`, `.txt`), data (`.csv`, `.tsv`, `.json`), PDFs and images
(their existing extraction), addressed as `kavot://files/<url-encoded path>`.

**Summaries kept by agents.** After reading an item in full, an agent calls
`save_digest(ref, summary, sections, keywords)`. The summary then replaces the
extracted one in `explore` (with `summary_by` and its date), and section
summaries replace the outline's first sentences. A digest is tied to a hash of the
item's indexed text: when the source changes it is flagged `stale_digest` and no
longer shown. Digests are stored in `.meta_kavot/digests/` (synced and backed up,
since they cost tokens). Users see, and can delete, them in Settings → AI and
agents; `PUT /api/digests` saves a summary written by the user.

**Themes.** With local embeddings on, the items of a scope are grouped by meaning
(k-means on their vectors, at most 600 items) and each group is labelled with its
distinctive words and a few example items. Without embeddings, `keywords` still
describes the scope.

## Search

The index lives in `<workspace>/.kavot-local/search.sqlite` (SQLite FTS5). It is
derived data, never synced or backed up, and rebuilt incrementally: notes are
re-read only when their file changes, and every write recorded in the change
journal marks the index for a refresh before the next search.

A query runs in stages, cheapest first:

1. **lexical**: BM25 over titles (weighted) and text, accents and case ignored;
2. **fuzzy**: only when the lexical stage finds too little, partial words
   (`ablat`) and words one or two typos away (`calibrte`), checked word by word;
3. **semantic**: when local embeddings are enabled, candidates are re-ranked by
   meaning and passages sharing no word with the query are found; rankings are
   merged by reciprocal rank fusion.

Semantic search is optional: install `pip install "kavot[semantic]"`
(fastembed) and set the `semantic_search` preference. The multilingual model is
downloaded once, then everything runs locally. Without it, search uses the first
two stages.

The same search is available to the interface at `GET /api/search`, with
`/api/search/status`, `POST /api/search/reindex`, `GET /api/links`,
`GET /api/history`, `GET /api/records` and `GET /api/plugins`.

## Verify

```sh
python -m pytest tests/core/test_mcp.py tests/core/test_agent_trace.py tests/core/test_agent_terminal.py tests/core/test_agent_consoles.py
```

The tests run the server in process on a temporary workspace (budget, compact
results, live changes and conflicts, sharing, token check) and check the launch
arguments; they start no agent CLI and use no model.

References: [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk),
[Codex MCP](https://developers.openai.com/codex/mcp/),
[Claude Code MCP](https://code.claude.com/docs/en/mcp),
[OpenCode MCP](https://opencode.ai/docs/mcp-servers/).
