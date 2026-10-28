import { shapeById } from './drawingShapes';
import { drawingBounds, isLine, localPoint, type DrawingElement, type DrawingDocument, type Point } from './drawingModel';
const images = new Map<string, HTMLImageElement>();
export async function prepareDrawingImages(doc: DrawingDocument) {
  for (const item of doc.elements) if (item.type === 'image' && item.imageData && !images.has(item.imageData)) {
    const image = new Image(); image.src = item.imageData;
    await image.decode();
    if (image.naturalWidth > 12000 || image.naturalHeight > 12000) throw new Error('Images must be smaller than 12,000 × 12,000 pixels.');
    images.set(item.imageData, image);
  }
}
function elementPath(item: DrawingElement): Path2D {
  const path = new Path2D(), w = item.width, h = item.height;
  if (shapeById.has(item.type)) { path.addPath(new Path2D(shapeById.get(item.type)!.path), new DOMMatrix().scale(w / 100, h / 100)); return path; }
  if (item.type === 'image' || item.type === 'text') { path.rect(0, 0, w, h); return path; }
  path.moveTo(0, 0);
  if (item.type === 'elbow') { path.lineTo(w / 2, 0); path.lineTo(w / 2, h); path.lineTo(w, h); }
  else if (item.type === 'curved') path.bezierCurveTo(w * .6, 0, w * .4, h, w, h);
  else if (item.points?.length) {
    const points = item.points;
    path.moveTo(points[0].x, points[0].y);
    if (item.type === 'curve' && points.length > 2) {
      for (let i = 1; i < points.length - 1; i++) path.quadraticCurveTo(points[i].x, points[i].y, (points[i].x + points[i + 1].x) / 2, (points[i].y + points[i + 1].y) / 2);
      const p = points.at(-1)!; path.lineTo(p.x, p.y);
    } else points.slice(1).forEach(p => path.lineTo(p.x, p.y));
  } else path.lineTo(w, h);
  return path;
}
function arrowHead(ctx: CanvasRenderingContext2D, p: Point, angle: number, kind: string, size: number) {
  if (kind === 'none') return;
  ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(angle); ctx.setLineDash([]); ctx.beginPath();
  if (kind === 'circle') ctx.arc(-size / 2, 0, size / 2, 0, Math.PI * 2);
  else if (kind === 'diamond') { ctx.moveTo(0, 0); ctx.lineTo(-size / 2, size / 2); ctx.lineTo(-size, 0); ctx.lineTo(-size / 2, -size / 2); ctx.closePath(); }
  else { ctx.moveTo(-size, -size / 2); ctx.lineTo(0, 0); ctx.lineTo(-size, size / 2); if (kind === 'triangle') ctx.closePath(); }
  if (kind !== 'arrow') { ctx.fillStyle = ctx.strokeStyle; ctx.fill(); }
  ctx.stroke(); ctx.restore();
}
function paintText(ctx: CanvasRenderingContext2D, item: DrawingElement) {
  if (!item.text) return;
  const size = item.fontSize || 24, lineHeight = size * 1.25, width = Math.max(20, Math.abs(item.width) - 20), height = Math.abs(item.height);
  ctx.fillStyle = item.textColor || item.color;
  ctx.font = `${item.italic ? 'italic ' : ''}${item.bold ? 'bold ' : ''}${size}px "${item.fontFamily || 'Arial'}"`;
  ctx.textBaseline = 'middle'; ctx.textAlign = item.textAlign || (item.type === 'text' ? 'left' : 'center');
  const lines: string[] = [];
  for (const paragraph of item.text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      if (line && ctx.measureText(`${line} ${word}`).width > width) { lines.push(line); line = word; }
      else line += (line ? ' ' : '') + word;
    }
    lines.push(line);
    if (lines.length > 400) break;
  }
  const x = ctx.textAlign === 'left' ? 10 : ctx.textAlign === 'right' ? Math.abs(item.width) - 10 : Math.abs(item.width) / 2;
  const y = item.verticalAlign === 'top' ? 10 + lineHeight / 2 : item.verticalAlign === 'bottom' ? height - 10 - (lines.length - .5) * lineHeight : height / 2 - (lines.length - 1) * lineHeight / 2;
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, item.width, item.height); ctx.clip();
  lines.forEach((line, i) => {
    ctx.fillText(line, x, y + i * lineHeight, width);
    if (item.underline) {
      const textWidth = Math.min(width, ctx.measureText(line).width), left = ctx.textAlign === 'left' ? x : ctx.textAlign === 'right' ? x - textWidth : x - textWidth / 2;
      ctx.fillRect(left, y + i * lineHeight + size * .45, textWidth, Math.max(1, size / 16));
    }
  }); ctx.restore();
}
function paintElement(ctx: CanvasRenderingContext2D, item: DrawingElement) {
  ctx.save(); ctx.translate(item.x + item.width / 2, item.y + item.height / 2); ctx.rotate((item.rotation || 0) * Math.PI / 180); ctx.scale(item.flipX ? -1 : 1, item.flipY ? -1 : 1); ctx.translate(-item.width / 2, -item.height / 2);
  ctx.globalAlpha = (item.opacity ?? 100) / 100;
  ctx.strokeStyle = item.color; ctx.fillStyle = item.fill; ctx.lineWidth = item.strokeWidth ?? 3;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.setLineDash(item.dash === 'dashed' ? [12, 7] : item.dash === 'dotted' ? [1, 6] : []);
  if (item.shadow) { ctx.shadowColor = '#00000040'; ctx.shadowBlur = 12; ctx.shadowOffsetX = 4; ctx.shadowOffsetY = 5; }
  const path = elementPath(item);
  if (item.type === 'image') {
    const image = item.imageData && images.get(item.imageData);
    if (image) ctx.drawImage(image, 0, 0, item.width, item.height);
  } else if (!isLine(item.type) && item.fill !== 'transparent' && item.type !== 'text') ctx.fill(path, 'nonzero');
  if (item.color !== 'transparent' && (item.strokeWidth ?? 3) > 0 && item.type !== 'text') ctx.stroke(path);
  ctx.shadowColor = 'transparent';
  if (isLine(item.type) && item.color !== 'transparent' && (item.strokeWidth ?? 3) > 0) {
    const points = item.points || [{ x: 0, y: 0 }, { x: item.width, y: item.height }];
    const a = points[0], b = points.at(-1)!, a2 = points[1] || b, b2 = points.at(-2) || a;
    const startAngle = item.type === 'elbow' || item.type === 'curved' ? (item.width < 0 ? 0 : Math.PI) : Math.atan2(a.y - a2.y, a.x - a2.x);
    const endAngle = item.type === 'elbow' || item.type === 'curved' ? (item.width < 0 ? Math.PI : 0) : Math.atan2(b.y - b2.y, b.x - b2.x);
    arrowHead(ctx, a, startAngle, item.startArrow || 'none', Math.max(12, (item.strokeWidth ?? 3) * 4));
    arrowHead(ctx, b, endAngle, item.endArrow || (item.type === 'arrow' ? 'arrow' : 'none'), Math.max(12, (item.strokeWidth ?? 3) * 4));
  }
  paintText(ctx, item); ctx.restore();
}
export function paintDrawing(canvas: HTMLCanvasElement, doc: DrawingDocument, grid = false, view = { x: 0, y: 0, zoom: 1 }) {
  const ctx = canvas.getContext('2d')!;
  ctx.resetTransform(); ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (doc.background !== 'transparent') { ctx.fillStyle = doc.background || '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  ctx.save(); ctx.scale(view.zoom, view.zoom); ctx.translate(-view.x, -view.y);
  if (grid) {
    const step = 20 * Math.max(1, Math.ceil(8 / (20 * view.zoom)));
    // Keep grid lines readable at every zoom and aligned to world coordinates.
    ctx.lineWidth = 1 / view.zoom;
    for (const major of [false, true]) {
      ctx.strokeStyle = major ? '#cbd5e170' : '#e2e8f080';
      ctx.beginPath();
      const left = view.x, top = view.y, right = left + canvas.width / view.zoom, bottom = top + canvas.height / view.zoom;
      for (let x = Math.floor(left / step) * step; x <= right; x += step) {
        if ((Math.round(x / step) % 5 === 0) !== major) continue;
        ctx.moveTo(x, top); ctx.lineTo(x, bottom);
      }
      for (let y = Math.floor(top / step) * step; y <= bottom; y += step) {
        if ((Math.round(y / step) % 5 === 0) !== major) continue;
        ctx.moveTo(left, y); ctx.lineTo(right, y);
      }
      ctx.stroke();
    }
  }
  doc.elements.forEach(item => paintElement(ctx, item)); ctx.restore();
}
export function drawingImage(doc: DrawingDocument, format: 'jpeg' | 'png' = 'jpeg') {
  const frame = drawingBounds(doc), scale = Math.min(2, 2400 / Math.max(frame.width, frame.height));
  const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.ceil(frame.width * scale)); canvas.height = Math.max(1, Math.ceil(frame.height * scale));
  paintDrawing(canvas, format === 'jpeg' && doc.background === 'transparent' ? { ...doc, background: '#ffffff' } : doc, false, { x: frame.x, y: frame.y, zoom: scale });
  return canvas.toDataURL('image/' + format, .92);
}
/** The in-product thumbnail intentionally omits the drawing page colour. */
export const drawingPreviewPng = (doc: DrawingDocument) => drawingImage({ ...doc, background: 'transparent' }, 'png');
export function hitElement(ctx: CanvasRenderingContext2D, item: DrawingElement, point: Point, tolerance = 8) {
  const p = localPoint(item, point), path = elementPath(item);
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.lineWidth = Math.max(tolerance * 2, item.strokeWidth ?? 3);
  const hit = isLine(item.type) ? ctx.isPointInStroke(path, p.x, p.y) : ctx.isPointInPath(path, p.x, p.y, 'nonzero') || ctx.isPointInStroke(path, p.x, p.y);
  ctx.restore(); return hit;
}
