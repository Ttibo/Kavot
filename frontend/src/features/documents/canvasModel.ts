
export function canvasTemplateIcon(template: any): string {
  return template?.icon || 'note';
}

/** Open the current notes workspace and its ancestors, leaving its folders closed. */
export function canvasNoteTreeOpenPaths(nodes: any[], projectId: number | null): Set<string> {
  const paths = new Set<string>();
  const visit = (items: any[], ancestors: string[]) => {
    for (const node of items || []) {
      const lineage = [...ancestors, node.path].filter(Boolean);
      const context = node.creation_context;
      const projectRoot = !node.note_id && !node.folder_id &&
        (context?.folder_id == null && Number(context?.project_id) === projectId ||
         node.kind === 'project' && Number(node.project_id) === projectId);
      if (projectId ? projectRoot : node.path === 'notes/general') {
        lineage.forEach(path => paths.add(path));
      } else visit(node.children, lineage);
    }
  };
  visit(nodes, []);
  return paths;
}

export function canvasWebUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

/** Convert the former card-wide fold into independent connection states. */
export function migrateCanvasBranchFolds(content: { nodes: any[]; edges: any[] }) {
  for (const node of content.nodes) {
    if (node.collapsed) {
      for (const edge of content.edges) {
        if (edge.fromNode === node.id && edge.collapsed == null) edge.collapsed = true;
      }
    }
    delete node.collapsed;
  }
}

export function canvasHiddenNodes(nodes: any[], edges: any[]): Set<string> {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const outgoing = new Map<string, any[]>();
  const incoming = new Set<string>();
  for (const edge of edges) {
    if (!byId.has(edge.fromNode) || !byId.has(edge.toNode)) continue;
    outgoing.set(edge.fromNode, [...(outgoing.get(edge.fromNode) || []), edge]);
    incoming.add(edge.toNode);
  }
  const visit = (seeds: string[], visited: Set<string>, expandedOnly: boolean) => {
    const pending = [...seeds];
    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const edge of outgoing.get(id) || []) {
        if (!expandedOnly || !edge.collapsed) pending.push(edge.toNode);
      }
    }
  };
  const roots = nodes.filter(node => !incoming.has(node.id) || node.type === 'project').map(node => node.id);
  const reachable = new Set<string>();
  visit(roots, reachable, false);
  // A standalone directed cycle also needs an entry point; keep it stable when folding.
  for (const node of nodes) {
    if (!reachable.has(node.id)) {
      roots.push(node.id);
      visit([node.id], reachable, false);
    }
  }
  const visible = new Set<string>();
  visit(roots, visible, true);
  return new Set(nodes.filter(node => !visible.has(node.id)).map(node => node.id));
}

function canvasZoneMembers(zone: any, nodes: any[]): any[] {
  return nodes.filter(node => node.id !== zone.id && node.type !== 'project' &&
    node.x >= zone.x && node.y >= zone.y &&
    node.x + node.width <= zone.x + zone.width && node.y + node.height <= zone.y + zone.height);
}

/** A branch moves as one set, including folded nodes and each shared child once. */
export function canvasMovementNodes(root: any, nodes: any[], edges: any[]): any[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) outgoing.set(edge.fromNode, [...(outgoing.get(edge.fromNode) || []), edge.toNode]);
  const visited = new Set<string>();
  const pending = [root.id];
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id) || !byId.has(id)) continue;
    visited.add(id);
    const node = byId.get(id);
    pending.push(...(outgoing.get(id) || []));
    if (node.type === 'zone') pending.push(...canvasZoneMembers(node, nodes).map(item => item.id));
  }
  return nodes.filter(node => visited.has(node.id));
}
