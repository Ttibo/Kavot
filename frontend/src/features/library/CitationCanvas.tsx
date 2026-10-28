import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, { type ForceGraphMethods, type NodeObject } from 'react-force-graph-2d';

export type CitationNode = { id: string; title: string; authors: string[]; year?: number; doi?: string; openalex_id?: string; abstract?: string; publication?: string; url?: string; pdf_url?: string; paper_id?: number; relation: string; cited_by_count?: number; sources?: string[]; lookup_errors?: string[] };
export type CitationEdge = { source: string; target: string; relation?: string };
type GraphNode = NodeObject<CitationNode>;
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

export function CitationCanvas({ focus, nodes, edges, selectedId, onSelect }: {
  focus: CitationNode; nodes: CitationNode[]; edges?: CitationEdge[]; selectedId?: string; onSelect: (node: CitationNode) => void;
}) {
  const storageKey = `kavot-citation-positions:${focus.id}`;
  const [initialPins] = useState(() => readPins(storageKey));
  const pins = useRef<Pins>(initialPins);
  const [pinCount, setPinCount] = useState(Object.keys(pins.current).length);
  const [revision, setRevision] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const graph = useRef<ForceGraphMethods<CitationNode> | undefined>(undefined);
  const fitPending = useRef(true);
  const userArranged = useRef(false);
  const [size, setSize] = useState({ width: 600, height: 600 });
  const graphData = useMemo(() => {
    const radius = Math.max(500, Math.sqrt(nodes.length) * 240);
    const visibleIds = new Set([focus.id, ...nodes.map(node => node.id)]);
    const seen = new Set<string>();
    const links = (edges ?? nodes.map(node => ({ source: node.relation === 'citation' ? node.id : focus.id, target: node.relation === 'citation' ? focus.id : node.id })))
      .filter(edge => {
        const key = JSON.stringify([edge.source, edge.target]);
        if (edge.source === edge.target || !visibleIds.has(edge.source) || !visibleIds.has(edge.target) || seen.has(key)) return false;
        seen.add(key); return true;
      }).map(edge => ({ ...edge, internal: edge.source !== focus.id && edge.target !== focus.id }));
    return {
      nodes: [focus, ...nodes].map((node, index): GraphNode => {
        const angle = index * Math.PI * (3 - Math.sqrt(5));
        const distance = radius * Math.sqrt(index / Math.max(1, nodes.length));
        const saved = pins.current[node.id];
        return { ...node, x: Math.cos(angle) * distance, y: Math.sin(angle) * distance,
          ...(saved ? { x: saved.x, y: saved.y, fx: saved.x, fy: saved.y } : {}) };
      }),
      links,
    };
  }, [focus, nodes, edges, revision]);

  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      if (width && height) setSize({ width: Math.floor(width), height: Math.floor(height) });
    });
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    fitPending.current = true;
    userArranged.current = false;
    graph.current?.d3Force('charge')?.strength(-1800);
    graph.current?.d3Force('link')?.distance(Math.max(420, Math.sqrt(nodes.length) * 140)).strength(0.06);
    // Keep labels apart without introducing an additional force-library dependency.
    graph.current?.d3Force('label-spacing', () => {
      const points = graphData.nodes;
      for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
        const a = points[i], b = points[j];
        const dx = (b.x || 0) - (a.x || 0), dy = (b.y || 0) - (a.y || 0);
        const distance = Math.hypot(dx, dy) || 1;
        if (distance >= 320) continue;
        const push = (320 - distance) / distance * 0.25;
        if (a.fx == null) { a.vx = (a.vx || 0) - dx * push; a.vy = (a.vy || 0) - dy * push; }
        if (b.fx == null) { b.vx = (b.vx || 0) + dx * push; b.vy = (b.vy || 0) + dy * push; }
      }
    });
    graph.current?.d3ReheatSimulation();
  }, [graphData]);

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
    if (node) { delete node.fx; delete node.fy; }
    savePins();
    graph.current?.d3ReheatSimulation();
  }
  function fit() { graph.current?.zoomToFit(250, Math.min(100, size.width / 4)); }
  function keepView() { userArranged.current = true; fitPending.current = false; }
  function zoom(factor: number) { keepView(); graph.current?.zoom((graph.current.zoom() || 1) * factor, 200); }
  function reset() { pins.current = {}; savePins(); setRevision(value => value + 1); }
  function paint(node: GraphNode, context: CanvasRenderingContext2D, scale: number, hitColor?: string) {
    const x = node.x || 0, y = node.y || 0;
    const active = node.id === selectedId, isFocus = node.id === focus.id;
    const radius = (isFocus ? 9 : 7) / scale;
    const title = node.title.length > 26 ? `${node.title.slice(0, 25)}…` : node.title;
    context.save();
    context.font = `${active || isFocus ? 600 : 500} ${12 / scale}px system-ui, sans-serif`;
    const labelWidth = context.measureText(title).width + 16 / scale;
    if (hitColor) {
      context.fillStyle = hitColor;
      context.fillRect(x - labelWidth / 2, y - 14 / scale, labelWidth, 62 / scale);
    } else {
      const color = isFocus ? '#61c5d9' : node.relation === 'citation' ? '#c98a37' : '#578b9b';
      context.beginPath(); context.arc(x, y, radius + 5 / scale, 0, Math.PI * 2);
      context.fillStyle = active ? '#d6f4fa' : '#ffffff'; context.fill();
      context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2);
      context.fillStyle = color; context.fill();
      if (node.fx != null) {
        context.beginPath(); context.arc(x, y, 2.5 / scale, 0, Math.PI * 2);
        context.fillStyle = '#ffffff'; context.fill();
      }
      context.fillStyle = active ? '#e9f8fb' : 'rgba(255, 255, 255, .94)';
      context.beginPath(); context.roundRect(x - labelWidth / 2, y + 15 / scale, labelWidth, 34 / scale, 5 / scale); context.fill();
      context.textAlign = 'center'; context.textBaseline = 'middle';
      context.fillStyle = '#283345'; context.fillText(title, x, y + 26 / scale);
      context.font = `500 ${11 / scale}px system-ui, sans-serif`;
      context.fillStyle = '#68778a'; context.fillText(String(node.year || 'Year unknown'), x, y + 40 / scale);
    }
    context.restore();
  }

  return <div className="citation-map">
    <div className="citation-map-toolbar" role="toolbar" aria-label="Graph controls">
      <div className="citation-zoom-controls"><button aria-label="Zoom out" title="Zoom out" onClick={() => zoom(1 / 1.25)}>−</button><button aria-label="Zoom in" title="Zoom in" onClick={() => zoom(1.25)}>+</button></div>
      <button onClick={fit}>Fit view</button><button onClick={reset} title="Release pinned articles and arrange the graph again">Reset layout</button>
      <span className="citation-pin-status" role="status">{pinCount ? `${pinCount} pinned` : 'Drag to arrange'}</span>
      {selectedId && pins.current[selectedId] && <button onClick={unpin}>Unpin article</button>}
    </div>
    <div className="citation-canvas" ref={host} onPointerDown={keepView} onWheel={keepView} data-visible-article-ids={nodes.map(node => node.id).join(',')}>
      <ForceGraph2D ref={graph} width={size.width} height={size.height} graphData={graphData}
        enableNodeDrag nodeRelSize={7}
        linkColor={() => '#8795a6'} linkWidth={1.2} backgroundColor="rgba(0,0,0,0)"
        linkCanvasObjectMode={() => 'after'} linkCanvasObject={(edge, context, scale) => {
          const source = edge.source as GraphNode, target = edge.target as GraphNode;
          if (source.x == null || source.y == null || target.x == null || target.y == null) return;
          const dx = target.x - source.x, dy = target.y - source.y;
          if (Math.hypot(dx, dy) * scale < 30) return;
          // Keep arrowheads readable at every zoom, clear of the article labels.
          context.save();
          context.translate(source.x + dx * 0.7, source.y + dy * 0.7);
          context.rotate(Math.atan2(dy, dx));
          context.fillStyle = '#8795a6';
          context.beginPath(); context.moveTo(5 / scale, 0);
          context.lineTo(-5 / scale, -4 / scale); context.lineTo(-5 / scale, 4 / scale);
          context.closePath(); context.fill(); context.restore();
        }}
        cooldownTicks={90} d3VelocityDecay={0.45} minZoom={0.08} maxZoom={6}
        onEngineStop={() => { if (fitPending.current) { fitPending.current = false; fit(); } }}
        onNodeDrag={keepView} onNodeDragEnd={pin}
        nodeCanvasObject={paint} nodePointerAreaPaint={(node, color, context, scale) => paint(node, context, scale, color)}
        onNodeClick={node => onSelect(node)} nodeLabel={() => ''}/>
    </div>
    <footer className="citation-map-footer"><span role="status">{graphData.links.length} citation links · {graphData.links.filter(edge => edge.internal).length} between displayed articles · Arrow points to the cited article</span><div className="citation-legend" aria-label="Graph legend"><span><i className="focus"/>Starting article</span><span><i className="reference"/>References</span><span><i className="citation"/>Citing papers</span></div><p>Drag an article to pin it · Scroll to zoom</p></footer>
  </div>;
}
