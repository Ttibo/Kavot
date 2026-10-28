


/** Keep multiline Markdown constructs atomic in the visual editor. */
export function markdownTableCells(line: string): string[] {
  const text = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  const cells: string[] = [];
  let cell = "", escaped = false, code = false;
  for (const char of text) {
    if (char === "|" && !escaped && !code) { cells.push(cell.trim()); cell = ""; }
    else { cell += char; if (char === "`" && !escaped) code = !code; }
    escaped = char === "\\" && !escaped;
  }
  cells.push(cell.trim());
  return cells;
}

export function markdownTableStart(lines: string[], index: number): boolean {
  if (!lines[index]?.includes("|") || !lines[index + 1]) return false;
  const columns = markdownTableCells(lines[index]);
  const divider = markdownTableCells(lines[index + 1]);
  return columns.length === divider.length && divider.every(cell => /^:?-{3,}:?$/.test(cell));
}

export { bindMarkdownBlockEditor, currentMarkdownBlockInput, markdownBlockEditorMarkup, markdownBlockSourceOffset, setMarkdownBlockEditorContent } from './live-editor';

