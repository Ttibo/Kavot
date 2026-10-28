type Caret = { node: Text; offset: number };

/** Native selection otherwise snaps to whole text runs when dragging in page whitespace. */
export function precisePdfSelection(pages: HTMLElement, enabled: () => boolean) {
  let anchor: Caret | null = null;
  let range: Range | null = null;
  const caretAt = (event: PointerEvent): Caret | null => {
    const span = document.elementFromPoint(event.clientX, event.clientY)?.closest('.pdf-selectable-text span');
    if (!span || !pages.contains(span)) return null;
    const bounds = span.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return null;
    const hit = (document as Document & { caretRangeFromPoint(x: number, y: number): Range | null }).caretRangeFromPoint(event.clientX, event.clientY);
    if (!hit || hit.startContainer.nodeType !== Node.TEXT_NODE || !span.contains(hit.startContainer)) return null;
    return { node: hit.startContainer as Text, offset: hit.startOffset };
  };
  const clear = () => { anchor = null; range = null; window.getSelection()?.removeAllRanges(); };
  pages.addEventListener('pointerdown', event => {
    if (!enabled() || event.button !== 0) return;
    event.preventDefault(); clear();
    anchor = caretAt(event);
    if (anchor) window.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, anchor.node, anchor.offset);
  });
  pages.addEventListener('pointermove', event => {
    if (!anchor || !enabled()) return;
    if (!(event.buttons & 1)) { clear(); return; }
    event.preventDefault();
    const focus = caretAt(event);
    if (!focus) return; // Retain the last precise endpoint while outside the text.
    const selected = window.getSelection();
    selected?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    if (selected?.rangeCount) range = selected.getRangeAt(0).cloneRange();
  });
  pages.addEventListener('pointercancel', clear);
  return { clear, take() { const result = range; clear(); return result; } };
}

/** Only text-node rectangles: element rectangles include unselected whitespace and duplicates. */
export function selectedPdfTextRects(range: Range, pages: HTMLElement): DOMRect[] {
  const rects: DOMRect[] = [];
  const walker = document.createTreeWalker(pages, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.parentElement?.closest('.pdf-selectable-text') || !range.intersectsNode(node)) continue;
    const slice = document.createRange();
    slice.setStart(node, node === range.startContainer ? range.startOffset : 0);
    slice.setEnd(node, node === range.endContainer ? range.endOffset : node.textContent.length);
    if (!slice.collapsed) rects.push(...slice.getClientRects());
  }
  return rects;
}
