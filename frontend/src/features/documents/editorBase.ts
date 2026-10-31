/** The text each open note editor started from: loaded, set by the application, or last saved by itself.
 *
 * An editor saves only on top of that text. When the note changed elsewhere since (an agent applied a change,
 * another window or device saved it), the save is not sent: it would replace that change with an older text.
 * The editor is attached to its element, so an editor that was redrawn away keeps its own, older base. */
const bases = new WeakMap<Element, string>();

export function setEditorBase(editor: Element | null | undefined, content: string | null | undefined) {
  if (editor) bases.set(editor, content ?? '');
}

/** The note changed since this editor's base (compared with the latest known version of the note). */
export function changedSinceBase(editor: Element | null | undefined, latest: string | null | undefined) {
  if (!editor || !bases.has(editor) || typeof latest !== 'string') return false;
  return bases.get(editor) !== latest;
}
