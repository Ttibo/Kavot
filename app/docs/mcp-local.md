# Local Kavot MCP

## Flow

```text
React chat → conversation API → agent engine with an MCP client
                                        ↕ local Streamable HTTP
                                 Kavot MCP server
                                        ↕
                            context and domain proposals

Approval in the chat → proposal API → domain services → local files
```

`app/core/agents/mcp_server.py` uses the official MCP Python SDK. The adapter
supports MCP 1.x (from 1.30) and MCP 2.x (tested with 2.3.0). It loads
`FastMCP` on v1 or `MCPServer` on v2 and passes the HTTP settings to the
constructor or to the ASGI factory depending on the installed version. No
downgrade of MCP 2.3 is needed. The adapter reuses the context prepared by
`external_agent_context` and the action validation of `external_agent_actions`.
The server exposes no function to approve, delete or write files directly. The
chat keeps its REST API for sessions, progress, cancellation and decisions.

## Connection and lifetime

Each run starts an endpoint `http://127.0.0.1:<free port>/mcp` inside the local
Kavot process. This ties MCP access directly to the request's context and mode,
with no global registry reachable by every agent. The server stops at the end
of the run, on error, or after a cancelled agent process exits. Tools
immediately reject cancelled requests and requests from another workspace. Two
requests get separate ports and tokens.

The random token is passed through the child process environment and sent in
the Authorization header. It is neither exposed by the chat API nor stored in
sessions, and activity logs mask its value. Requests with a browser origin are
rejected; the SDK also checks the Host header. The server only listens on the
loopback interface and is not a cloud service.

The adapters configure their MCP client for every message, including when a
session is resumed:

- Codex: temporary overrides of the `mcp_servers.kavot.*` fields, token through
  an environment variable, required server, and waiting for tool discovery
  before the first turn (`mcp_optional_startup_grace_ms=0`). When resuming,
  these settings are placed after `exec resume` so they apply to the request's
  new connection.
- Claude Code: `--mcp-config`, `--strict-mcp-config` and permission for the
  `mcp__kavot__*` tools, with substitution of the token variable.
- OpenCode: inline configuration through `OPENCODE_CONFIG_CONTENT` and the
  `kavot_*` permission. Other inline values are kept.

Accounts, models and native histories remain managed by the engines. The local
connection does not change the provider to which these engines send the
context to produce an answer.

## Token budget

Tool definitions are sent to the model on every turn, and every result stays
in its context, so the server is designed to cost as little as possible:

| | Before | Now |
| --- | --- | --- |
| Tools in `/edit` (dashboard) | 76 tools, 108,193 characters (about 27,000 tokens) | 42 tools, 26,927 characters (about 6,700 tokens) |
| Tools in `/plan` | 21 tools, 13,305 characters | 30 tools, 13,255 characters |
| Instructions (also copied into the prompt) | 5,729 characters | 1,838 characters |
| `get_context` on the demo workspace | 32,344 characters | 5,894 characters |
| `list_records(articles)` / `list_tasks` | 8,682 / 5,458 characters | 2,739 / 1,867 characters |

Measured on the seeded demo workspace with MCP 1.30. How:

- **Short instructions, guides on demand.** Detailed rules (notes, canvas,
  collections, organization, planning, papers) are read once with
  `get_guide(topic)`. Plugins add their own topics.
- **One compact text block per result.** Results are JSON without indentation
  or empty values, returned once; the SDK's indented copy and the duplicated
  structured content are no longer sent.
- **Search first, then read only what is needed.** `search` returns short
  snippets with `kavot://` addresses; `read` opens one address passage by
  passage. Agents no longer page through whole collections to find one item.
- **Write tools that fit the request.** The common note and record edits are
  named tools, plus the actions of the open area (tasks and events in the
  calendar, canvas edits on a canvas, filing in the library...). Every other
  action goes through `propose_action` after `get_action_schema(kind)`;
  `list_actions` lists them. An invalid `propose_action` answers with the
  expected schema. `KAVOT_MCP_TOOLSET=full` restores one named tool per action.
- **Smaller schemas.** Titles, `default: null` and `anyOf [X, null]` unions are
  removed from input schemas before they are published; validation is unchanged.
- **Compact context.** `get_context` lists records as id/title (40 per
  collection at most), canvases without geometry and the citation graph as a
  count; details come from `read`, `get_record` or `get_article_pack`.

`tests/core/test_mcp.py` keeps these budgets: it fails if the tool list grows
past them.

## Tools

| Tool | Purpose |
| --- | --- |
| `get_context` | Project, target, record summaries and source catalogue of the request |
| `workspace_overview` | Collections with counts, projects, recent changes, guide topics and the request's write tools |
| `search` | Notes (by passage), article metadata and PDF pages, tasks, every collection item; snippets with `kavot://` addresses |
| `read` | Opens an address: note passages from a block, a PDF page (`#page-<n>`), or a record's fields (`fields=[...]`) |
| `get_links` | Linked items with relation and provenance: project membership, citations, reading notes, canvas arrows, plugin link types |
| `get_history` | Recent changes of an item or collection, with their author (user, agent, workflow, watcher) |
| `explore` | Workspace map from the workspace down to an item's sections, with the token cost of each child |
| `save_digest` | Keeps an agent's summary of an item it read, until the source changes |
| `get_guide` | Detailed rules for one kind of task |
| `read_source` | Read a selected source by ID, with text pagination and extracted PDF pages |
| `read_note` | A note's HTML with block ids; required before editing it |
| `list_collections`, `get_collection`, `list_records`, `get_record` | Exhaustive listings and full schemas; `fields` keeps only some fields |
| `list_notes`, `get_canvas`, `get_note_format_guide`, `list_scripts`, `get_script` | Notes, canvases, note format and script library |
| `get_organization` | Folders, projects, collections and IDs in scope, refreshable after approval |
| `list_actions`, `get_action_schema`, `propose_action` | Every change kind, its request schema, and the generic way to propose it (`/edit`) |
| Named write tools | The note and record edits and the actions of the open area (`/edit`) |
| Plugin tools | Planning: `list_tasks`, `list_events`. Papers: `get_article_pack`, `get_article_details`, `get_related_articles`, `search_articles`, `get_watch_research_context` |

Named tools and `propose_action` share the scope checks, deduplication and the
limit of 30 proposals (200 in `/auto`). In `/plan`, only read tools are
available. `search`, `read`, `get_links` and `get_history` apply the same scope
as the other tools: inside a project only its items are visible, and excluded
sources never appear.

## Context picked in the chat

Above the message, **Add context** (or `@` typed in the message) opens a picker
over projects, notes, articles, article folders, note folders, collections and
files: type to filter, ↑↓ and Enter to add, Tab to change the type. Picked items
show as chips, stay with the conversation (saved per session in the browser)
and are removed with their ×. They become the request's context:

| Picked | Sent as | Effect |
| --- | --- | --- |
| Project | `project_id` (area `project`) | The request's scope: its notes, articles, tasks and canvas |
| Note, note folder | `resource_ids` `note:<id>` (40 notes per folder at most) | Sources; a single note is also the default target of edits |
| Article, article folder | `paper_ids`, plus `paper:<id>` for articles with a PDF | The article corpus, with or without PDF |
| Collection | `collection_id`, `picked_collection` | Its schema and items are in the context |
| File | `resource_ids` `file:<path>` | Source |

`focus` lists the picked items (kind, title, count, `kavot://` address); the
prompt names them under "Context chosen by the user", so the agent can go
straight to `explore` or `read`. On the chat page, nothing is added
automatically: without picks the agent starts from the whole workspace with no
selected source.

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
extracted one in `explore` (with `summary_by`: engine, model, date), and section
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

## Limitations of this first integration

- The entry point is the local chat: there is no permanent endpoint yet to
  manually connect an assistant independent from Kavot.
- MCP is not a sandbox for the engine's native tools. Their code reading and web
  search capabilities remain subject to their own rules.
- Legacy `kavot-actions` blocks are still interpreted for resumed conversations,
  with scope checks, deduplication and the same cap as MCP. New instructions ask
  agents to use `propose_action`.
- A proposal never triggers a cloud call or a sync. Applying it uses the usual
  API and its sync behavior.

## Install and verify

Install the updated dependencies, then restart Kavot:

```sh
python -m pip install -e ".[desktop,dev]"
python -m pytest
```

`tests/core/test_mcp.py` runs the server in process on a temporary workspace:
tool budgets, compact schemas and results, write tools by area, search scope and
schema hints. Engine processes are not started: these tests use no model and do
not check CLI authentication or managed policies.

Integration references:

- [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk)
- [Codex MCP configuration](https://developers.openai.com/codex/mcp/)
- [Claude Code CLI](https://code.claude.com/docs/en/cli-reference)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [OpenCode MCP](https://opencode.ai/docs/mcp-servers/)
- [OpenCode configuration](https://opencode.ai/docs/config/)

## Organizing data after approval

`get_organization` provides the identifiers and the list of available actions.
Excluded notes stay inaccessible. Inside a project, destinations are limited to
that project; from the general view, agents can file items across projects.
Reading content stays in `read_source`.

Additional actions:

- `note_organize`, `note_delete`: title, project, folder, moving to the trash.
- `note_folder_create/update/delete` and `paper_folder_create/update/delete`:
  create, rename, move and delete folders.
- `paper_organize`: folders and projects linked to articles.
- `project_update/delete`, `paper_delete`, `task_delete`, `event_delete`,
  `dataset_delete`, `conference_delete`.
- `collection_create/update/delete`: personal collections; built-in collections
  cannot be deleted or renamed.
- `collection_folder_create/update/delete`, `record_organize/delete`: filing of
  records; deleting a folder keeps its records at the root.
- `file_create`: `.txt`, `.md` or `.csv` text file in the general notes or a
  project folder. `file_rename/move/delete`: selected files, using Kavot's usual
  operations and the trash.

Agents call the named domain tool or `propose_action`; they are never given an
approval tool. Deletions show their preview expanded and an explicit
“Approve the deletion” button. The app checks the affected objects, descendants
and files again before applying. A concurrent change invalidates the proposal;
a cascade that touches an excluded item is rejected.

After a folder or collection is created and approved, the agent calls
`get_organization` again to get its real identifier before proposing to file
items in it. If the run has already ended, send a new message for this step.
Proposals stay independent (30 at most), with no automatic application and no
global transaction across several proposals.

Example to organize articles: call `paper_folder_create` with
`request={"label":"Create the folder","values":{"name":"Research"}}`.
After approval, read `get_organization`, then create a subfolder with
`values={"name":"Methods","parent_id":<folder id>}`. Once it is approved,
`paper_organize` receives the article `id` and
`values={"folder_ids":[<subfolder id>]}`. `paper_folder_update` renames or moves
a folder through `parent_id`; `paper_folder_delete` deletes the hierarchy and
keeps the articles. The refreshed catalog also lets the agent propose a change
to the metadata of a newly imported article, with conflicts checked again when
applied.

Deleting projects and articles uses the existing domain deletions, including
their linked notes. Personal collections are kept under
`notes/.trash/<identifier>/<collection>` for manual recovery.

## Questions about an article pack and literature discovery

The following tools are available in both `/plan` and `/edit`:

| Tool | Use |
| --- | --- |
| `get_article_pack` | Full pack of the active tab, every page included; selection, filters, links, provider errors and pagination |
| `get_article_details` | Abstracts and metadata for up to eight references per call |
| `get_related_articles` | Earlier references and citing articles; pack ID, DOI or OpenAlex ID, current selection by default |
| `search_articles` | OpenAlex search from a question's keywords, up to 30 results |

The context contains every related article in `articles` and `candidates`.
`filtered_ids` only describes the visual filter; it never reduces the pack. The
initial catalog is not subject to the limit on results added by the agent's
searches. To analyze the whole pack, follow `next_offset` until `null`. Graph
shortcuts prepare a message in the assistant; the user can complete it before
sending. Enriched metadata and results stay specific to the request. Searches
follow the configured scholarly sources, the exclusions and a limit of 30
searches or enrichments per request. Keyword search requires OpenAlex to be
enabled.

The agent must justify the selection against the question, cite a DOI or URL
and state the limits of abstracts. Local full text remains available through
`read_source` when it is selected. These tools download no PDF and import no
article or citation link; any import remains a `paper_import` proposal to
approve.

References also accept variants of a known identifier: `doi:` prefix, DOI URL,
short OpenAlex ID or URL, and the local ID of an article in the context.
`get_article_details` keeps the valid results of a batch and returns unknown
identifiers in `errors`, with the instruction to read `get_article_pack`. If no
identifier is valid, MCP returns an explicit error to the agent instead of
hiding it behind an internal server error.
