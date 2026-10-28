import { DeleteRecordButton, RecordActions } from '../../components/CollectionControls';
import { useRuntime } from '../../app/runtime';
import { useState } from 'react';
import { api } from '../../services/api';
import { publish } from '../../app/viewBridge';
import { toast } from '../../app/navigation';
export function PaperRow({ paper, projectId, onCitationGraph, onPreview }: { paper: Paper; projectId?: number; onCitationGraph?: (paper: Paper) => void; onPreview?: (paper: Paper) => void }) {
  const { labels, paperPublicationYear, state } = useRuntime();
  const [saving, setSaving] = useState(false);
  const toggleFavorite = async () => {
    setSaving(true);
    try {
      const updated = await api<Paper>(`/papers/${paper.id}`, { method: 'PATCH', body: JSON.stringify({ favorite: !paper.favorite }) });
      state.papers = state.papers.map(item => item.id === paper.id ? updated : item);
      publish();
    } catch (error) { toast(error.message, 'error'); }
    finally { setSaving(false); }
  };
  // One table row, laid out like every article table (Library, Watch agents).
  return <tr className="paper-row library-entry" data-paper={paper.id} data-project-context={projectId} aria-label={paper.title}>
    <td className="paper-cell-article"><div className="library-entry-reference"><span className="paper-drag-handle" draggable data-paper-drag={paper.id} title="Drag to organize" aria-label={`Drag ${paper.title}`}>⠿</span><div className="view-cell-stack library-entry-copy"><button className="library-entry-title" data-action={onPreview ? undefined : 'open-paper-workspace'} data-paper-id={paper.id} data-project-id={projectId} title={onPreview ? `Preview “${paper.title}”` : paper.title} onClick={onPreview && (() => onPreview(paper))}>{paper.title}</button><small className="library-entry-authors" title={paper.authors.join(', ')}>{paper.authors.join(', ') || 'Unknown author'}</small></div></div></td>
    <td className="paper-cell-year">{paperPublicationYear(paper) || '—'}</td>
    <td className="paper-cell-status"><div className="library-entry-status" data-paper-control><span className={`library-status-dot status-${paper.status || 'to_read'}`}/><select data-paper-status={paper.id} aria-label={`Reading status for ${paper.title}`} defaultValue={paper.status || 'to_read'} key={paper.status}>{['to_read', 'reading', 'read', 'key'].map(status => <option key={status} value={status}>{labels[status]}</option>)}</select></div></td>
    <td className="paper-cell-actions">
    <div className="library-entry-actions" data-paper-control>
      <button className="favorite-toggle" aria-label={`Favori : ${paper.title}`} title={paper.favorite ? 'Remove from favorites' : 'Add to favorites'} aria-pressed={!!paper.favorite} disabled={saving} onClick={toggleFavorite}>{paper.favorite ? '★' : '☆'}</button>
      <button className={`button button-small ${paper.file_path ? 'library-open-pdf' : ''}`} data-action={paper.file_path ? 'open-paper-workspace' : 'add-paper-pdf'} data-paper-id={paper.id} data-project-id={projectId}>{paper.file_path ? 'Read article' : 'Add PDF'}</button>

      {onCitationGraph && <button className="button button-small" title="Discover references and citing articles" onClick={() => onCitationGraph(paper)}>Graph</button>}
      <RecordActions title={paper.title}>
        <button data-action="edit-paper" data-paper-id={paper.id}>Edit article</button>
        {projectId && <button data-remove-paper-project={paper.id} data-project-id={projectId} aria-label={`Remove article from project: ${paper.title}`}>Remove from project</button>}
        <DeleteRecordButton endpoint={'/papers/' + paper.id} title={paper.title}/>
      </RecordActions>
    </div>
    </td>
  </tr>;
}
