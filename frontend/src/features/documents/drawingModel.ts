import { shapeById } from './drawingShapes';
export type Point = { x: number; y: number };
const lineTools = ['line', 'arrow', 'elbow', 'curved', 'polyline', 'curve', 'pen'] as const;
export const isLine = (type: string) => (lineTools as readonly string[]).includes(type);
export type DrawingElement = {
  type: string; x: number; y: number; width: number; height: number;
  color: string; fill: string; text: string; points?: Point[];
  strokeWidth?: number; dash?: 'solid' | 'dashed' | 'dotted'; opacity?: number;
  rotation?: number; flipX?: boolean; flipY?: boolean; shadow?: boolean;
  startArrow?: 'none' | 'arrow' | 'triangle' | 'circle' | 'diamond'; endArrow?: 'none' | 'arrow' | 'triangle' | 'circle' | 'diamond';
  fontSize?: number; fontFamily?: string; bold?: boolean; italic?: boolean; underline?: boolean;
  textColor?: string; textAlign?: 'left' | 'center' | 'right'; verticalAlign?: 'top' | 'middle' | 'bottom';
  groupId?: string; imageData?: string;
};
export type DrawingDocument = { version: 1; width: number; height: number; elements: DrawingElement[]; background?: string };
export type Bounds = { x: number; y: number; width: number; height: number };
export const emptyDrawing = (): DrawingDocument => ({ version: 1, width: 1200, height: 800, elements: [] });
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export const fonts = ['Arial', 'Georgia', 'Verdana', 'Trebuchet MS', 'Courier New', 'Times New Roman'];
const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 10000;
const color = (s: unknown) => typeof s === 'string' && (s === 'transparent' || /^#[\da-f]{6}$/i.test(s));
export function parseDrawing(value: unknown): DrawingDocument {
  const doc = value as DrawingDocument;
  if (!doc || doc.version !== 1 || !finite(doc.width) || !finite(doc.height) || doc.width < 100 || doc.height < 100 || doc.width > 2400 || doc.height > 2400 || !Array.isArray(doc.elements) || doc.elements.length > 2000 || (doc.background !== undefined && !color(doc.background)))
    throw new Error('This file is not a supported Kavot drawing.');
  const allowed = new Set([...shapeById.keys(), ...lineTools, 'text', 'image']);
  let imageBytes = 0, pointCount = 0;
  for (const e of doc.elements) {
    if (!e || !allowed.has(e.type) || ![e.x, e.y].every(n => typeof n === 'number' && Number.isFinite(n)) || ![e.width, e.height].every(finite) || !color(e.color) || !color(e.fill) || typeof e.text !== 'string' || e.text.length > 10000)
      throw new Error('This drawing contains invalid elements.');
    if (['pen', 'polyline', 'curve'].includes(e.type) && (!Array.isArray(e.points) || !e.points.length)) throw new Error('This drawing contains invalid points.');
    if (e.points) {
      pointCount += e.points.length;
      if (e.points.length > 20000 || pointCount > 100000 || e.points.some(p => !p || !finite(p.x) || !finite(p.y))) throw new Error('This drawing contains invalid points.');
    }
    for (const [key, low, high] of [['strokeWidth', 0, 40], ['opacity', 0, 100], ['rotation', -360, 360], ['fontSize', 8, 200]] as const) {
      const n = e[key]; if (n !== undefined && (!finite(n) || n < low || n > high)) throw new Error('This drawing contains invalid formatting.');
    }
    for (const [key, choices] of Object.entries({ dash: ['solid', 'dashed', 'dotted'], startArrow: ['none', 'arrow', 'triangle', 'circle', 'diamond'], endArrow: ['none', 'arrow', 'triangle', 'circle', 'diamond'], textAlign: ['left', 'center', 'right'], verticalAlign: ['top', 'middle', 'bottom'], fontFamily: fonts })) {
      if (e[key] !== undefined && !choices.includes(e[key])) throw new Error('This drawing contains invalid formatting.');
    }
    for (const key of ['flipX', 'flipY', 'shadow', 'bold', 'italic', 'underline']) if (e[key] !== undefined && typeof e[key] !== 'boolean') throw new Error('This drawing contains invalid formatting.');
    if (e.textColor !== undefined && !color(e.textColor)) throw new Error('This drawing contains an invalid text color.');
    if (e.groupId !== undefined && (typeof e.groupId !== 'string' || e.groupId.length > 100)) throw new Error('This drawing contains an invalid group.');
    if (e.type === 'image') {
      if (typeof e.imageData !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(e.imageData)) throw new Error('Only embedded PNG, JPEG and WebP images are supported.');
      imageBytes += e.imageData.length;
      if (imageBytes > 6_000_000) throw new Error('The embedded images in this drawing are too large.');
    }
  }
  return clone(doc);
}
export function localPoint(item: DrawingElement, p: Point): Point {
  const cx = item.x + item.width / 2, cy = item.y + item.height / 2, angle = -(item.rotation || 0) * Math.PI / 180;
  const dx = p.x - cx, dy = p.y - cy;
  return { x: (dx * Math.cos(angle) - dy * Math.sin(angle)) * (item.flipX ? -1 : 1) + item.width / 2, y: (dx * Math.sin(angle) + dy * Math.cos(angle)) * (item.flipY ? -1 : 1) + item.height / 2 };
}
export function worldPoint(item: DrawingElement, p: Point): Point {
  const angle = (item.rotation || 0) * Math.PI / 180, dx = (p.x - item.width / 2) * (item.flipX ? -1 : 1), dy = (p.y - item.height / 2) * (item.flipY ? -1 : 1);
  return { x: item.x + item.width / 2 + dx * Math.cos(angle) - dy * Math.sin(angle), y: item.y + item.height / 2 + dx * Math.sin(angle) + dy * Math.cos(angle) };
}
export function bounds(items: DrawingElement[]): Bounds {
  const points = items.flatMap(item => [{ x: 0, y: 0 }, { x: item.width, y: 0 }, { x: item.width, y: item.height }, { x: 0, y: item.height }].map(p => worldPoint(item, p)));
  const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
  return { x, y, width: Math.max(...points.map(p => p.x)) - x, height: Math.max(...points.map(p => p.y)) - y };
}
export function normalizePoints(item: DrawingElement) {
  if (!item.points?.length) return;
  const minX = Math.min(...item.points.map(p => p.x)), minY = Math.min(...item.points.map(p => p.y));
  item.width = Math.max(...item.points.map(p => p.x)) - minX; item.height = Math.max(...item.points.map(p => p.y)) - minY;
  item.x += minX; item.y += minY; item.points = item.points.map(p => ({ x: p.x - minX, y: p.y - minY }));
}
export function resizeElement(item: DrawingElement, width: number, height: number) {
  if (item.points) item.points = item.points.map(p => ({ x: item.width ? p.x * width / item.width : p.x, y: item.height ? p.y * height / item.height : p.y }));
  item.width = width; item.height = height;
}

/** Content frame with space for strokes, arrowheads and shadows. */
export function drawingBounds(doc: DrawingDocument): Bounds {
  if (!doc.elements.length) return { x: 0, y: 0, width: doc.width, height: doc.height };
  const frames = doc.elements.map(item => {
    const b = bounds([item]), margin = 24 + (item.strokeWidth ?? 3) * (isLine(item.type) ? 4 : .5) + (item.shadow ? 24 : 0);
    return { x: b.x - margin, y: b.y - margin, width: b.width + margin * 2, height: b.height + margin * 2 };
  });
  const x = Math.min(...frames.map(b => b.x)), y = Math.min(...frames.map(b => b.y));
  return { x, y, width: Math.max(...frames.map(b => b.x + b.width)) - x, height: Math.max(...frames.map(b => b.y + b.height)) - y };
}
