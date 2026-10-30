import { state } from '../../app/state';
import { editorSession } from '../../app/editorSession';
import { findCollectionItem, parseCollectionDragPayload } from '../collections/catalog';

export function internalTransfer(transfer: DataTransfer | null) {
  return ['workspace', 'collection', 'note', 'paper'].map(kind => transfer?.getData(`application/x-kavot-${kind}`)).find(Boolean)
    || transfer?.getData('text/plain') || editorSession.activeDragPayload || '';
}

export function hasInternalTransfer(transfer: DataTransfer | null) {
  return [...(transfer?.types || [])].some(type => type.startsWith('application/x-kavot-'))
    || ['note', 'workspace', 'collection', 'paper', 'task'].includes(editorSession.activeDragType);
}

export function droppedLink(payload: string): string | null {
  const link = (title: string, href: string) => `[${String(title).replace(/[\\[\]]/g, '\\$&').replace(/\s+/g, ' ')}](${href})`;
  if (payload.startsWith('database:')) {
    const id = payload.slice(9);
    const database = state.databases.find(item => item.id === id);
    return database ? link(database.name, `#collection/${encodeURIComponent(id)}`) : null;
  }
  if (payload.startsWith('note:')) {
    const note = state.notes.find(item => item.id === Number(payload.slice(5)));
    return note ? link(note.title, `#note-${note.id}`) : null;
  }
  if (payload.startsWith('paper:')) {
    const paper = state.papers.find(item => item.id === Number(payload.slice(6)));
    return paper ? link(paper.title, `#paper-${paper.id}`) : null;
  }
  const reference = parseCollectionDragPayload(payload);
  if (reference) {
    const item = findCollectionItem(reference);
    if (!item) return null;
    if (item.type === 'note') return link(item.title, `#note-${item.id}`);
    return link(item.title, `#record/${encodeURIComponent(JSON.stringify(reference))}`);
  }
  if (payload.startsWith('workspace:')) {
    const path = payload.slice(10);
    const find = (nodes): any => {
      for (const node of nodes || []) {
        if (node.path === path) return node;
        const child = find(node.children);
        if (child) return child;
      }
    };
    const node = find(state.workspaceTree);
    if (!node) return null;
    const url = `/api/workspace/file?path=${encodeURIComponent(path)}`;
    // An image dropped into a note is shown, not linked.
    if (node.kind === 'image' || /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(path)) return `!${link(node.label || node.name, url)}`;
    return link(node.label || node.name, node.note_id ? `#note-${node.note_id}` : url);
  }
  return null;
}
