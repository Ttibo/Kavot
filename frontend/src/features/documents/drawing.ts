import { modal } from '../../app/state';
import { editorSession } from '../../app/editorSession';
import { closeModal, openModal } from '../../components/dialogs/controller';
import { drawingEditorMarkup } from './drawingUI';
import { shapeById } from './drawingShapes';
import { drawingBounds, bounds, clone, emptyDrawing, isLine, localPoint, normalizePoints, parseDrawing, resizeElement, worldPoint, type Bounds, type DrawingDocument, type DrawingElement, type Point } from './drawingModel';
import { drawingImage, drawingPreviewPng, hitElement, paintDrawing, prepareDrawingImages } from './drawingRender';
import '../../styles/features/drawing.css';
export { emptyDrawing, drawingPreviewPng };
export type { DrawingDocument };

let drawingClipboard: DrawingElement[] = [];
const clamp = (n: number, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) => Math.max(min, Math.min(max, n));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const rotation = (n: number) => ((n + 540) % 360) - 180;
const angle = (p: Point, center: Point) => Math.atan2(p.y - center.y, p.x - center.x);
type Gesture = { mode: 'draw' | 'move' | 'box' | 'resize' | 'rotate'; start: Point; current: Point; before: DrawingDocument; selection: number[]; pointerId: number; handle?: string; box?: Bounds };

// Inline editors (drawing tabs) register here so navigation can save them before leaving.
const inlineDrawingFlushes = new Set<() => Promise<boolean>>();
export async function flushInlineDrawings() {
  await Promise.all([...inlineDrawingFlushes].map(flush => flush()));
}

/** Open the drawing studio in a modal, or inside `host` when the drawing lives in a workspace tab. */
export function openDrawingEditor(title: string, initial: DrawingDocument, onChange: (title: string, doc: DrawingDocument, preview: string) => void, save: () => Promise<void>, host?: HTMLElement) {
  let drawing: DrawingDocument;
  try { drawing = parseDrawing(initial); } catch { throw new Error('The drawing could not be opened. Its saved content has been preserved.'); }
  if (host) host.innerHTML = drawingEditorMarkup(title, drawing);
  else { openModal(drawingEditorMarkup(title, drawing), true); modal.classList.add('modal-drawing'); }
  const root = (host || modal).querySelector<HTMLElement>('.drawing-editor')!;
  if (host) { root.classList.add('drawing-editor-inline'); root.querySelector<HTMLElement>('[data-drawing-done]')!.hidden = true; }
  const get = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const all = <T extends HTMLElement = HTMLElement>(selector: string) => [...root.querySelectorAll<T>(selector)];
  const canvas = get<HTMLCanvasElement>('canvas'), paper = get('.drawing-paper');
  const titleInput = get<HTMLInputElement>('[data-drawing-title]'), textInput = get<HTMLTextAreaElement>('[data-drawing-text]');
  const stroke = get<HTMLInputElement>('[data-drawing-color]'), fill = get<HTMLInputElement>('[data-drawing-fill]'), status = get<HTMLButtonElement>('[data-drawing-status]');
  const zoomControl = get<HTMLSelectElement>('[data-drawing-zoom]');
  let camera = { x: 0, y: 0 }, pan: { x: number; y: number; pointerId: number } | null = null;
  let tool = 'select', selection = new Set<number>(), revision = 0, zoom = 1, grid = true, snap = false, category = 'Shapes';
  let timer: ReturnType<typeof setTimeout>, gesture: Gesture | null = null, pathDraft: { before: DrawingDocument; points: Point[]; index: number } | null = null;
  let pendingSave: Promise<boolean> | null = null, imageLoading = false;
  const undo: DrawingDocument[] = [], redo: DrawingDocument[] = [];
  const defaults: Partial<DrawingElement> = { color: '#334155', fill: '#e0e7ff', strokeWidth: 3, dash: 'solid', opacity: 100, fontFamily: 'Arial', fontSize: 24, textColor: '#334155', textAlign: 'center', verticalAlign: 'middle', startArrow: 'none', endArrow: 'none' };
  const selectedItems = () => [...selection].map(i => drawing.elements[i]).filter(Boolean);
  const selectedBox = () => selectedItems().length ? bounds(selectedItems()) : null;
  const point = (event: { clientX: number; clientY: number }, useSnap = false): Point => {
    const box = canvas.getBoundingClientRect();
    const p = { x: camera.x + (event.clientX - box.left) / zoom, y: camera.y + (event.clientY - box.top) / zoom };
    return useSnap && snap ? { x: Math.round(p.x / 20) * 20, y: Math.round(p.y / 20) * 20 } : p;
  };
  function fit() {
    const width = paper.clientWidth, height = paper.clientHeight;
    if (zoomControl.value === 'fit') {
      const frame = drawingBounds(drawing);
      zoom = Math.max(Number.EPSILON, Math.min(Math.max(1, width - 72) / frame.width, Math.max(1, height - 72) / frame.height, 1.5));
      camera = { x: frame.x + frame.width / 2 - width / zoom / 2, y: frame.y + frame.height / 2 - height / zoom / 2 };
    } else if (zoomControl.value !== 'custom') {
      const next = Number(zoomControl.value) / 100;
      camera.x += width / zoom / 2 - width / next / 2; camera.y += height / zoom / 2 - height / next / 2; zoom = next;
    }
  }
  function handles() {
    const box = selectedBox(); if (!box) return [];
    const one = selection.size === 1 ? selectedItems()[0] : null;
    const w = one ? one.width : box.width, h = one ? one.height : box.height;
    return [['nw', 0, 0], ['n', w / 2, 0], ['ne', w, 0], ['e', w, h / 2], ['se', w, h], ['s', w / 2, h], ['sw', 0, h], ['w', 0, h / 2], ['rotate', w / 2, -28 / zoom]].map(([id, x, y]) => ({ id: String(id), ...(one ? worldPoint(one, { x: Number(x), y: Number(y) }) : { x: box.x + Number(x), y: box.y + Number(y) }) }));
  }
  function render() {
    if (!root.isConnected) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(paper.clientWidth * ratio)), height = Math.max(1, Math.round(paper.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    paintDrawing(canvas, drawing, grid, { ...camera, zoom: zoom * ratio });
    const ctx = canvas.getContext('2d')!;
    ctx.save(); ctx.scale(zoom * ratio, zoom * ratio); ctx.translate(-camera.x, -camera.y); ctx.strokeStyle = '#4285f4'; ctx.fillStyle = '#ffffff'; ctx.lineWidth = 1.4 / zoom;
    for (const item of selectedItems()) {
      const corners = [{ x: 0, y: 0 }, { x: item.width, y: 0 }, { x: item.width, y: item.height }, { x: 0, y: item.height }].map(p => worldPoint(item, p));
      ctx.beginPath(); corners.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); ctx.stroke();
    }
    const grips = handles();
    if (grips.length) {
      if (selection.size > 1) { const b = selectedBox()!; ctx.strokeRect(b.x, b.y, b.width, b.height); }
      ctx.beginPath(); ctx.moveTo(grips[1].x, grips[1].y); ctx.lineTo(grips[8].x, grips[8].y); ctx.stroke();
      for (const grip of grips) { ctx.beginPath(); if (grip.id === 'rotate') ctx.arc(grip.x, grip.y, 4 / zoom, 0, Math.PI * 2); else ctx.rect(grip.x - 3.5 / zoom, grip.y - 3.5 / zoom, 7 / zoom, 7 / zoom); ctx.fill(); ctx.stroke(); }
    }
    if (gesture?.mode === 'box') {
      ctx.fillStyle = '#4285f41a'; ctx.setLineDash([4 / zoom, 3 / zoom]);
      const b = { x: Math.min(gesture.start.x, gesture.current.x), y: Math.min(gesture.start.y, gesture.current.y), width: Math.abs(gesture.start.x - gesture.current.x), height: Math.abs(gesture.start.y - gesture.current.y) };
      ctx.fillRect(b.x, b.y, b.width, b.height); ctx.strokeRect(b.x, b.y, b.width, b.height);
    }
    ctx.restore();
    get<HTMLButtonElement>('[data-drawing-undo]').disabled = !undo.length || !!gesture || !!pathDraft;
    get<HTMLButtonElement>('[data-drawing-redo]').disabled = !redo.length || !!gesture || !!pathDraft;
    get<HTMLButtonElement>('[data-drawing-delete]').disabled = !selection.size;
    all<HTMLButtonElement>('[data-drawing-command]').forEach(button => {
      const action = button.dataset.drawingCommand!;
      if (['copy', 'duplicate', 'delete', 'front', 'back', 'forward', 'backward', 'flip-x', 'flip-y', 'rotate'].includes(action) || action.startsWith('align-')) button.disabled = !selection.size;
      else if (action === 'group') button.disabled = selection.size < 2;
      else if (action === 'ungroup') button.disabled = !selectedItems().some(item => item.groupId);
      else if (action.startsWith('distribute-')) button.disabled = selection.size < 3;
      else if (action === 'undo') button.disabled = !undo.length || !!gesture || !!pathDraft;
      else if (action === 'redo') button.disabled = !redo.length || !!gesture || !!pathDraft;
    });
    get('[data-drawing-selection]').textContent = selection.size ? selection.size === 1 ? shapeById.get(selectedItems()[0].type)?.name || selectedItems()[0].type : `${selection.size} objects selected` : `${drawing.elements.length} objects · ${Math.round(zoom * 100)}%`;
  }
  function properties() {
    const item = selectedItems()[0];
    textInput.disabled = !item || selection.size !== 1 || item.type === 'image'; textInput.value = selection.size === 1 ? item?.text || '' : '';
    stroke.value = item?.color && item.color !== 'transparent' ? item.color : defaults.color!;
    fill.value = item?.fill && item.fill !== 'transparent' ? item.fill : defaults.fill === 'transparent' ? '#e0e7ff' : defaults.fill!;
    get<HTMLInputElement>('[data-drawing-transparent]').checked = (item?.fill ?? defaults.fill) === 'transparent';
    for (const key of ['x', 'y', 'width', 'height', 'rotation'] as const) {
      const input = get<HTMLInputElement>(`[data-drawing-${key}]`); input.disabled = selection.size !== 1;
      input.value = item && selection.size === 1 ? String(Math.round(item[key] || 0)) : '';
    }
    all<HTMLInputElement | HTMLSelectElement>('[data-drawing-style]').forEach(input => {
      const key = input.dataset.drawingStyle!;
      const fallback = key === 'endArrow' && item?.type === 'arrow' ? 'arrow' : key === 'textAlign' && item?.type === 'text' ? 'left' : defaults[key];
      const value = item?.[key] ?? fallback;
      if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = !!value;
      else input.value = String(value ?? '');
    });
    all('[data-drawing-toggle]').forEach(button => button.setAttribute('aria-pressed', String(!!(item?.[button.dataset.drawingToggle!] ?? defaults[button.dataset.drawingToggle!]))));
    get<HTMLInputElement>('[data-drawing-page-width]').value = String(drawing.width); get<HTMLInputElement>('[data-drawing-page-height]').value = String(drawing.height);
    get<HTMLInputElement>('[data-drawing-background]').value = drawing.background && drawing.background !== 'transparent' ? drawing.background : '#ffffff';
    get<HTMLInputElement>('[data-drawing-page-transparent]').checked = drawing.background === 'transparent';
  }
  async function persist(): Promise<boolean> {
    clearTimeout(timer);
    if (imageLoading) { status.textContent = 'Please wait for the image to load.'; return false; }
    if (pendingSave) { const result = await pendingSave; if (!result) return false; }
    const current = revision; status.textContent = 'Saving…';
    const operation = (async () => { try { await save(); if (current === revision) status.textContent = 'Saved'; return true; } catch { status.textContent = 'Save failed · click to retry'; return false; } })();
    pendingSave = operation; const result = await operation; if (pendingSave === operation) pendingSave = null;
    return result && current !== revision ? persist() : result;
  }
  function changed(before?: DrawingDocument) {
    if (before && same(before, drawing)) { render(); return; }
    try { parseDrawing(drawing); } catch (error) {
      if (before) drawing = before;
      selection = new Set([...selection].filter(i => i < drawing.elements.length));
      status.textContent = error.message; properties(); render(); return;
    }
    if (before) { undo.push(before); if (undo.length > 80) undo.shift(); redo.length = 0; }
    revision++; onChange(titleInput.value.trim() || 'Drawing', clone(drawing), drawingPreviewPng(drawing));
    status.textContent = 'Unsaved changes…'; clearTimeout(timer); timer = setTimeout(persist, 600); render();
  }
  function closePickers() {
    all<HTMLElement>('.drawing-popover').forEach(picker => { picker.hidden = true; });
    all('[data-drawing-show]').forEach(button => button.setAttribute('aria-expanded', 'false'));
  }
  function showPicker(name: string) {
    finishPath(); const picker = get(`#drawing-${name === 'shapes' ? 'shape' : 'line'}-picker`), show = picker.hidden;
    closePickers(); picker.hidden = !show; get(`[data-drawing-show="${name}"]`).setAttribute('aria-expanded', String(show));
    if (show && name === 'shapes') get<HTMLInputElement>('[data-drawing-shape-search]').focus();
  }
  function selectTool(next: string) {
    finishPath(); tool = next; closePickers();
    all('[data-drawing-tool]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.drawingTool === tool)));
    canvas.style.cursor = tool === 'hand' ? 'grab' : tool === 'select' ? 'default' : tool === 'text' ? 'text' : 'crosshair';
    get('[data-drawing-help]').textContent = ['polyline', 'curve'].includes(tool) ? 'Click to add points. Enter or double-click to finish. Escape to cancel.' : tool === 'hand' ? 'Drag to pan · Wheel to pan · Ctrl + wheel to zoom · Fit all to recenter' : tool === 'select' ? 'Drag background to pan · Shift-drag to select · Drag objects to move' : `${shapeById.get(tool)?.name || tool} · Drag to draw · Hold Shift to constrain proportions`;
  }
  function mutate(change: () => void, refresh = true) { if (gesture || pathDraft) return; const before = clone(drawing); change(); changed(before); if (refresh) properties(); }
  function editStyle(key: string, value: any, refresh = false) {
    defaults[key] = value;
    mutate(() => selectedItems().forEach(item => { item[key] = value; }), refresh);
  }
  function grouped(index: number) {
    const group = drawing.elements[index]?.groupId;
    return group ? drawing.elements.map((item, i) => item.groupId === group ? i : -1).filter(i => i >= 0) : [index];
  }
  function hit(p: Point) { for (let i = drawing.elements.length - 1; i >= 0; i--) if (hitElement(canvas.getContext('2d')!, drawing.elements[i], p, 6 / zoom)) return i; return -1; }
  function newElement(type: string, p: Point): DrawingElement {
    return { ...clone(defaults), type, x: p.x, y: p.y, width: type === 'text' ? 240 : 0, height: type === 'text' ? 80 : 0, color: stroke.value, fill: get<HTMLInputElement>('[data-drawing-transparent]').checked ? 'transparent' : fill.value, text: type === 'text' ? 'Text' : '', ...(type === 'arrow' ? { endArrow: defaults.endArrow === 'none' ? 'arrow' : defaults.endArrow } : {}), ...(type === 'text' ? { textAlign: 'left', fill: 'transparent' } : {}), ...(['pen', 'polyline', 'curve'].includes(type) ? { points: [{ x: 0, y: 0 }] } : {}) };
  }
  function finishPath(cancel = false) {
    if (!pathDraft) return;
    const draft = pathDraft; pathDraft = null;
    if (cancel || draft.points.length < 2) { drawing = draft.before; selection.clear(); }
    else { const item = drawing.elements[draft.index]; item.points = draft.points; normalizePoints(item); changed(draft.before); }
    properties(); render();
  }
  canvas.addEventListener('contextmenu', event => {
    if (gesture || pan || imageLoading) return;
    const index = hit(point(event));
    if (index < 0) selection.clear();
    else if (!selection.has(index)) selection = new Set(grouped(index));
    properties(); render();
  });
  canvas.addEventListener('pointerdown', event => {
    if (gesture || pan || imageLoading) return;
    if (event.button === 1 || (event.button === 0 && tool === 'hand')) {
      event.preventDefault(); canvas.focus(); pan = { x: event.clientX, y: event.clientY, pointerId: event.pointerId }; canvas.setPointerCapture(event.pointerId); canvas.style.cursor = 'grabbing'; return;
    }
    if (event.button !== 0) return;
    event.preventDefault(); canvas.focus(); closePickers(); const start = point(event, true);
    if (['polyline', 'curve'].includes(tool)) {
      if (!pathDraft) {
        if (drawing.elements.length >= 2000) return;
        const before = clone(drawing); drawing.elements.push(newElement(tool, start));
        pathDraft = { before, points: [{ x: 0, y: 0 }], index: drawing.elements.length - 1 }; selection = new Set([pathDraft.index]);
      } else {
        const item = drawing.elements[pathDraft.index], p = { x: start.x - item.x, y: start.y - item.y }, last = pathDraft.points.at(-1)!;
        if (Math.hypot(last.x - p.x, last.y - p.y) > 1 && pathDraft.points.length < 20000) pathDraft.points.push(p);
        item.points = [...pathDraft.points];
      }
      render(); return;
    }
    const before = clone(drawing), original = [...selection];
    if (tool === 'select') {
      const grip = handles().find(handle => Math.hypot(start.x - handle.x, start.y - handle.y) <= 7 / zoom);
      if (grip && selection.size) gesture = { mode: grip.id === 'rotate' ? 'rotate' : 'resize', start, current: start, before, selection: original, pointerId: event.pointerId, handle: grip.id, box: selectedBox()! };
      else {
        let index = hit(start);
        // A selected object's interior stays draggable, including sparse strokes.
        const selectedBounds = selectedBox();
        if (index < 0 && selectedBounds && start.x >= selectedBounds.x && start.x <= selectedBounds.x + selectedBounds.width && start.y >= selectedBounds.y && start.y <= selectedBounds.y + selectedBounds.height)
          index = [...selection][0];
        if (index < 0) {
          if (!event.shiftKey) {
            selection.clear(); pan = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
            canvas.setPointerCapture(event.pointerId); canvas.style.cursor = 'grabbing'; properties(); render(); return;
          }
          gesture = { mode: 'box', start, current: start, before, selection: original, pointerId: event.pointerId };
        }
        else {
          const indexes = grouped(index);
          if (event.shiftKey) indexes.forEach(i => selection.has(i) ? selection.delete(i) : selection.add(i));
          else if (!selection.has(index)) selection = new Set(indexes);
          if (event.altKey && selection.size && drawing.elements.length + selection.size <= 2000) { const copies = clone(selectedItems()); const groupMap = new Map<string, string>(); copies.forEach(item => { if (item.groupId) { if (!groupMap.has(item.groupId)) groupMap.set(item.groupId, crypto.randomUUID()); item.groupId = groupMap.get(item.groupId); } }); selection = new Set(copies.map((_, i) => drawing.elements.length + i)); drawing.elements.push(...copies); }
          gesture = { mode: 'move', start, current: start, before, selection: [...selection], pointerId: event.pointerId };
        }
      }
    } else {
      if (drawing.elements.length >= 2000) { status.textContent = 'This drawing has reached its limit of 2,000 elements.'; return; }
      drawing.elements.push(newElement(tool, start)); selection = new Set([drawing.elements.length - 1]);
      gesture = { mode: 'draw', start, current: start, before, selection: [...selection], pointerId: event.pointerId };
    }
    // Snapshot the selected originals, including an Alt-drag copy, for stable pointer transforms.
    if (gesture.mode === 'move' && drawing.elements.length !== before.elements.length) (gesture as any).copies = clone(drawing.elements);
    canvas.setPointerCapture(event.pointerId); properties(); render();
  });
  canvas.addEventListener('pointermove', event => {
    if (pan) {
      if (event.pointerId !== pan.pointerId) return;
      camera.x -= (event.clientX - pan.x) / zoom; camera.y -= (event.clientY - pan.y) / zoom;
      pan.x = event.clientX; pan.y = event.clientY; zoomControl.value = 'custom'; render(); return;
    }
    const p = point(event, !!gesture || !!pathDraft);
    if (pathDraft) { const item = drawing.elements[pathDraft.index]; item.points = [...pathDraft.points, { x: p.x - item.x, y: p.y - item.y }]; render(); return; }
    if (!gesture) {
      const grip = tool === 'select' && handles().find(handle => Math.hypot(p.x - handle.x, p.y - handle.y) <= 7 / zoom);
      canvas.style.cursor = grip ? grip.id === 'rotate' ? 'grab' : `${grip.id}-resize` : tool === 'hand' ? 'grab' : tool === 'select' ? hit(p) >= 0 ? 'move' : 'grab' : 'crosshair'; return;
    }
    if (event.pointerId !== gesture.pointerId) return;
    gesture.current = p; const dx = p.x - gesture.start.x, dy = p.y - gesture.start.y;
    if (gesture.mode === 'draw') {
      const item = selectedItems()[0];
      if (item.type === 'pen') { if (item.points!.length < 20000) item.points!.push({ x: dx, y: dy }); }
      else if (item.type !== 'text') {
        let w = dx, h = dy;
        if (event.shiftKey) {
          if (isLine(item.type)) { const a = Math.round(Math.atan2(h, w) / (Math.PI / 4)) * Math.PI / 4, length = Math.hypot(w, h); w = Math.cos(a) * length; h = Math.sin(a) * length; }
          else { w = Math.sign(w || 1) * Math.max(Math.abs(w), Math.abs(h)); h = Math.sign(h || 1) * Math.abs(w); }
        }
        if (isLine(item.type)) { item.width = w; item.height = h; }
        else { item.x = gesture.start.x + Math.min(0, w); item.y = gesture.start.y + Math.min(0, h); item.width = Math.abs(w); item.height = Math.abs(h); }
      }
    } else if (gesture.mode === 'move') {
      for (const i of gesture.selection) { const original = ((gesture as any).copies || gesture.before.elements)[i]; drawing.elements[i].x = clamp(original.x + dx); drawing.elements[i].y = clamp(original.y + dy); }
    } else if (gesture.mode === 'rotate') {
      const box = gesture.box!, center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      let delta = (angle(p, center) - angle(gesture.start, center)) * 180 / Math.PI; if (event.shiftKey) delta = Math.round(delta / 15) * 15;
      for (const i of gesture.selection) {
        const original = gesture.before.elements[i], item = drawing.elements[i], a = delta * Math.PI / 180, cx = original.x + original.width / 2 - center.x, cy = original.y + original.height / 2 - center.y;
        item.x = center.x + cx * Math.cos(a) - cy * Math.sin(a) - item.width / 2; item.y = center.y + cx * Math.sin(a) + cy * Math.cos(a) - item.height / 2; item.rotation = rotation((original.rotation || 0) + delta);
      }
    } else if (gesture.mode === 'resize') {
      const originals = gesture.selection.map(i => gesture!.before.elements[i]), original = originals[0], single = originals.length === 1 && !isLine(original.type), b = gesture.box!, handle = gesture.handle!;
      const current = single ? localPoint(original, p) : { x: p.x - b.x, y: p.y - b.y };
      const w = single ? original.width : b.width, h = single ? original.height : b.height;
      let left = handle.includes('w') ? Math.min(current.x, w - 8) : 0, top = handle.includes('n') ? Math.min(current.y, h - 8) : 0;
      let width = handle.includes('e') ? Math.max(8, current.x) : w - left, height = handle.includes('s') ? Math.max(8, current.y) : h - top;
      if ((event.shiftKey || get<HTMLInputElement>('[data-drawing-lock-ratio]').checked) && w && h) { height = width * h / w; if (handle.includes('n')) top = h - height; }
      width = Math.min(2400, width); height = Math.min(2400, height);
      if (single) {
        const item = drawing.elements[gesture.selection[0]], center = worldPoint(original, { x: left + width / 2, y: top + height / 2 });
        Object.assign(item, clone(original)); resizeElement(item, width, height); item.x = center.x - width / 2; item.y = center.y - height / 2;
      } else gesture.selection.forEach(i => { const item = drawing.elements[i], old = gesture!.before.elements[i]; Object.assign(item, clone(old)); const sx = w ? width / w : 1, sy = h ? height / h : 1; item.x = b.x + left + (old.x - b.x) * sx; item.y = b.y + top + (old.y - b.y) * sy; resizeElement(item, old.width * sx, old.height * sy); });
    }
    render();
  });
  function finishGesture(cancel = false) {
    if (!gesture) return;
    const action = gesture; gesture = null;
    if (cancel) { drawing = action.before; selection = new Set(action.selection.filter(i => i < drawing.elements.length)); }
    else if (action.mode === 'box') {
      const x = Math.min(action.start.x, action.current.x), y = Math.min(action.start.y, action.current.y), right = Math.max(action.start.x, action.current.x), bottom = Math.max(action.start.y, action.current.y);
      selection = new Set(action.selection);
      if (right - x > 3 || bottom - y > 3) drawing.elements.forEach((item, i) => { const b = bounds([item]); if (b.x >= x && b.y >= y && b.x + b.width <= right && b.y + b.height <= bottom) grouped(i).forEach(j => selection.add(j)); });
    } else {
      if (action.mode === 'draw') {
        const item = selectedItems()[0];
        if (item.type === 'pen') normalizePoints(item);
        if (item.type !== 'text' && Math.abs(item.width) + Math.abs(item.height) < 5) {
          if (item.type === 'pen') { drawing = action.before; selection.clear(); }
          else { item.width = 180; item.height = isLine(item.type) ? 0 : 120; }
        }
        if (tool !== 'pen') selectTool('select');
      }
      changed(action.before);
    }
    if (canvas.hasPointerCapture(action.pointerId)) canvas.releasePointerCapture(action.pointerId);
    properties(); render();
  }
  function finishPan() {
    if (!pan) return;
    const pointerId = pan.pointerId; pan = null;
    if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    canvas.style.cursor = tool === 'hand' || tool === 'select' ? 'grab' : 'crosshair';
  }
  canvas.addEventListener('pointerup', () => { finishPan(); finishGesture(); });
  canvas.addEventListener('pointercancel', () => { finishPan(); finishGesture(true); });
  canvas.addEventListener('wheel', event => {
    event.preventDefault(); if (gesture || pan || pathDraft) return;
    if (event.ctrlKey || event.metaKey) {
      const anchor = point(event), box = canvas.getBoundingClientRect();
      zoom = Math.max(.01, Math.min(8, zoom * Math.exp(-event.deltaY * .002)));
      camera = { x: anchor.x - (event.clientX - box.left) / zoom, y: anchor.y - (event.clientY - box.top) / zoom };
    } else { camera.x += (event.shiftKey ? event.deltaY : event.deltaX) / zoom; camera.y += (event.shiftKey ? 0 : event.deltaY) / zoom; }
    zoomControl.value = 'custom'; render();
  }, { passive: false });
  canvas.addEventListener('dblclick', () => { if (pathDraft) { finishPath(); selectTool('select'); } else if (selection.size === 1 && !textInput.disabled) { textInput.closest('details')!.open = true; textInput.focus(); textInput.select(); } });
  function history(from: DrawingDocument[], to: DrawingDocument[]) {
    if (gesture || pathDraft || !from.length) return;
    to.push(clone(drawing)); drawing = from.pop()!; selection = new Set([...selection].filter(i => i < drawing.elements.length)); fit(); properties(); changed();
  }
  function remove() { if (!selection.size) return; mutate(() => { drawing.elements = drawing.elements.filter((_, i) => !selection.has(i)); selection.clear(); }); }
  function paste(items = drawingClipboard) {
    if (!items.length || items.length + drawing.elements.length > 2000) return;
    mutate(() => {
      const copies = clone(items), groups = new Map<string, string>();
      copies.forEach(item => { item.x = clamp(item.x + 20); item.y = clamp(item.y + 20); if (item.groupId) { if (!groups.has(item.groupId)) groups.set(item.groupId, crypto.randomUUID()); item.groupId = groups.get(item.groupId); } });
      selection = new Set(copies.map((_, i) => drawing.elements.length + i)); drawing.elements.push(...copies);
    });
  }
  function arrange(action: string) {
    if (!selection.size) return;
    const chosen = selectedItems();
    mutate(() => {
      const b = bounds(chosen);
      if (['front', 'back', 'forward', 'backward'].includes(action)) {
        if (action === 'front' || action === 'back') { const rest = drawing.elements.filter(item => !chosen.includes(item)); drawing.elements = action === 'front' ? [...rest, ...chosen] : [...chosen, ...rest]; }
        else {
          const step = action === 'forward' ? 1 : -1, indices = [...selection].sort((a, b) => step > 0 ? b - a : a - b);
          for (const i of indices) if (drawing.elements[i + step] && !chosen.includes(drawing.elements[i + step])) [drawing.elements[i], drawing.elements[i + step]] = [drawing.elements[i + step], drawing.elements[i]];
        }
        selection = new Set(drawing.elements.map((item, i) => chosen.includes(item) ? i : -1).filter(i => i >= 0));
      } else if (action === 'group' && chosen.length > 1) { const id = crypto.randomUUID(); chosen.forEach(item => { item.groupId = id; }); }
      else if (action === 'ungroup') chosen.forEach(item => { delete item.groupId; });
      else if (action === 'flip-x' || action === 'flip-y') chosen.forEach(item => { const key = action === 'flip-x' ? 'flipX' : 'flipY'; item[key] = !item[key]; });
      else if (action === 'rotate') chosen.forEach(item => { item.rotation = rotation((item.rotation || 0) + 90); });
      else if (action.startsWith('align-')) {
        const target = chosen.length === 1 ? { x: 0, y: 0, width: drawing.width, height: drawing.height } : b;
        chosen.forEach(item => { const own = bounds([item]);
          if (action === 'align-left') item.x += target.x - own.x;
          if (action === 'align-center') item.x += target.x + target.width / 2 - own.x - own.width / 2;
          if (action === 'align-right') item.x += target.x + target.width - own.x - own.width;
          if (action === 'align-top') item.y += target.y - own.y;
          if (action === 'align-middle') item.y += target.y + target.height / 2 - own.y - own.height / 2;
          if (action === 'align-bottom') item.y += target.y + target.height - own.y - own.height;
        });
      } else if (action.startsWith('distribute-') && chosen.length > 2) {
        const axis = action === 'distribute-x' ? 'x' : 'y', dimension = axis === 'x' ? 'width' : 'height';
        const sorted = [...chosen].sort((a, c) => bounds([a])[axis] - bounds([c])[axis]), boxes = sorted.map(item => bounds([item]));
        const spacing = (b[dimension] - boxes.reduce((sum, box) => sum + box[dimension], 0)) / (chosen.length - 1);
        let cursor = b[axis]; sorted.forEach((item, i) => { item[axis] += cursor - boxes[i][axis]; cursor += boxes[i][dimension] + spacing; });
      }
      chosen.forEach(item => { item.x = clamp(item.x); item.y = clamp(item.y); });
    });
  }
  const download = (href: string, extension: string) => {
    const link = document.createElement('a'); link.href = href; link.download = `${(titleInput.value || 'Drawing').replace(/[^\p{L}\p{N} _-]/gu, '_')}${extension}`; link.click();
  };
  function exportSource() {
    finishGesture(); finishPath();
    const url = URL.createObjectURL(new Blob([JSON.stringify(drawing, null, 2)], { type: 'application/json' }));
    download(url, '.drawing.json'); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function exportImage(format: 'jpeg' | 'png') { finishGesture(); finishPath(); try { await prepareDrawingImages(drawing); download(drawingImage(drawing, format), format === 'jpeg' ? '.jpg' : '.png'); } catch (error) { status.textContent = error.message; } }
  const fileInput = get<HTMLInputElement>('[data-drawing-file]'), imageInput = get<HTMLInputElement>('[data-drawing-image-file]');
  const commands: Record<string, () => unknown> = {
    undo: () => history(undo, redo), redo: () => history(redo, undo), delete: remove,
    copy: () => { drawingClipboard = clone(selectedItems()); }, paste: () => paste(), duplicate: () => paste(selectedItems()),
    'select-all': () => { finishPath(); selectTool('select'); selection = new Set(drawing.elements.map((_, i) => i)); properties(); render(); },
    fit: () => { zoomControl.value = 'fit'; fit(); render(); }, 'actual-size': () => { zoomControl.value = '100'; fit(); render(); },
    image: () => imageInput.click(), import: () => fileInput.click(), source: exportSource, png: () => exportImage('png'), jpeg: () => exportImage('jpeg'),
    shapes: () => showPicker('shapes'), lines: () => showPicker('lines'), text: () => selectTool('text'),
    'page-setup': () => { const panel = get<HTMLDetailsElement>('[data-drawing-page-panel]'); panel.open = true; panel.scrollIntoView({ block: 'nearest' }); get('[data-drawing-page-width]').focus(); },
  };
  root.addEventListener('click', event => {
    const target = event.target as HTMLElement, button = target.closest<HTMLElement>('[data-drawing-command]');
    if (button) { const action = button.dataset.drawingCommand!; all<HTMLDetailsElement>('.drawing-menubar details').forEach(menu => { menu.open = false; }); (commands[action] || (() => arrange(action)))(); }
    if (!target.closest('.drawing-popover, [data-drawing-show], [data-drawing-command]')) closePickers();
  });
  all<HTMLDetailsElement>('.drawing-menubar details').forEach(menu => menu.querySelector('summary')!.addEventListener('click', () => all<HTMLDetailsElement>('.drawing-menubar details').filter(other => other !== menu).forEach(other => { other.open = false; })));
  all('[data-drawing-tool]').forEach(button => button.addEventListener('click', () => selectTool(button.dataset.drawingTool!)));
  all('[data-drawing-show]').forEach(button => button.addEventListener('click', () => showPicker(button.dataset.drawingShow!)));
  all('[data-drawing-shape]').forEach(button => button.addEventListener('click', () => selectTool(button.dataset.drawingShape!)));
  all('[data-drawing-line]').forEach(button => button.addEventListener('click', () => selectTool(button.dataset.drawingLine!)));
  get('[data-drawing-dismiss]').addEventListener('click', closePickers);
  function filterShapes() {
    const query = get<HTMLInputElement>('[data-drawing-shape-search]').value.trim().toLowerCase(); let visible = 0;
    all('[data-drawing-shape]').forEach(button => { button.hidden = query ? !`${button.getAttribute('aria-label')} ${button.dataset.category}`.toLowerCase().includes(query) : button.dataset.category !== category; if (!button.hidden) visible++; });
    get('[data-drawing-no-shapes]').hidden = !!visible;
  }
  get('[data-drawing-shape-search]').addEventListener('input', filterShapes);
  all('[data-drawing-category]').forEach(button => button.addEventListener('click', () => {
    category = button.dataset.drawingCategory!; get<HTMLInputElement>('[data-drawing-shape-search]').value = '';
    all('[data-drawing-category]').forEach(item => item.setAttribute('aria-pressed', String(item === button))); filterShapes();
  }));
  titleInput.addEventListener('input', () => changed());
  textInput.addEventListener('input', () => mutate(() => { const item = selectedItems()[0]; if (item) item.text = textInput.value.slice(0, 10000); }, false));
  stroke.addEventListener('input', () => editStyle('color', stroke.value)); fill.addEventListener('input', () => { get<HTMLInputElement>('[data-drawing-transparent]').checked = false; editStyle('fill', fill.value); });
  get<HTMLInputElement>('[data-drawing-transparent]').addEventListener('change', event => editStyle('fill', (event.target as HTMLInputElement).checked ? 'transparent' : fill.value));
  all<HTMLInputElement | HTMLSelectElement>('[data-drawing-style]').forEach(input => input.addEventListener(input instanceof HTMLInputElement && input.type === 'color' ? 'input' : 'change', () => {
    if (!input.checkValidity()) return;
    const key = input.dataset.drawingStyle!, value = input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked : ['strokeWidth', 'fontSize', 'opacity'].includes(key) ? Number(input.value) : input.value;
    editStyle(key, value);
  }));
  all('[data-drawing-toggle]').forEach(button => button.addEventListener('click', () => editStyle(button.dataset.drawingToggle!, button.getAttribute('aria-pressed') !== 'true', true)));
  for (const key of ['x', 'y', 'width', 'height', 'rotation'] as const) {
    const input = get<HTMLInputElement>(`[data-drawing-${key}]`);
    input.addEventListener('change', () => { if (!input.value || !input.validity.valid || selection.size !== 1) return;
      mutate(() => { const item = selectedItems()[0], value = Number(input.value);
        if (key === 'width' || key === 'height') {
          let w = key === 'width' ? value : item.width, h = key === 'height' ? value : item.height;
          if (get<HTMLInputElement>('[data-drawing-lock-ratio]').checked && item.width && item.height) { if (key === 'width') h = clamp(value * item.height / item.width, -2400, 2400); else w = clamp(value * item.width / item.height, -2400, 2400); }
          resizeElement(item, w, h);
        } else item[key] = value;
      });
    });
  }
  for (const key of ['width', 'height'] as const) get<HTMLInputElement>(`[data-drawing-page-${key}]`).addEventListener('change', event => { const input = event.target as HTMLInputElement; if (input.value && input.validity.valid) { mutate(() => { drawing[key] = Number(input.value); }); fit(); render(); } });
  get<HTMLInputElement>('[data-drawing-background]').addEventListener('input', event => { get<HTMLInputElement>('[data-drawing-page-transparent]').checked = false; mutate(() => { drawing.background = (event.target as HTMLInputElement).value; }, false); });
  get<HTMLInputElement>('[data-drawing-page-transparent]').addEventListener('change', event => mutate(() => { drawing.background = (event.target as HTMLInputElement).checked ? 'transparent' : get<HTMLInputElement>('[data-drawing-background]').value; }));
  zoomControl.addEventListener('change', () => { fit(); render(); });
  get<HTMLInputElement>('[data-drawing-grid]').addEventListener('change', event => { grid = (event.target as HTMLInputElement).checked; render(); });
  get<HTMLInputElement>('[data-drawing-snap]').addEventListener('change', event => { snap = (event.target as HTMLInputElement).checked; });
  for (const action of ['undo', 'redo', 'delete', 'import', 'source', 'png', 'jpeg', 'image']) get(`[data-drawing-${action}]`).addEventListener('click', () => commands[action]());
  root.addEventListener('keydown', event => {
    const target = event.target as HTMLElement, input = !!target.closest('input, textarea, select'), modifier = event.ctrlKey || event.metaKey;
    if (event.key === 'Escape') {
      const open = all<HTMLElement>('.drawing-popover').some(item => !item.hidden) || all<HTMLDetailsElement>('.drawing-menubar details').some(item => item.open);
      if (gesture || pathDraft || open) { event.preventDefault(); event.stopPropagation(); finishGesture(true); finishPath(true); closePickers(); all<HTMLDetailsElement>('.drawing-menubar details').forEach(item => { item.open = false; }); return; }
      if (selection.size && !input) { event.preventDefault(); selection.clear(); properties(); render(); return; }
    }
    if (modifier && event.key.toLowerCase() === 's') { event.preventDefault(); finishGesture(); finishPath(); void persist(); return; }
    if (input) return;
    if (pathDraft && event.key === 'Enter') { event.preventDefault(); finishPath(); selectTool('select'); return; }
    if (gesture || pathDraft) return;
    const key = event.key.toLowerCase();
    if (modifier) {
      const action = key === 'z' ? event.shiftKey ? 'redo' : 'undo' : key === 'y' ? 'redo' : key === 'd' ? 'duplicate' : key === 'a' ? 'select-all' : key === 'g' ? event.shiftKey ? 'ungroup' : 'group' : '';
      if (action) { event.preventDefault(); (commands[action] || (() => arrange(action)))(); }
    } else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove(); }
    else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && selection.size) {
      event.preventDefault(); const step = event.shiftKey ? 10 : 1;
      mutate(() => selectedItems().forEach(item => { item.x = clamp(item.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0)); item.y = clamp(item.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0)); }));
    } else { const next = { v: 'select', r: 'rectangle', o: 'ellipse', t: 'text', a: 'arrow', l: 'line', p: 'pen' }[key]; if (next) { event.preventDefault(); selectTool(next); } }
  });
  canvas.addEventListener('copy', event => { if (!selection.size) return; event.preventDefault(); drawingClipboard = clone(selectedItems()); event.clipboardData?.setData('text/plain', JSON.stringify({ kind: 'kavot-drawing-selection', elements: drawingClipboard })); });
  canvas.addEventListener('cut', event => { if (!selection.size) return; event.preventDefault(); drawingClipboard = clone(selectedItems()); event.clipboardData?.setData('text/plain', JSON.stringify({ kind: 'kavot-drawing-selection', elements: drawingClipboard })); remove(); });
  canvas.addEventListener('paste', event => {
    event.preventDefault(); const image = [...(event.clipboardData?.files || [])].find(file => file.type.startsWith('image/')); if (image) { void insertImage(image); return; }
    const text = event.clipboardData?.getData('text/plain');
    if (text) { try { const value = JSON.parse(text); if (value.kind === 'kavot-drawing-selection') { paste(parseDrawing({ ...emptyDrawing(), elements: value.elements }).elements); return; } } catch { /* Normal text can be pasted into the label field. */ } }
    paste();
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0]; if (!file) return;
    try {
      if (file.size > 8_000_000) throw new Error('Drawing files must be smaller than 8 MB.');
      const imported = parseDrawing(JSON.parse(await file.text())); await prepareDrawingImages(imported);
      if (!root.isConnected) return;
      finishGesture(); finishPath(); const before = clone(drawing); drawing = imported; selection.clear(); fit(); properties(); changed(before);
    } catch (error) { status.textContent = error.message; } fileInput.value = '';
  });
  async function insertImage(file: File) {
    if (imageLoading || drawing.elements.length >= 2000) return;
    imageLoading = true; status.textContent = 'Loading image…';
    try {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 4_000_000) throw new Error('Choose a PNG, JPEG or WebP image smaller than 4 MB.');
      const url = URL.createObjectURL(file), image = new Image();
      try {
        image.src = url; await image.decode();
        const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight)), raster = document.createElement('canvas');
        raster.width = Math.max(1, Math.round(image.naturalWidth * scale)); raster.height = Math.max(1, Math.round(image.naturalHeight * scale)); raster.getContext('2d')!.drawImage(image, 0, 0, raster.width, raster.height);
        const fitScale = Math.min(1, drawing.width * .7 / raster.width, drawing.height * .7 / raster.height), width = raster.width * fitScale, height = raster.height * fitScale;
        const item: DrawingElement = { type: 'image', x: camera.x + paper.clientWidth / zoom / 2 - width / 2, y: camera.y + paper.clientHeight / zoom / 2 - height / 2, width, height, color: '#334155', fill: 'transparent', strokeWidth: 0, text: '', imageData: raster.toDataURL('image/png') };
        const candidate = parseDrawing({ ...drawing, elements: [...drawing.elements, item] }); await prepareDrawingImages(candidate);
        if (!root.isConnected) return;
        finishGesture(); finishPath(); mutate(() => { selection = new Set([drawing.elements.length]); drawing.elements.push(item); }); selectTool('select');
      } finally { URL.revokeObjectURL(url); }
    } catch (error) { status.textContent = error.message; }
    finally { imageLoading = false; }
  }
  imageInput.addEventListener('change', () => { const file = imageInput.files?.[0]; if (file) void insertImage(file); imageInput.value = ''; });
  status.addEventListener('click', persist); get('[data-drawing-done]').addEventListener('click', closeModal);
  const observer = new ResizeObserver(() => { fit(); render(); }); observer.observe(paper);
  const flush = async () => { finishGesture(); finishPath(); return persist(); };
  if (host) {
    inlineDrawingFlushes.add(flush);
    // The tab pane may be replaced by a render: save the last edits, then release the editor.
    const detach = new MutationObserver(() => {
      if (root.isConnected) return;
      detach.disconnect(); observer.disconnect(); inlineDrawingFlushes.delete(flush);
      if (revision) void persist();
    });
    detach.observe(document.body, { childList: true, subtree: true });
  } else {
    editorSession.modalBeforeClose = flush;
    editorSession.modalCleanup = () => { clearTimeout(timer); observer.disconnect(); modal.classList.remove('modal-drawing'); };
  }
  properties(); fit(); render();
  imageLoading = drawing.elements.some(item => item.type === 'image');
  void prepareDrawingImages(drawing).then(() => { imageLoading = false; if (!root.isConnected) return; if (revision) changed(); else render(); }).catch(error => { imageLoading = false; if (root.isConnected) status.textContent = error.message; });
}
