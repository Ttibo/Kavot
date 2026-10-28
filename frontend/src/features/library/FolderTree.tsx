import { useRuntime } from '../../app/runtime';
import { cssVars } from '../../components/common';
import { paperFolderIds } from './filters';
export function FolderTree({ parentId = null, depth = 0, seen = new Set<number>() }: { parentId?: number | null; depth?: number; seen?: Set<number> }) {
  const { state, paperFolderCount } = useRuntime();
  const folders = state.paperFolders.filter((folder: PaperFolder) => folder.parent_id === parentId && !seen.has(folder.id));
  return <>{folders.map((folder: PaperFolder) => {
    const collapsed = !state.expandedPaperFolders.has(folder.id);
    const papers = state.papers.filter((paper: Paper) => paperFolderIds(paper).includes(folder.id));
    return <div key={folder.id} className="paper-folder-branch">
      <div className={`paper-folder-row ${state.paperFolderFilter === String(folder.id) ? 'active' : ''}`} data-paper-folder-drop={folder.id} style={cssVars({ '--paper-depth': depth })}>
        <button className="tree-toggle" data-toggle-paper-folder={folder.id} aria-label={collapsed ? 'Expand' : 'Collapse'} aria-expanded={!collapsed}>{collapsed ? '›' : '⌄'}</button>
        <button className="paper-folder-label" draggable data-paper-folder-drag={folder.id} data-library-paper-folder={folder.id} title={`${folder.name} · Drag to a folder to move, or to a project to link its articles`}><span>▤</span><strong>{folder.name}</strong><small>{paperFolderCount(folder.id)}</small></button>
        <div className="paper-folder-actions"><button data-action="new-paper-folder" data-parent-paper-folder-id={folder.id} title="Create subfolder">＋</button><button data-action="edit-paper-folder" data-paper-folder-id={folder.id} title="Edit folder">•••</button></div>
      </div>
      {!collapsed && <>
        {papers.map((paper: Paper) => <button key={paper.id} className="paper-tree-leaf" data-action="open-paper-workspace" data-paper={paper.id} data-paper-id={paper.id} style={cssVars({ '--paper-depth': depth })} title={`Open ${paper.title}`}><span>{paper.file_path ? '▧' : '▤'}</span><strong>{paper.title}</strong></button>)}
        <FolderTree parentId={folder.id} depth={depth + 1} seen={new Set([...seen, folder.id])}/>
      </>}
    </div>;
  })}</>;
}
