import { openCollectionDatabase, openCollectionItem, parseCollectionDragPayload } from '../collections/catalog';
import { state, flushReaderAutosave } from '../../app/state';
import { toast } from '../../app/navigation';
import { closeContextMenu, showContextMenu } from '../../components/contextMenu';
import { flushCanvasSaves } from './canvas';
import { applyWorkspaceTab, ensureWorkspaceTab, findWorkspaceNode, flushCurrentNoteAutosave, flushSecondaryNoteAutosave, flushWorkspaceMarkdownSaves, rerenderNotesContext, workspaceNoteTab, workspaceResourcePayload, workspaceResourceTab } from './workspace';

type Destination = { noteId?: number; node?: any; resource?: WorkspaceResource };

function findNoteFile(noteId: number, nodes = state.workspaceTree): any {
  for (const node of nodes || []) {
    if (Number(node.note_id) === noteId) return node;
    const found = findNoteFile(noteId, node.children || []);
    if (found) return found;
  }
  return null;
}

function destination(link: HTMLAnchorElement): Destination | null {
  const href = link.getAttribute('href') || '';
  const noteId = Number(link.dataset.note || href.match(/^#note-(\d+)$/)?.[1]);
  if (noteId) return { noteId };
  const paperId = Number(href.match(/^#paper-(\d+)$/)?.[1]);
  if (paperId) return { resource: { type: 'pdf', path: `paper:${paperId}`, paperId, title: state.papers.find(p => p.id === paperId)?.title || 'Article PDF', url: `/api/papers/${paperId}/file` } };
  if (href.startsWith('#') && !link.dataset.openWorkspaceResource) return null;
  const pane = link.closest<HTMLElement>('[data-primary-note-id], [data-secondary-note-id], [data-workspace-markdown-path], [data-relational-note-path]');
  const sourceId = Number(pane?.dataset.primaryNoteId || pane?.dataset.secondaryNoteId);
  const source = pane?.dataset.workspaceMarkdownPath || pane?.dataset.relationalNotePath || (sourceId ? findNoteFile(sourceId)?.path : '');
  try {
    const url = new URL(href, source ? `${location.origin}/${source}` : location.href);
    if (url.origin !== location.origin) return null;
    const path = link.dataset.openWorkspaceResource || (url.pathname === '/api/workspace/file' ? url.searchParams.get('path') : decodeURIComponent(url.pathname.slice(1)));
    const node = path ? findWorkspaceNode(path) : null;
    if (node) return node.note_id ? { noteId: Number(node.note_id) } : { node };
    const paper = url.pathname.match(/^\/api\/papers\/(\d+)\/file$/);
    const asset = url.pathname.match(/^\/api\/notes\/\d+\/assets\/[^/]+$/);
    if (paper || asset || url.pathname.startsWith('/api/databases/resources/files/')) {
      const extension = url.pathname.split('.').pop()?.toLowerCase();
      return { resource: { type: paper || extension === 'pdf' ? 'pdf' : ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(extension) ? 'image' : 'file', path: url.pathname, url: url.pathname + url.search, title: link.textContent || 'File', ...(paper ? { paperId: Number(paper[1]) } : {}) } };
    }
  } catch { /* Malformed and external links retain their normal browser behaviour. */ }
  return null;
}

/** Leave a dialog (task, record…) before showing a document; its own guard may save or keep it open. */
async function leaveModal(link: HTMLAnchorElement) {
  if (!link.closest('#modal')) return true;
  const { closeModal } = await import('../../components/dialogs/controller');
  await closeModal();
  return document.querySelector('#modal-backdrop')?.classList.contains('hidden') ?? true;
}

async function openLink(link: HTMLAnchorElement, target: Destination, beside: boolean) {
  try {
    if (!await leaveModal(link)) return;
    if (state.view !== 'notes') {
      const { getRuntime } = await import('../../app/runtime');
      await getRuntime().navigate('notes');
    }
    const sourcePane = link.closest<HTMLElement>('[data-pane-drop]')?.dataset.paneDrop || state.activeNotePane || 'primary';
    const pane = beside ? sourcePane === 'secondary' ? 'primary' : 'secondary' : sourcePane;
    await flushCurrentNoteAutosave();
    await flushSecondaryNoteAutosave();
    await flushWorkspaceMarkdownSaves();
    await flushReaderAutosave();
    await flushCanvasSaves();
    let tab;
    if (target.noteId) {
      const note = state.notes.find(n => n.id === target.noteId);
      if (!note) throw new Error('This note no longer exists');
      tab = workspaceNoteTab(note);
    } else {
      tab = workspaceResourceTab(target.node ? await workspaceResourcePayload(target.node) : target.resource);
    }
    // Keep the destination's existing tabs as well as the source document.
    ensureWorkspaceTab(pane, tab);
    applyWorkspaceTab(pane, tab);
    rerenderNotesContext();
  } catch (error) { toast(error.message, 'error'); }
}

export function initializeDocumentLinks() {
  const close = () => closeContextMenu();
  const noteLink = (event: Event) => {
    const link = (event.target as Element)?.closest<HTMLAnchorElement>('a');
    return link?.closest('#main-content, #modal, .record-sheet') && link.closest('.continuous-editor, .rich-editor, .markdown-preview, .relational-note-content, .canvas-node-content') ? link : null;
  };
  // Modified clicks in a contenteditable can become selection gestures without
  // a browser click event. Handle the pointer gesture before ProseMirror does.
  let pointerLink: HTMLAnchorElement | null = null;
  document.addEventListener('pointerdown', event => {
    pointerLink = null;
    const link = noteLink(event);
    if (!link?.closest('.rich-content') || event.button !== 0 || !(event.shiftKey || event.ctrlKey || event.metaKey)) return;
    pointerLink = link;
    event.preventDefault();
    event.stopImmediatePropagation();
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey }));
  }, true);
  document.addEventListener('click', event => {
    const link = noteLink(event);
    if (!link) return;
    if (event.isTrusted && pointerLink === link) { event.preventDefault(); event.stopImmediatePropagation(); pointerLink = null; return; }
    if (link.closest('.rich-content') && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    const href = link.getAttribute('href') || '';
    if (link.matches('.cm-link') && !event.ctrlKey && !event.metaKey && !event.shiftKey) return;
    if (href.startsWith('#collection/') || href.startsWith('#record/')) {
      if (!event.shiftKey && link.matches('.cm-link') && !event.ctrlKey && !event.metaKey) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (href.startsWith('#collection/')) void openCollectionDatabase(decodeURIComponent(href.slice(12)));
      else {
        const reference = parseCollectionDragPayload('collection:' + href.slice(8));
        if (reference) void openCollectionItem(reference);
      }
      return;
    }
    const target = destination(link);
    if (!target) {
      if (!/^(https?:\/\/|mailto:)/i.test(href)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
      if (window.pywebview?.api?.open_external_url) {
        void window.pywebview.api.open_external_url(href).then(opened => {
          if (opened === false) toast('This link could not be opened', 'error');
        }).catch(error => toast(error.message, 'error'));
      } else window.open(href, '_blank', 'noopener,noreferrer');
      return;
    }
    // Live preview keeps its editing gesture; Shift+click opens directly beside.
    if (!event.shiftKey && /^#paper-/.test(link.getAttribute('href') || '')) return;
    if (!event.shiftKey && link.matches('.cm-link') && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
    void openLink(link, target, event.shiftKey);
  }, true);
  document.addEventListener('contextmenu', event => {
    close();
    const link = noteLink(event);
    const target = link && destination(link);
    if (!link || !target) return;
    event.preventDefault();
    const rect = link.getBoundingClientRect();
    showContextMenu([
      { label: 'Open document', run: () => openLink(link, target, false) },
      { label: 'Open to the side', run: () => openLink(link, target, true) },
    ], event.clientX || rect.left, event.clientY || rect.bottom, link, 'Document link');
  });
}

/** What a link points to, in words, for the link bubble of the editor. */
export function describeLink(link: HTMLAnchorElement): { title: string; detail: string; href: string; internal: boolean } {
  const href = link.getAttribute('href') || '';
  if (href.startsWith('#record/') || href.startsWith('#collection/')) {
    const reference = href.startsWith('#record/') ? parseCollectionDragPayload('collection:' + href.slice(8)) as any : null;
    const collection = reference?.databaseId || decodeURIComponent(href.slice(12));
    const name = state.databases.find(item => item.id === collection)?.name || collection;
    return { title: link.textContent || name, detail: reference ? `Item of ${name}` : 'Collection', href, internal: true };
  }
  const target = destination(link);
  if (target?.noteId) {
    const note = state.notes.find(item => item.id === target.noteId);
    return { title: note?.title || 'Missing note', detail: note ? 'Note' : 'This note no longer exists', href, internal: true };
  }
  if (target?.resource?.paperId) {
    const paper = state.papers.find(item => item.id === target.resource.paperId);
    return { title: paper?.title || 'Article', detail: 'Article', href, internal: true };
  }
  if (target) return { title: target.node?.title || target.resource?.title || link.textContent || 'Document', detail: target.node?.path || target.resource?.path || 'Workspace file', href, internal: true };
  return { title: link.textContent || href, detail: href, href, internal: false };
}

/** Open a link as a click would, from any editor (including dialogs); returns false when nothing could open it. */
export async function followLink(link: HTMLAnchorElement, beside = false) {
  const href = link.getAttribute('href') || '';
  closeContextMenu();
  if (href.startsWith('#collection/') || href.startsWith('#record/')) {
    if (!await leaveModal(link)) return true;
    if (href.startsWith('#collection/')) await openCollectionDatabase(decodeURIComponent(href.slice(12)));
    else {
      const reference = parseCollectionDragPayload('collection:' + href.slice(8));
      if (reference) await openCollectionItem(reference);
    }
    return true;
  }
  const target = destination(link);
  if (target) { await openLink(link, target, beside); return true; }
  if (/^(https?:\/\/|mailto:)/i.test(href)) {
    if (window.pywebview?.api?.open_external_url) {
      const opened = await window.pywebview.api.open_external_url(href).catch(() => false);
      if (opened === false) toast('This link could not be opened', 'error');
    } else window.open(href, '_blank', 'noopener,noreferrer');
    return true;
  }
  toast('This link does not point to a document', 'info');
  return false;
}
