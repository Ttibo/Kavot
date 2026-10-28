import { renderMarkdown } from '../app/state';
import { getRuntime } from '../app/runtime';
import { applyWorkspaceTab, ensureWorkspaceTab, workspaceNoteTab, rerenderNotesContext, findWorkspaceNode, workspaceResourcePayload, workspaceResourceTab } from '../features/documents/workspace';
import { prepareAgentContext } from '../features/externalAgents/sync';

/** The existing Markdown renderer escapes HTML. Local citations open real objects. */
export function AgentMessageContent({ content, onNavigate }: { content: string; onNavigate?: () => void }) {
  const open = async (link: HTMLAnchorElement) => {
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin) return;
    const runtime = getRuntime();
    await prepareAgentContext();
    const noteId = Number(url.searchParams.get('note_id') || url.hash.match(/^#note-(\d+)/)?.[1]);
    const paperId = Number(url.searchParams.get('paper_id') || url.hash.match(/^#paper-(\d+)/)?.[1]);
    if (paperId) { await runtime.openPaper(paperId); onNavigate?.(); return; }
    const note = runtime.state.notes.find(item => item.id === noteId);
    const node = url.pathname === '/api/workspace/file' ? findWorkspaceNode(url.searchParams.get('path')) : null;
    const tab = note ? workspaceNoteTab(note) : node ? workspaceResourceTab(await workspaceResourcePayload(node)) : null;
    if (tab) {
      await runtime.navigate('notes');
      ensureWorkspaceTab('primary', tab); applyWorkspaceTab('primary', tab); rerenderNotesContext();
      onNavigate?.();
    }
  };
  // Relative ./ links are supported by the shared renderer and resolve to the
  // same origin without broadening its allowed URL protocols.
  const source = content.replace(/\]\(\/(\?view=|api\/workspace\/file\?)/g, '](./$1');
  return <div className="agent-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(source) }} onClick={event => {
    const link = (event.target as Element).closest<HTMLAnchorElement>('a');
    if (!link) return;
    const url = new URL(link.href, location.href);
    if (url.origin === location.origin && (url.searchParams.has('note_id') || url.searchParams.has('paper_id') || url.pathname === '/api/workspace/file' || /^#(?:note|paper)-/.test(url.hash))) {
      event.preventDefault(); void open(link).catch(reason => getRuntime().toast(reason.message, 'error'));
    }
  }}/>;
}
