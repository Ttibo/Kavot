type CardBounds = { x: number; y: number; width: number; height: number };
export const connectorSides = ['top', 'right', 'bottom', 'left'] as const;
type Side = typeof connectorSides[number];
const normals = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };

export function connectorPoint(card: CardBounds, side: Side) {
  return { x: card.x + (side === 'left' ? 0 : side === 'right' ? card.width : card.width / 2),
    y: card.y + (side === 'top' ? 0 : side === 'bottom' ? card.height : card.height / 2) };
}

/** Prefer the shortest pair of outward-facing side buttons, independently of old anchors. */
export function closestConnectorSides(from: CardBounds, to: CardBounds) {
  let best = { fromSide: 'right' as Side, toSide: 'left' as Side };
  let bestScore = Infinity;
  for (const fromSide of connectorSides) for (const toSide of connectorSides) {
    const a = connectorPoint(from, fromSide), b = connectorPoint(to, toSide);
    const dx = b.x - a.x, dy = b.y - a.y;
    const distance = Math.hypot(dx, dy);
    const outwardA = dx * normals[fromSide][0] + dy * normals[fromSide][1];
    const outwardB = -dx * normals[toSide][0] - dy * normals[toSide][1];
    // Penalize an anchor that would route through its own card.
    const penalty = Math.max(from.width, from.height, to.width, to.height) + distance;
    const score = distance + (outwardA < 0 ? penalty * 2 : 0) + (outwardB < 0 ? penalty * 2 : 0);
    if (score < bestScore) { bestScore = score; best = { fromSide, toSide }; }
  }
  return best;
}
