import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import ForceGraph2D, { type ForceGraphMethods, type LinkObject, type NodeObject } from 'react-force-graph-2d';

export type CitationNode = { id: string; title: string; authors: string[]; year?: number; doi?: string; openalex_id?: string; abstract?: string; publication?: string; url?: string; pdf_url?: string; paper_id?: number; relation: string; cited_by_count?: number; sources?: string[]; lookup_errors?: string[] };
export type CitationEdge = { source: string; target: string; relation?: string };
type GraphNode = NodeObject<CitationNode>;
type GraphLink = LinkObject<CitationNode, { internal: boolean }>;
type Position = { x: number; y: number };
type Pins = Record<string, Position>;

function readPins(key: string): Pins {
  try {
    const stored = JSON.parse(localStorage.getItem(key) || '{}');
    return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, Position] => {
      const point = entry[1] as Position | null;
      return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));
    }));
  } catch { return {}; }
}

type Palette = { focus: string; reference: string; citation: string; link: string; surface: string; active: string; ink: string; subtle: string; accent: string };
const fallback: Palette = { focus: '#1f8a5b', reference: '#3f7cac', citation: '#b9731c', link: '#9aa3ad', surface: '#ffffff', active: '#e6f4ec', ink: '#222222', subtle: '#8a8a8a', accent: '#1f8a5b' };

/** The graph is drawn on a canvas: read the theme tokens, and read them again when the theme changes. */
function useGraphPalette(host: RefObject<HTMLElement | null>): Palette {
  const [palette, setPalette] = useState(fallback);
  useEffect(() => {
    const read = () => {
      if (!host.current) return;
      const style = getComputedStyle(host.current);
      const token = (name: string, otherwise: string) => style.getPropertyValue(name).trim() || otherwise;
      setPalette({ focus: token('--graph-focus', fallback.focus), reference: token('--graph-reference', fallback.reference), citation: token('--graph-citation', fallback.citation),
        link: token('--graph-link', fallback.link), surface: token('--surface', fallback.surface), active: token('--accent-soft', fallback.active),
        ink: token('--ink', fallback.ink), subtle: token('--subtle', fallback.subtle), accent: token('--accent', fallback.accent) });
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    // Custom accent colours are written into a <style> element.
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [host]);
  return palette;
}

/** World-space radius: the area grows with the article's overall citation count. */
function radiusOf(node: CitationNode, focusId: string) {
  if (node.id === focusId) return 16;
  return Math.min(26, 5 + 4.2 * Math.log10((node.cited_by_count || 0) + 1));
}

const endId = (end: unknown) => typeof end === 'object' && end ? (end as GraphNode).id : String(end);

/**
 * References sit on the left (earlier work), citing papers on the right (later work),
 * the starting article in the middle. Node size = overall citations; the badge counts how
 * many displayed articles cite that article, which reveals the key works of the set.
 */
export function CitationCanvas({ focus, nodes, edges, selectedId, onSelect, citedHere }: {
  focus: CitationNode; nodes: CitationNode[]; edges?: CitationEdge[]; selectedId?: string; onSelect: (node: CitationNode) => void; citedHere: Record<string, number>;
}) {
  const storageKey = `kavot-citation-positions:${focus.id}`;
  const [initialPins] = useState(() => readPins(storageKey));
  const pins = useRef<Pins>(initialPins);
  const [pinCount, setPinCount] = useState(Object.keys(pins.current).length);
  const [revision, setRevision] = useState(0);
  const [allLabels, setAllLabels] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const graph = useRef<ForceGraphMethods<CitationNode, { internal: boolean }> | undefined>(undefined);
  const previous = useRef<Map<string, Position>>(new Map());
  const hovered = useRef<string | null>(null);
  const fitPending = useRef(true);
  const userArranged = useRef(false);
  const [size, setSize] = useState({ width: 600, height: 600 });
  const palette = useGraphPalette(host);
  const spread = Math.max(260, Math.sqrt(nodes.length) * 55);

  const graphData = useMemo(() => {
    const visibleIds = new Set([focus.id, ...nodes.map(node => node.id)]);
    const seen = new Set<string>();
    const links = (edges ?? nodes.map(node => ({ source: node.relation === 'citation' ? node.id : focus.id, target: node.relation === 'citation' ? focus.id : node.id })))
      .filter(edge => {
        const key = `${edge.source}\u0000${edge.target}`;
        if (edge.source === edge.target || !visibleIds.has(edge.source) || !visibleIds.has(edge.target) || seen.has(key)) return false;
        seen.add(key); return true;
      }).map(edge => ({ source: edge.source, target: edge.target, internal: edge.source !== focus.id && edge.target !== focus.id }));
    return {
      nodes: [focus, ...nodes].map((node, index): GraphNode => {
        const saved = pins.current[node.id];
        if (saved) return { ...node, x: saved.x, y: saved.y, fx: saved.x, fy: saved.y };
        const kept = previous.current.get(node.id);
        if (kept) return { ...node, x: kept.x, y: kept.y };
        if (node.id === focus.id) return { ...node, x: 0, y: 0, fx: 0, fy: 0 };
        const side = node.relation === 'citation' ? 1 : -1;
        return { ...node, x: side * spread + (Math.random() - .5) * 120, y: ((index * 0.618) % 1 - .5) * spread * 1.6 };
      }),
      links,
    };
  }, [focus, nodes, edges, revision, spread]);

  /** Articles that keep their title on the canvas: focus, selection and the most cited of the set. */
  const labeled = useMemo(() => {
    const ranked = [...nodes].sort((a, b) => (citedHere[b.id] || 0) - (citedHere[a.id] || 0) || (b.cited_by_count || 0) - (a.cited_by_count || 0));
    return new Set([focus.id, ...(selectedId ? [selectedId] : []), ...ranked.slice(0, Math.min(10, Math.ceil(nodes.length / 4))).map(node => node.id)]);
  }, [nodes, citedHere, focus.id, selectedId]);

  const neighbours = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const link of graphData.links) {
      const source = endId(link.source), target = endId(link.target);
      if (!map.has(source)) map.set(source, new Set());
      if (!map.has(target)) map.set(target, new Set());
      map.get(source)!.add(target); map.get(target)!.add(source);
    }
    return map;
  }, [graphData]);

  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      if (width && height) setSize({ width: Math.floor(width), height: Math.floor(height) });
    });
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const instance = graph.current;
    if (!instance) return;
    fitPending.current = true;
    userArranged.current = false;
    instance.d3Force('center', null);
    instance.d3Force('charge')?.strength(-260);
    instance.d3Force('link')?.distance(140).strength((link: GraphLink) => link.internal ? 0.015 : 0.03);
    const points = graphData.nodes;
    // Pull each side towards its column, keep the column compact vertically.
    instance.d3Force('sides', (alpha: number) => {
      for (const node of points) {
        if (node.fx != null) continue;
        const target = node.relation === 'citation' ? spread : -spread;
        node.vx = (node.vx || 0) + (target - (node.x || 0)) * 0.12 * alpha;
        node.vy = (node.vy || 0) - (node.y || 0) * 0.015 * alpha;
      }
    });
    // Keep nodes and their labels apart without an extra force-library dependency.
    instance.d3Force('collide', () => {
      for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
        const a = points[i], b = points[j];
        const dx = (b.x || 0) - (a.x || 0), dy = (b.y || 0) - (a.y || 0);
        const distance = Math.hypot(dx, dy) || 1;
        const minimum = radiusOf(a, focus.id) + radiusOf(b, focus.id) + 26;
        if (distance >= minimum) continue;
        const push = (minimum - distance) / distance * 0.5;
        if (a.fx == null) { a.vx = (a.vx || 0) - dx * push; a.vy = (a.vy || 0) - dy * push; }
        if (b.fx == null) { b.vx = (b.vx || 0) + dx * push; b.vy = (b.vy || 0) + dy * push; }
      }
    });
    instance.d3ReheatSimulation();
  }, [graphData, spread, focus.id]);

  // Show the whole graph immediately, then refine the framing when it settles.
  // Once the user starts arranging it, preserve their chosen view.
  useEffect(() => {
    const timer = setTimeout(() => { if (!userArranged.current) fit(); }, 80);
    return () => clearTimeout(timer);
  }, [graphData, size.width, size.height]);

  function savePins() {
    setPinCount(Object.keys(pins.current).length);
    try { localStorage.setItem(storageKey, JSON.stringify(pins.current)); } catch { /* Keep the layout for this session when storage is unavailable. */ }
  }
  function pin(node: GraphNode) {
    if (node.x == null || node.y == null) return;
    node.fx = node.x; node.fy = node.y;
    pins.current[node.id] = { x: node.x, y: node.y };
    fitPending.current = false;
    savePins();
  }
  function unpin() {
    if (!selectedId) return;
    delete pins.current[selectedId];
    const node = graphData.nodes.find(item => item.id === selectedId);
    if (node && node.id !== focus.id) { delete node.fx; delete node.fy; }
    savePins();
    graph.current?.d3ReheatSimulation();
  }
  function fit() { graph.current?.zoomToFit(250, Math.min(60, size.width / 8)); }
  function keepView() { userArranged.current = true; fitPending.current = false; }
  function zoom(factor: number) { keepView(); graph.current?.zoom((graph.current.zoom() || 1) * factor, 200); }
  function reset() { pins.current = {}; previous.current.clear(); savePins(); setRevision(value => value + 1); }
  function rememberPositions() {
    for (const node of graphData.nodes) if (node.x != null && node.y != null) previous.current.set(node.id, { x: node.x, y: node.y });
  }

  const emphasis = () => hovered.current || selectedId || null;
  function isDimmed(id: string) {
    const active = emphasis();
    if (!active || active === focus.id) return false;
    return id !== active && id !== focus.id && !neighbours.get(active)?.has(id);
  }
  function colorOf(node: CitationNode) { return node.id === focus.id ? palette.focus : node.relation === 'citation' ? palette.citation : palette.reference; }

  function paint(node: GraphNode, context: CanvasRenderingContext2D, scale: number, hitColor?: string) {
    const x = node.x || 0, y = node.y || 0;
    const radius = radiusOf(node, focus.id);
    const showLabel = allLabels || labeled.has(node.id) || hovered.current === node.id;
    const title = node.title.length > 38 ? `${node.title.slice(0, 37)}…` : node.title;
    context.save();
    context.font = `${node.id === selectedId || node.id === focus.id ? 600 : 500} ${12 / scale}px system-ui, sans-serif`;
    const labelWidth = context.measureText(title).width + 14 / scale;
    const labelTop = y + radius + 4 / scale;
    if (hitColor) {
      context.fillStyle = hitColor;
      context.beginPath(); context.arc(x, y, Math.max(radius, 6 / scale), 0, Math.PI * 2); context.fill();
      if (showLabel) context.fillRect(x - labelWidth / 2, labelTop, labelWidth, 32 / scale);
      context.restore();
      return;
    }
    const color = colorOf(node), active = node.id === selectedId;
    context.globalAlpha = isDimmed(node.id) ? 0.18 : 1;
    if (active || hovered.current === node.id) {
      context.beginPath(); context.arc(x, y, radius + 5 / scale, 0, Math.PI * 2);
      context.strokeStyle = color; context.lineWidth = 2.5 / scale; context.stroke();
    }
    context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2);
    context.fillStyle = color; context.fill();
    context.strokeStyle = palette.surface; context.lineWidth = 1.5 / scale; context.stroke();
    const here = citedHere[node.id] || 0;
    if (here > 0 && radius * scale >= 7) {
      context.fillStyle = palette.surface;
      context.font = `700 ${Math.min(radius * 0.95, 13 / scale)}px system-ui, sans-serif`;
      context.textAlign = 'center'; context.textBaseline = 'middle';
      context.fillText(String(here), x, y + 0.5 / scale);
    }
    if (node.fx != null && node.id !== focus.id) {
      context.beginPath(); context.arc(x + radius * 0.75, y - radius * 0.75, 3 / scale, 0, Math.PI * 2);
      context.fillStyle = palette.ink; context.fill();
    }
    if (showLabel) {
      context.font = `${active || node.id === focus.id ? 600 : 500} ${12 / scale}px system-ui, sans-serif`;
      context.fillStyle = active ? palette.active : palette.surface;
      context.globalAlpha *= active ? 1 : .92;
      context.beginPath(); context.roundRect(x - labelWidth / 2, labelTop, labelWidth, 32 / scale, 5 / scale); context.fill();
      if (active) { context.strokeStyle = color; context.lineWidth = 1 / scale; context.stroke(); }
      context.globalAlpha = isDimmed(node.id) ? 0.18 : 1;
      context.textAlign = 'center'; context.textBaseline = 'middle';
      context.fillStyle = palette.ink; context.fillText(title, x, labelTop + 11 / scale);
      context.font = `500 ${10.5 / scale}px system-ui, sans-serif`;
      context.fillStyle = palette.subtle;
      context.fillText(`${node.year || '—'} · ${(node.cited_by_count || 0).toLocaleString()} cit.${here ? ` · cited by ${here} here` : ''}`, x, labelTop + 24 / scale);
    }
    context.restore();
  }

  function paintLink(link: GraphLink, context: CanvasRenderingContext2D, scale: number) {
    const source = link.source as GraphNode, target = link.target as GraphNode;
    if (source.x == null || source.y == null || target.x == null || target.y == null) return;
    const active = emphasis();
    const touches = active && (source.id === active || target.id === active);
    const dimmed = active && active !== focus.id && !touches;
    context.save();
    context.globalAlpha = dimmed ? 0.06 : touches ? 0.95 : link.internal ? 0.55 : 0.28;
    context.strokeStyle = touches ? palette.accent : palette.link;
    context.lineWidth = (touches ? 1.8 : link.internal ? 1.1 : 0.8) / scale;
    context.beginPath(); context.moveTo(source.x, source.y); context.lineTo(target.x, target.y); context.stroke();
    const dx = target.x - source.x, dy = target.y - source.y, length = Math.hypot(dx, dy);
    const tip = radiusOf(target, focus.id) + 2 / scale;
    if (length * scale > 40 && length > tip * 2 && (touches || link.internal)) {
      // Arrowhead on the cited article's edge.
      context.translate(source.x + dx * (1 - tip / length), source.y + dy * (1 - tip / length));
      context.rotate(Math.atan2(dy, dx));
      context.fillStyle = context.strokeStyle;
      context.beginPath(); context.moveTo(0, 0); context.lineTo(-8 / scale, -4 / scale); context.lineTo(-8 / scale, 4 / scale);
      context.closePath(); context.fill();
    }
    context.restore();
  }

  function paintColumns(context: CanvasRenderingContext2D, scale: number) {
    const references = graphData.nodes.filter(node => node.relation === 'reference');
    const citations = graphData.nodes.filter(node => node.relation === 'citation');
    const top = Math.min(0, ...graphData.nodes.map(node => (node.y || 0) - radiusOf(node, focus.id))) - 36 / scale;
    context.save();
    context.font = `600 ${13 / scale}px system-ui, sans-serif`;
    context.textAlign = 'center'; context.textBaseline = 'middle';
    const column = (items: GraphNode[], label: string, color: string) => {
      if (!items.length) return;
      const center = items.reduce((sum, node) => sum + (node.x || 0), 0) / items.length;
      context.fillStyle = color; context.fillText(label, center, top);
    };
    column(references, `← References · ${references.length} (earlier work)`, palette.reference);
    column(citations, `Cited by · ${citations.length} (later work) →`, palette.citation);
    context.restore();
  }

  return <div className="citation-map">
    <div className="citation-map-toolbar" role="toolbar" aria-label="Graph controls">
      <div className="citation-zoom-controls"><button aria-label="Zoom out" title="Zoom out" onClick={() => zoom(1 / 1.25)}>−</button><button aria-label="Zoom in" title="Zoom in" onClick={() => zoom(1.25)}>+</button></div>
      <button onClick={() => { userArranged.current = false; fit(); }} title="Show the whole graph">Fit view</button><button onClick={reset} title="Release pinned articles and arrange the graph again">Reset layout</button>
      <button aria-pressed={allLabels} onClick={() => setAllLabels(value => !value)} title="Show every title, or only the key articles">{allLabels ? 'Key titles only' : 'All titles'}</button>
      <span className="citation-pin-status" role="status">{pinCount ? `${pinCount} pinned` : 'Hover an article to see its links'}</span>
      {selectedId && pins.current[selectedId] && selectedId !== focus.id && <button onClick={unpin}>Unpin article</button>}
    </div>
    <div className="citation-canvas" ref={host} onPointerDown={keepView} onWheel={keepView} data-visible-article-ids={nodes.map(node => node.id).join(',')}>
      <ForceGraph2D ref={graph} width={size.width} height={size.height} graphData={graphData}
        enableNodeDrag backgroundColor="rgba(0,0,0,0)"
        linkCanvasObjectMode={() => 'replace'} linkCanvasObject={paintLink}
        onRenderFramePre={paintColumns}
        cooldownTicks={120} d3VelocityDecay={0.4} minZoom={0.08} maxZoom={6}
        onEngineStop={() => { rememberPositions(); if (fitPending.current) { fitPending.current = false; fit(); } }}
        onNodeHover={node => { hovered.current = node?.id ?? null; if (host.current) host.current.style.cursor = node ? 'pointer' : ''; }}
        onNodeDrag={keepView} onNodeDragEnd={node => { pin(node); rememberPositions(); }}
        nodeCanvasObject={paint} nodePointerAreaPaint={(node, color, context, scale) => paint(node, context, scale, color)}
        onNodeClick={node => onSelect(node)} nodeLabel={() => ''}/>
    </div>
    <footer className="citation-map-footer"><span role="status">{graphData.links.filter(edge => edge.internal).length} links between displayed articles · arrows point to the cited article</span><div className="citation-legend" aria-label="Graph legend"><span><i className="focus"/>Starting article</span><span><i className="reference"/>References</span><span><i className="citation"/>Cited by</span><span><b className="citation-legend-size"/>Size = total citations</span><span><b className="citation-legend-badge">3</b>Cited by 3 articles shown</span></div></footer>
  </div>;
}
