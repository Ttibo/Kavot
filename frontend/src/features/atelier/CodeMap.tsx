import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d';
import { Icon } from '../../components/Icon';
import { atelierApi, type CodeMap as Map, type Folder, type MapFile, type MapSymbol } from './types';

type Mode = 'files' | 'folders';
type Node = { id: string; label: string; group: string; size: number; file?: MapFile; files?: number; lines: number; x?: number; y?: number };
type Link = { source: string | Node; target: string | Node; weight: number };

const PALETTE = ['#2f8f9d', '#c87d18', '#7a62c4', '#3f8f4f', '#c75555', '#4b74c9', '#a0682f', '#b04f8e', '#5d8a2e', '#6d7b8c'];
const base = (path: string) => path.split('/').pop() || path;
const directory = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
// Colour by the first two folders: `app/core`, `frontend/src`…
const groupOf = (path: string) => { const parts = directory(path).split('/'); return parts.slice(0, 2).join('/') || '.'; };
const endpoint = (value: string | Node) => typeof value === 'string' ? value : value.id;

function token(name: string, fallback: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function SymbolList({ title, ids, files, onOpen }: { title: string; ids: string[]; files: globalThis.Map<string, MapFile>; onOpen: (path: string, line?: number) => void }) {
  if (!ids.length) return null;
  return <div className="atelier-symbol-links"><strong>{title}</strong>{ids.slice(0, 12).map(id => {
    const [path, name] = id.split('#');
    const symbol = files.get(path)?.symbols.find(item => item.id === id);
    return <button key={id} className="text-link" onClick={() => onOpen(path, symbol?.line)} title={id}>{name} <small>{base(path)}</small></button>;
  })}{ids.length > 12 && <small>+{ids.length - 12} more</small>}</div>;
}

export function CodeMap({ projectId, folder, focusPath, onOpen }: {
  projectId: number; folder: Folder; focusPath?: string | null; onOpen: (path: string, line?: number) => void;
}) {
  const [map, setMap] = useState<Map | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<Mode>('files');
  const [query, setQuery] = useState('');
  const [hideIsolated, setHideIsolated] = useState(true);
  const [selected, setSelected] = useState<string | null>(focusPath || null);
  const [symbol, setSymbol] = useState<MapSymbol | null>(null);
  const [size, setSize] = useState({ width: 600, height: 500 });
  const host = useRef<HTMLDivElement>(null);
  const graph = useRef<ForceGraphMethods<any, any> | undefined>(undefined);

  async function load() {
    setBusy(true); setError('');
    try { setMap(await atelierApi<Map>(projectId, `/folders/${folder.id}/map`)); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  useEffect(() => { setMap(null); setSelected(focusPath || null); void load(); }, [projectId, folder.id]);
  useEffect(() => { if (focusPath) { setMode('files'); setSelected(focusPath); } }, [focusPath]);
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: Math.max(200, entry.contentRect.width), height: Math.max(200, entry.contentRect.height) }));
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [map]);

  const files = useMemo(() => new globalThis.Map((map?.files || []).map(file => [file.path, file])), [map]);
  const groups = useMemo(() => [...new Set((map?.files || []).map(file => groupOf(file.path)))].sort(), [map]);
  const color = (group: string) => PALETTE[Math.max(0, groups.indexOf(group)) % PALETTE.length];

  const data = useMemo(() => {
    if (!map) return { nodes: [] as Node[], links: [] as Link[] };
    const needle = query.trim().toLowerCase();
    if (mode === 'folders') {
      const weights = new globalThis.Map<string, number>();
      map.edges.forEach(edge => {
        const source = directory(edge.source), target = directory(edge.target);
        if (source !== target) weights.set(`${source}\n${target}`, (weights.get(`${source}\n${target}`) || 0) + 1);
      });
      const links = [...weights].map(([key, weight]) => { const [source, target] = key.split('\n'); return { source, target, weight }; });
      const linked = new Set(links.flatMap(link => [link.source, link.target]));
      const nodes: Node[] = map.directories.filter(dir => (!needle || dir.path.toLowerCase().includes(needle)) && (!hideIsolated || linked.has(dir.path)))
        .map(dir => ({ id: dir.path, label: dir.path, group: groupOf(`${dir.path}/x`), size: Math.sqrt(dir.lines) / 3 + 3, files: dir.files, lines: dir.lines }));
      const ids = new Set(nodes.map(node => node.id));
      return { nodes, links: links.filter(link => ids.has(link.source) && ids.has(link.target)) };
    }
    const linked = new Set(map.edges.flatMap(edge => [edge.source, edge.target]));
    const nodes: Node[] = map.files.filter(file => (!needle || file.path.toLowerCase().includes(needle) || file.symbols.some(s => s.name.toLowerCase().includes(needle)))
      && (!hideIsolated || linked.has(file.path) || file.path === selected))
      .map(file => ({ id: file.path, label: base(file.path), group: groupOf(file.path), size: Math.sqrt(file.lines) / 4 + 2, file, lines: file.lines }));
    const ids = new Set(nodes.map(node => node.id));
    return { nodes, links: map.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).map(edge => ({ ...edge, weight: 1 })) };
  }, [map, mode, query, hideIsolated, selected]);

  const neighbours = useMemo(() => {
    const result = new Set<string>();
    if (!selected) return result;
    data.links.forEach(link => {
      const source = endpoint(link.source), target = endpoint(link.target);
      if (source === selected) result.add(target);
      if (target === selected) result.add(source);
    });
    return result;
  }, [data, selected]);

  useEffect(() => {
    if (!selected || !graph.current) return;
    const node = data.nodes.find(item => item.id === selected);
    if (node?.x != null && node.y != null) graph.current.centerAt(node.x, node.y, 400);
  }, [selected]);

  if (error) return <div className="atelier-empty"><p>{error}</p><button className="button" onClick={() => void load()}>Try again</button></div>;
  if (!map) return <p className="atelier-empty">Building the map of the code…</p>;
  const ink = token('--ink', '#1e1f1c'), muted = token('--subtle', '#7d7f78'), line = token('--line', '#e7e5de'), surface = token('--surface', '#ffffff'), accent = token('--accent', '#087e86');
  const current = selected && mode === 'files' ? files.get(selected) : null;
  const currentDir = selected && mode === 'folders' ? map.directories.find(dir => dir.path === selected) : null;

  function paint(node: Node, context: CanvasRenderingContext2D, scale: number) {
    const x = node.x || 0, y = node.y || 0;
    const active = node.id === selected, near = neighbours.has(node.id);
    const dim = selected && !active && !near;
    context.globalAlpha = dim ? 0.25 : 1;
    context.beginPath(); context.arc(x, y, node.size, 0, Math.PI * 2);
    context.fillStyle = color(node.group); context.fill();
    if (active) { context.lineWidth = 2.5 / scale; context.strokeStyle = accent; context.stroke(); }
    if (active || near || scale > 1.6 || (mode === 'folders' && scale > 0.7)) {
      context.font = `${active ? 600 : 500} ${11 / scale}px system-ui, sans-serif`;
      context.textAlign = 'center'; context.textBaseline = 'top';
      const width = context.measureText(node.label).width;
      context.fillStyle = surface; context.globalAlpha = dim ? 0.2 : 0.85;
      context.fillRect(x - width / 2 - 2 / scale, y + node.size + 2 / scale, width + 4 / scale, 13 / scale);
      context.globalAlpha = dim ? 0.3 : 1;
      context.fillStyle = ink; context.fillText(node.label, x, y + node.size + 3 / scale);
    }
    context.globalAlpha = 1;
  }

  return <div className="atelier-map">
    <div className="atelier-map-toolbar" role="toolbar" aria-label="Map controls">
      <div className="atelier-segmented" role="radiogroup" aria-label="Level">
        {(['files', 'folders'] as Mode[]).map(value => <button key={value} role="radio" aria-checked={mode === value} className={mode === value ? 'active' : ''} onClick={() => { setMode(value); setSelected(null); setSymbol(null); }}>{value === 'files' ? 'Files' : 'Folders'}</button>)}
      </div>
      <label className="atelier-search"><Icon name="search" size={12}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder={mode === 'files' ? 'Filter files or functions' : 'Filter folders'} aria-label="Filter"/></label>
      <label className="atelier-check"><input type="checkbox" checked={hideIsolated} onChange={event => setHideIsolated(event.target.checked)}/> Hide unconnected</label>
      <span className="atelier-muted">{data.nodes.length} {mode} · {data.links.length} imports{map.truncated ? ' · large folder, partial map' : ''}</span>
      <button className="button button-small" onClick={() => graph.current?.zoomToFit(400, 40)}>Fit</button>
      <button className="button button-small" disabled={busy} onClick={() => void load()}>{busy ? 'Updating…' : 'Update'}</button>
    </div>
    <div className="atelier-map-body">
      <div className="atelier-map-canvas" ref={host}>
        {data.nodes.length ? <ForceGraph2D ref={graph} width={size.width} height={size.height} graphData={data as any}
          backgroundColor="rgba(0,0,0,0)" nodeRelSize={1} cooldownTicks={120} d3VelocityDecay={0.35} minZoom={0.05} maxZoom={8}
          linkColor={(link: any) => selected && (endpoint(link.source) === selected || endpoint(link.target) === selected) ? accent : line}
          linkWidth={(link: any) => Math.min(4, 0.6 + Math.log2(1 + link.weight))}
          linkDirectionalArrowLength={3.5} linkDirectionalArrowRelPos={0.92} linkDirectionalArrowColor={() => muted}
          nodeCanvasObject={paint as any} nodePointerAreaPaint={(node: any, hit, context) => { context.fillStyle = hit; context.beginPath(); context.arc(node.x, node.y, node.size + 2, 0, Math.PI * 2); context.fill(); }}
          nodeLabel={(node: any) => `${node.id} · ${node.lines} lines`}
          onNodeClick={(node: any) => { setSelected(node.id === selected ? null : node.id); setSymbol(null); }}
          onBackgroundClick={() => { setSelected(null); setSymbol(null); }}
          onEngineStop={() => { if (!selected) graph.current?.zoomToFit(400, 40); }}/>
          : <p className="atelier-empty">{map.files.length ? 'Nothing matches these filters.' : 'No Python, JavaScript or TypeScript file found in this folder.'}</p>}
        <div className="atelier-legend" aria-label="Legend">{groups.slice(0, 10).map(group => <span key={group}><i style={{ background: color(group) }}/>{group}</span>)}</div>
      </div>
      <aside className="atelier-inspector" aria-label="Details">
        {current ? <>
          <header><span className="atelier-lang">{current.lang}</span><h3 title={current.path}>{base(current.path)}</h3><code>{current.path}</code></header>
          {current.doc && <p className="atelier-doc">{current.doc}</p>}
          {current.error && <p className="atelier-warning">{current.error}</p>}
          <div className="atelier-inspector-actions"><button className="button button-small button-primary" onClick={() => onOpen(current.path)}>Read the file</button><span className="atelier-muted">{current.lines} lines</span></div>
          <div className="atelier-symbol-links"><strong>Imports ({current.imports.length})</strong>{current.imports.map(path => <button key={path} className="text-link" onClick={() => setSelected(path)}>{path}</button>)}</div>
          <div className="atelier-symbol-links"><strong>Used by ({current.imported_by.length})</strong>{current.imported_by.map(path => <button key={path} className="text-link" onClick={() => setSelected(path)}>{path}</button>)}</div>
          {!!current.external.length && <div className="atelier-symbol-links"><strong>Packages</strong><span className="atelier-chips">{current.external.map(name => <code key={name}>{name}</code>)}</span></div>}
          <div className="atelier-symbols"><strong>Definitions ({current.symbols.length})</strong>
            {current.symbols.map(item => <div key={item.id} className={`atelier-symbol ${symbol?.id === item.id ? 'active' : ''}`}>
              <button onClick={() => setSymbol(symbol?.id === item.id ? null : item)}><span className={`atelier-kind ${item.kind}`}>{item.kind === 'function' ? 'fn' : item.kind === 'method' ? 'm' : item.kind === 'class' ? 'C' : 'T'}</span>{item.name}<small>:{item.line}</small>{(item.calls.length + item.called_by.length) > 0 && <small className="atelier-muted"> · {item.calls.length}→ {item.called_by.length}←</small>}</button>
              {symbol?.id === item.id && <div className="atelier-symbol-detail">
                {item.doc && <p className="atelier-doc">{item.doc}</p>}
                <button className="text-link" onClick={() => onOpen(current.path, item.line)}>Open at line {item.line}</button>
                <SymbolList title="Calls" ids={item.calls} files={files} onOpen={onOpen}/>
                <SymbolList title="Called by" ids={item.called_by} files={files} onOpen={onOpen}/>
              </div>}
            </div>)}
          </div>
        </> : currentDir ? <>
          <header><h3>{currentDir.path}</h3></header>
          <p className="atelier-muted">{currentDir.files} files · {currentDir.lines} lines</p>
          <button className="button button-small" onClick={() => { setMode('files'); setQuery(currentDir.path === '.' ? '' : `${currentDir.path}/`); setSelected(null); }}>Show its files</button>
        </> : <div className="atelier-inspector-help">
          <h3>Map of {folder.name}</h3>
          <p>{map.files.length} source files ({map.languages.join(', ') || 'none'}) · {map.edges.length} imports between files.</p>
          <p>Each dot is a file, coloured by folder and sized by its length. An arrow goes from a file to the file it imports. Click a file to see its definitions, what it calls and what uses it.</p>
          <p className="atelier-muted">Python calls are resolved from imports; for JavaScript and TypeScript the map shows imports and top-level declarations.</p>
        </div>}
      </aside>
    </div>
  </div>;
}
