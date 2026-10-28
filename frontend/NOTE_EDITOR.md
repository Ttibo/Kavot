# Note editor

Notes are HTML documents edited with a rich editor. The toolbar groups text
formatting, paragraph options and insertion commands. Right-click (or
Shift+F10) opens the same commands for the current block. **Edit** and **Read**
switch between editing and a read-only rendering (Ctrl+E toggles them). Changes
are saved automatically.

The note text is 12 px by default and follows **Settings → General → Font
sizes → Notes and reading**.

## Blocks

- Drag the ⠿ handle on the left of a block to move it; click it for the block
  menu.
- Right-click any block → **Delete**. The label adapts to the block: line,
  image, table, script, collection view.
- **Insert → Divider line** (toolbar or right-click), or type `---` at the start
  of a line. Right-click the line → **Line style**: thin, thick, dashed, dotted,
  double, fade, ornament.
- Math is rendered locally with KaTeX: `$…$` or `\(…\)` inline, `$$…$$` or
  `\[…\]` for a block.

## Tables

- **Insert → Table** adds a table with a header row.
- Hovering a table shows **+** buttons on the right and below to append a
  column or a row.
- Tab moves to the next cell and adds a row at the end of the table; Shift+Tab
  goes back.
- Right-click a cell to add or delete rows and columns, merge or split cells,
  toggle the header row or column, and choose a **Table style**: Standard,
  Striped, Minimal, Compact, Colored header.

## Embedded collections

- **Insert → Collection** embeds a collection (notes, articles, tasks,
  conferences, datasets or a custom collection) as a **table**, **list**,
  **gallery** or **kanban** board.
- The ⚙ button of a view sets the displayed fields and their order, filters
  (contains, is, is not, is empty, greater/less than), sort order, kanban
  grouping, gallery card image, maximum number of items and the search field.
- In the kanban, dragging a card to another lane updates the item (tasks:
  column, priority; articles, conferences, datasets: status; custom collections:
  any simple field).
- Views stay live: they refresh when the collection changes, including in Read
  mode.

## Scripts

- **Insert → Script** opens the picker: a new script, a saved script or one of
  the examples.
- The script editor has HTML, CSS and JavaScript tabs and a live preview.
  **Save to library** makes the script reusable in other notes. A note keeps
  its own copy, so editing the library does not change existing notes.
- **Settings → Scripts** manages the library: create, edit (name, description,
  author, tags), duplicate, delete, add an example, import and export.
- Sharing: an export produces a `.kavot-scripts.json` file
  (`{"format": "kavot-scripts", "scripts": [...]}`). Each script has a stable
  `uid`, so importing a newer copy updates the existing one instead of creating
  a duplicate. The `source.kind = "online"` value is reserved for a future
  online library.
- Scripts run in an isolated frame (`sandbox`, opaque origin, CSP
  `connect-src 'none'`): they cannot reach the app, the local API or the
  network directly. Libraries can be imported from cdn.jsdelivr.net, unpkg.com,
  esm.sh or cdnjs.
- `kavot.fetch(url, options)` is the only way out: it goes through the local
  proxy (`POST /api/note-scripts/network/fetch`), which calls a URL only after
  the user approved it in a dialog. An approval covers scheme, host, port and
  path (not the query string), applies to every script, is stored in the local
  settings (`script_network`, never in the workspace or a shared script) and
  can be revoked in **Settings → Scripts**. Redirects are followed only towards
  approved URLs (otherwise the dialog opens again). Local and private addresses
  are always refused; no cookies are sent or kept; 1 MB per request, 5 MB per
  response, 20 s timeout.
- Available API:
  - `await kavot.collections()`: list of collections;
  - `await kavot.items('tasks')`: items with `title`, `detail` and `fields`;
  - `await kavot.note()`: title, text, word count and headings of the note;
  - `kavot.scrollTo(id)`: scrolls the note to a heading;
  - `kavot.open(item)`: opens an item in Kavot;
  - `kavot.toast('…')`: shows a notification;
  - `await kavot.fetch(url, options)`: like `fetch`, returns a `Response`.

  The theme's CSS variables (`var(--accent)`, `var(--line)`…) are available.
- In the HTML file, a script is stored as inert text
  (`<div data-type="script-block"><pre data-lang="js">…`), never as `<script>`.
- Built-in examples: task counter, bar chart, Pomodoro timer, table of
  contents, note statistics, upcoming deadlines, task progress, monthly
  calendar, countdown, reading list, sortable table, tag cloud, calculator.

## Collection items

- On the page of a collection (custom collections, Conferences, Datasets),
  clicking an item opens it in a side panel, in the note editor, beside the
  list. **Open in Notes** moves it to a Notes tab; elsewhere (canvas, links,
  Notes tree) items open in Notes directly.
- The item is laid out like an HTML page: collection name, title, a table of
  its fields, then the text of the note. The table scrolls with the page and is
  edited in place: choice fields are drop-down lists of their values, link
  fields have an **Open** button, list fields are small tables with
  **＋ Add a row** and a × per row (the deadlines of a conference are a list).
  Everything is saved automatically.
- Required fields are marked with `*`. While one is empty its row is outlined
  in red and the item is not saved; the status above the title names the
  missing fields.
- **New item** / **New conference** / **New dataset** only ask for the title
  (and the required fields without a default value), then open the item in the
  side panel.
- **Settings → Collections** lists Conferences, Datasets and your own
  collections; Articles, Notes and Tasks are always present. Creating or
  editing a collection defines its fields: name, type, required, default value,
  list of choices, and for **List** fields their columns (text, number,
  checkbox, date, link, email or choice). Fields can be reordered with ↑ ↓, and
  **Item page preview** shows how an item will look. **Delete** removes a
  collection: Conferences and Datasets keep their items and can be restored
  from the same page; a custom collection is moved to `databases/.trash/` in
  the storage folder.
