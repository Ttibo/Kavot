import { escapeHtml, state, truncate } from '../../app/state';
import { collectionItems, collectionDragPayload } from './catalog';

export function canvasCollections() {
  const defaults = [{id:'articles',name:'Articles'}, {id:'tasks',name:'Tasks'}, {id:'conferences',name:'Conferences'}, {id:'datasets',name:'Datasets'}];
  const catalog = new Map(defaults.map(item => [item.id, item]));
  for (const item of state.databases || []) catalog.set(item.id, item);
  return [...catalog.values()].filter(database => database.id !== 'notes');
}

export function canvasCollectionItems(databaseId: string, projectId: number | null = null) {
  const items = collectionItems(databaseId);
  if (!projectId) return items;
  const belongs = (source: any) => Number(source.project_id) === projectId || source.project_ids?.some(id => Number(id) === projectId) || source.projects?.some(project => Number(project.id) === projectId);
  return items.filter(item => belongs(item.source) || belongs(item.source.values || {}) || (item.type === 'note' && item.source.paper_id && state.papers.some(paper => paper.id === item.source.paper_id && belongs(paper))));
}

export function collectionCardPreview(node: any) {
  const databaseId = node.databaseId || 'articles';
  const projectId = node.type === 'articles' || node.scope === 'project' ? Number(node.projectId) || null : null;
  const items = canvasCollectionItems(databaseId, projectId);
  return `<div class="canvas-database-preview" data-collection-preview="${escapeHtml(databaseId)}" data-collection-project="${projectId || ''}"><div class="canvas-collection-caption">${items.length} item${items.length === 1 ? '' : 's'} · ${projectId ? 'This project' : 'Workspace'} · Live collection</div>${items.length ? `<table><thead><tr><th>Title</th><th>Details</th><th>Status</th></tr></thead><tbody>${items.map(item => `<tr><td><button data-canvas-collection-item="${escapeHtml(collectionDragPayload(item.type, item.id, databaseId))}" title="Add this item to the canvas">${escapeHtml(item.title)}</button></td><td>${escapeHtml(truncate(item.detail || '', 90))}</td><td>${escapeHtml(item.meta || '—')}</td></tr>`).join('')}</tbody></table>` : '<div class="canvas-collection-empty"><strong>No items yet</strong><p>Items added to this collection will appear here automatically.</p></div>'}</div>`;
}

export function refreshCanvasCollections() {
  document.querySelectorAll<HTMLElement>('[data-collection-preview]').forEach(element => {
    const holder = document.createElement('div');
    holder.innerHTML = collectionCardPreview({ type:'collection', databaseId:element.dataset.collectionPreview, scope:element.dataset.collectionProject ? 'project' : 'all', projectId:Number(element.dataset.collectionProject) || null });
    element.replaceWith(holder.firstElementChild!);
  });
}
