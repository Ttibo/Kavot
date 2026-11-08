import { closestConnectorSides } from '../canvas/routing';

export function canvasUid(prefix = "node") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function canvasNodeMinimumSize(node) {
  if (node.type === "zone") return { width: 320, height: 220 };
  if (node.type === "shape") return { width: 120, height: 80 };
  if (node.type === "text") return { width: 150, height: 80 };
  return { width: 180, height: 120 };
}

export function canvasNodeSize(node) {
  const minimum = canvasNodeMinimumSize(node);
  return {
    width: Math.max(minimum.width, Number(node.width) || 300),
    height: Math.max(minimum.height, Number(node.height) || 190),
  };
}

export const canvasSideNames = ["top", "right", "bottom", "left"];

export const canvasShapeNames = ["rectangle", "ellipse", "diamond"];

export function canvasSidePoint(node, side) {
  const { width, height } = canvasNodeSize(node);
  const left = Number(node.x) || 0;
  const top = Number(node.y) || 0;
  if (side === "top") return { x: left + width / 2, y: top };
  if (side === "right") return { x: left + width, y: top + height / 2 };
  if (side === "bottom") return { x: left + width / 2, y: top + height };
  return { x: left, y: top + height / 2 };
}

export function canvasDefaultEdgeSides(from, to) {
  return closestConnectorSides(
    { x: Number(from.x) || 0, y: Number(from.y) || 0, ...canvasNodeSize(from) },
    { x: Number(to.x) || 0, y: Number(to.y) || 0, ...canvasNodeSize(to) },
  );
}

export function canvasSideControlPoint(point, side, distance) {
  if (side === "top") return { x: point.x, y: point.y - distance };
  if (side === "right") return { x: point.x + distance, y: point.y };
  if (side === "bottom") return { x: point.x, y: point.y + distance };
  return { x: point.x - distance, y: point.y };
}

export function canvasEdgeGeometry(fromPoint, fromSide, toPoint, toSide) {
  const distance = Math.hypot(toPoint.x - fromPoint.x, toPoint.y - fromPoint.y);
  const curve = Math.max(18, Math.min(180, distance * 0.25));
  const fromControl = canvasSideControlPoint(fromPoint, fromSide, curve);
  const toControl = canvasSideControlPoint(toPoint, toSide, curve);
  return {
    path: `M ${fromPoint.x} ${fromPoint.y} C ${fromControl.x} ${fromControl.y}, ${toControl.x} ${toControl.y}, ${toPoint.x} ${toPoint.y}`,
    midpoint: {
      x: (fromPoint.x + 3 * fromControl.x + 3 * toControl.x + toPoint.x) / 8,
      y: (fromPoint.y + 3 * fromControl.y + 3 * toControl.y + toPoint.y) / 8,
    },
  };
}

export function canvasEdgePath(fromPoint, fromSide, toPoint, toSide) {
  return canvasEdgeGeometry(fromPoint, fromSide, toPoint, toSide).path;
}

export function canvasDraftTargetSide(fromPoint, toPoint) {
  const deltaX = toPoint.x - fromPoint.x;
  const deltaY = toPoint.y - fromPoint.y;
  if (Math.abs(deltaX) >= Math.abs(deltaY))
    return deltaX >= 0 ? "left" : "right";
  return deltaY >= 0 ? "top" : "bottom";
}

// Below this zoom, cards show only their title.
export const CANVAS_OVERVIEW_ZOOM = 0.2;
