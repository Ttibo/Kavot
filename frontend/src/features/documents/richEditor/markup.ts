import { escapeHtml } from '../../../app/state';

export const dividerStyles: [string, string][] = [["", "Thin line"], ["thick", "Thick line"], ["dashed", "Dashed"], ["dotted", "Dotted"], ["double", "Double line"], ["fade", "Fade"], ["ornament", "Ornament ✦"]];

export const tableStyles: [string, string][] = [["", "Standard"], ["striped", "Striped"], ["minimal", "Minimal"], ["compact", "Compact"], ["accent", "Colored header"]];

const editorIcons: Record<string, string> = {
  bold: 'M6 4h7a4 4 0 0 1 0 8H6zM6 12h8a4 4 0 0 1 0 8H6z',
  italic: 'M10 4h9M5 20h9M15 4 9 20', underline: 'M6 3v8a6 6 0 0 0 12 0V3M4 21h16',
  strike: 'M18 5c-3-3-10-2-10 2 0 2 2 3 4 3M6 18c3 3 11 2 11-2 0-2-2-3-4-3M3 12h18',
  left: 'M4 5h16M4 10h10M4 15h16M4 20h10', center: 'M4 5h16M7 10h10M4 15h16M7 20h10', right: 'M4 5h16M10 10h10M4 15h16M10 20h10',
  list: 'M4 6h1M4 12h1M4 18h1M9 6h11M9 12h11M9 18h11', ordered: 'M3 4h2v5M3 9h4M3 14c4-2 4 2 0 5h4M10 6h10M10 12h10M10 18h10',
  quote: 'M4 6h6v8H4zM4 14v4h4M14 6h6v8h-6zM14 14v4h4',
  reference: 'M3 4h10v13H3zM6 8h4M6 12h4M13 7h8v13H11M16 11h2M16 15h2',
  link: 'm10 7 3-3a5 5 0 0 1 7 7l-3 3M14 17l-3 3a5 5 0 0 1-7-7l3-3M8 16l8-8',
  image: 'M3 3h18v18H3zM3 16l5-5 5 5 4-4 4 4M8 7h1', table: 'M3 4h18v16H3zM3 10h18M3 15h18M9 4v16M15 4v16',
  columns: 'M3 4h18v16H3zM12 4v16', undo: 'M8 4 3 9l5 5M3 9h11a6 6 0 0 1 0 12', redo: 'm16 4 5 5-5 5M21 9H10a6 6 0 0 0 0 12',
  codeBlock: 'M3 4h18v16H3zM9 9l-3 3 3 3M15 9l3 3-3 3',
  task: 'M4 4h16v16H4zM7 12l3 3 7-7', code: 'm8 6-6 6 6 6M16 6l6 6-6 6',
  aside: 'M3 4h18v16H3zM7 4v16M11 9h6M11 14h6', details: 'M3 4h18v16H3zM7 8l3 3-3 3M13 9h5',
  template: 'M5 3h14v18H5zM8 8h8M8 12h8M8 16h5',
  properties: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
  up: 'm6 10 6-6 6 6M12 4v16', down: 'm6 14 6 6 6-6M12 4v16',
  row: 'M3 4h18v16H3zM3 10h18M8 15h8M12 12v6', column: 'M3 4h18v16H3zM10 4v16M13 12h6M16 9v6',
  deleteRow: 'M3 4h18v16H3zM3 10h18M8 15h8', deleteColumn: 'M3 4h18v16H3zM10 4v16M13 12h6',
  merge: 'M3 4h18v16H3zM3 12h6m-3-3 3 3-3 3M21 12h-6m3-3-3 3 3 3', split: 'M3 4h18v16H3zM12 4v16M5 12h4M15 12h4',
  script: 'm8 6-6 6 6 6M16 6l6 6-6 6M13 4l-2 16',
  headerRow: 'M3 4h18v16H3zM3 9h18M5 6.5h14', headerColumn: 'M3 4h18v16H3zM9 4v16M6 6v12', tableStyle: 'M3 4h18v16H3zM3 10h18M3 15h18M12 4v16',
  deleteBlock: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3', divider: 'M3 12h18M7 7h10M7 17h10', dividerStyle: 'M3 12h4M10 12h4M17 12h4',
  live: 'm14 4 6 6M4 20l1-6L16 3l5 5L10 19z', edit: 'm14 4 6 6M4 20l1-6L16 3l5 5L10 19z', reading: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6', source: 'm8 6-6 6 6 6M16 6l6 6-6 6',
};

export const editorIcon = (name: string) => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${editorIcons[name] || editorIcons.properties}"/></svg>`;

export const fontFamilies: [string, string][] = [["system-ui", "Sans"], ["Georgia", "Serif"], ["monospace", "Mono"]];

export const fontSizes = [10, 12, 14, 16, 18, 20, 24, 32, 40, 48];

export const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

/** Label, icon and shortcut of each editor command, as shown in the right-click menu. */
export const commands: Record<string, [string, string?, string?]> = {
  bold: ["Bold", "bold", `${mod}B`], italic: ["Italic", "italic", `${mod}I`], underline: ["Underline", "underline", `${mod}U`],
  strike: ["Strikethrough", "strike", `${mod}Shift+S`], code: ["Inline code", "code"],
  clearFormat: ["Clear formatting", "strike"], color: ["Text color…", "properties"], highlight: ["Highlight…", "properties"],
  left: ["Align left", "left"], center: ["Center", "center"], right: ["Align right", "right"],
  list: ["Bulleted list", "list"], ordered: ["Numbered list", "ordered"], task: ["Task list", "task"], quote: ["Quote", "quote"], codeBlock: ["Code block", "codeBlock"],
  link: ["Link…", "link"], reference: ["Reference a note, an article or a task…", "reference"],
  image: ["Image…", "image"], table: ["Table", "table"], columns: ["Side by side", "columns"], aside: ["Callout", "aside"], details: ["Collapsible section", "details"],
  divider: ["Divider line", "divider"], script: ["Script…", "script"],
  row: ["Add a row", "row"], column: ["Add a column", "column"], deleteRow: ["Delete the row", "deleteRow"], deleteColumn: ["Delete the column", "deleteColumn"],
  merge: ["Merge cells", "merge"], split: ["Split cells", "split"], headerRow: ["Header row", "headerRow"], headerColumn: ["Header column", "headerColumn"],
  up: ["Move up", "up"], down: ["Move down", "down"], deleteBlock: ["Delete the block", "deleteBlock"],
  "link:open": ["Open", "link", `${mod}click`], "link:beside": ["Open beside", "columns", "Shift+click"], "link:edit": ["Edit the link…", "edit"],
  "link:copy": ["Copy the address", "link"], "link:remove": ["Remove the link", "deleteBlock"],
  "split:equal": ["Equal widths", "columns"], "split:add": ["Add a column", "column"], "split:removeColumn": ["Delete this column", "deleteColumn"],
  "split:unsplit": ["Unsplit (keep the content)", "columns"], "split:delete": ["Delete the split and its content", "deleteBlock"],
  "mode:reading": ["Reading mode", "reading", `${mod}E`], "mode:live": ["Edit the note", "live", `${mod}E`],
  template: ["Apply a template…", "template"], properties: ["Properties…", "properties"],
  undo: ["Undo", "undo", `${mod}Z`], redo: ["Redo", "redo", `${mod}Shift+Z`],
};

/** Controls without a place on screen: the menu opens them (colour pickers, image upload). */
const hiddenControls = () => `<div class="rich-hidden-controls" aria-hidden="true">
  <input type="color" data-format="color" tabindex="-1" value="#222222">
  <input type="color" data-format="highlight" tabindex="-1" value="#ffe58f">
  <input type="file" accept="image/*" data-image-upload tabindex="-1">
</div>`;

export const linkDialog = () => `<dialog class="rich-link"><div class="rich-dialog-body" role="group" aria-label="Insert a link">
  <h3>Insert a link</h3>
  <label>Link text<input name="text" placeholder="Text to show"></label>
  <label>Link address<input name="href" type="text" placeholder="https://…"></label>
  <p class="rich-link-hint">The link will be visible in the note. In reading mode, click it to open it.</p>
  <p role="alert" hidden></p>
  <div class="form-actions"><button type="button" data-cancel-link>Cancel</button><button type="button" data-insert-link>Insert</button></div>
</div></dialog>`;

export const referenceDialog = () => `<dialog class="rich-reference" aria-label="Insert a reference">
  <header><h3 data-reference-title>Insert a reference</h3><button type="button" data-reference-dialog-close aria-label="Close references">×</button></header>
  <p data-reference-intro>Choose a note, an article or a task to link from this note.</p>
  <div class="rich-reference-filters">
    <input type="search" data-reference-query aria-label="Search for a reference" placeholder="Search a title, an author…">
    <select data-reference-kind aria-label="Kind of reference"><option value="">Everything</option><option value="notes">Notes</option><option value="articles">Articles</option><option value="tasks">Tasks</option></select>
  </div>
  <small data-reference-count role="status"></small>
  <div class="rich-reference-results" data-reference-matches></div>
</dialog>`;

const templateDialog = () => `<dialog class="rich-template" aria-label="Apply a template"><div class="rich-dialog-body">
  <h3>Apply a template</h3>
  <label>Template<select name="template"></select></label>
  <p data-template-empty hidden>No templates available. Create one in Settings → Templates.</p>
  <div class="rich-template-preview markdown-preview" data-template-preview></div>
  <label>Mode<select name="mode"><option value="insert">Add to the end of the note</option><option value="replace">Replace the title and content</option></select></label>
  <p data-template-replace-warning hidden>The current content will be replaced by the template’s content.</p>
  <p role="status"></p>
  <div class="form-actions"><button type="button" data-dialog-cancel>Cancel</button><button type="button" data-apply-template>Apply the template</button></div>
</div></dialog>`;

const propertiesDialog = (helpId: string) => `<dialog class="rich-properties" aria-label="Document properties"><div class="rich-dialog-body">
  <h3>Document properties</h3>
  <p class="rich-property-intro">Information to describe your note and customize its appearance.</p>
  <fieldset><legend>Note organization</legend>
    <label>Tags<input name="tags" placeholder="research, method" aria-describedby="${helpId}"><small id="${helpId}">Keywords separated by commas.</small></label>
    <label>Status<select name="status"><option value="draft">Draft</option><option value="review">To review</option><option value="final">Final</option></select><small>A personal marker for the note’s progress.</small></label>
  </fieldset>
  <fieldset><legend>Page appearance</legend>
    <label>HTML file width<select name="width"><option value="narrow">Narrow</option><option value="comfortable">Comfortable</option><option value="wide">Wide</option></select><small>When the file is opened in a browser. The editor keeps its full width.</small></label>
    <label>Page background<select name="theme"><option value="paper">White</option><option value="cream">Cream</option><option value="slate">Blue gray</option></select><small>The background color, in the app and in the HTML file.</small></label>
  </fieldset>
  <p role="status"></p>
  <div class="form-actions"><button type="button" data-dialog-cancel>Cancel</button><button type="button" data-save-properties>Save</button></div>
</div></dialog>`;

/** Editor shell; bindMarkdownBlockEditor() later mounts Tiptap into .continuous-editor-host. */
export function markdownBlockEditorMarkup(
  content,
  {
    sourceId = "",
    sourceClass = "",
    editorId = "",
    assetBase = "",
    ariaLabel = "Document HTML",
    pageHeader = "",
  } = {},
) {
  const helpId = `${editorId || sourceId || "document"}-tags-help`;
  // A page header (trusted markup: title, properties) is laid out inside the page, above the
  // text, and scrolls with it in both the editing and the reading modes.
  const page = `<div class="continuous-editor-host"></div>
  <div class="continuous-reading markdown-preview" hidden></div>`;
  return `<div class="markdown-block-editor rich-editor ${pageHeader ? "has-page-header" : ""}" ${editorId ? `id="${escapeHtml(editorId)}"` : ""} data-asset-base="${escapeHtml(assetBase)}">
  ${hiddenControls()}
  ${linkDialog()}
  ${referenceDialog()}
  ${templateDialog()}
  ${propertiesDialog(helpId)}
  ${pageHeader ? `<div class="rich-page"><header class="rich-page-header">${pageHeader}</header>${page}</div>` : page}
  <div data-markdown-block="0" hidden><textarea class="markdown-block-input" hidden></textarea></div>
</div><textarea class="markdown-block-source ${sourceClass}" ${sourceId ? `id="${escapeHtml(sourceId)}"` : ""} aria-label="${escapeHtml(ariaLabel)}" hidden>${escapeHtml(String(content || ""))}</textarea>`;
}
