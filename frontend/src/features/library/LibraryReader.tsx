import { registerAgentContext } from '../externalAgents/context';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { noteAssetBase, state } from '../../app/state';
import { api } from '../../services/api';
import { registerAgentSave } from '../../app/agentEvents';
import { Icon } from '../../components/Icon';
import { bindPdfCapture, pdfCaptureWorkspaceMarkup } from './documents';
import { bindMarkdownBlockEditor, currentMarkdownBlockInput, markdownBlockEditorMarkup, markdownBlockSourceOffset, setMarkdownBlockEditorContent } from '../documents/markdown';
import { applyMarkdownToEditor, bindMarkdownWritingExperience, markdownFormattingToolbarMarkup } from '../documents/workspace';

type ReaderData = { paper: Paper; note: Note };

const splitKey = 'kavot-reader-pdf-ratio';
const clampRatio = (ratio: number) => Math.max(.2, Math.min(.8, ratio));
const storedRatio = () => {
  try { return clampRatio(Number(localStorage.getItem(splitKey)) || .57); } catch { return .57; }
};

export function LibraryReader({ paperId, onBack }: { paperId: number; onBack: () => void }) {
  const [reader, setReader] = useState<ReaderData | null>(null);
  const [error, setError] = useState('');
  const host = useRef<HTMLElement>(null);
  const status = useRef<HTMLSpanElement>(null);
  const saveRef = useRef<() => Promise<Note | null>>(async () => null);
  const workspace = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(storedRatio);

  useEffect(() => {
    try { localStorage.setItem(splitKey, String(ratio)); } catch { /* Retain the session preference. */ }
  }, [ratio]);

  const stacked = () => !!workspace.current && getComputedStyle(workspace.current).gridTemplateRows.trim().split(/\s+/).length > 1;
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const grid = workspace.current;
    if (!grid || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const vertical = stacked();
    handle.setPointerCapture(event.pointerId);
    grid.classList.add('resizing');
    const move = (moveEvent: PointerEvent) => {
      const box = grid.getBoundingClientRect();
      setRatio(clampRatio(vertical ? (moveEvent.clientY - box.top) / box.height : (moveEvent.clientX - box.left) / box.width));
    };
    const stop = () => {
      grid.classList.remove('resizing');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  };
  const keyResize = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: -.02, ArrowUp: -.02, ArrowRight: .02, ArrowDown: .02 }[event.key];
    if (!step) return;
    event.preventDefault();
    setRatio(current => clampRatio(current + step));
  };

  useEffect(() => {
    let active = true;
    setReader(null); setError('');
    void (async () => {
      try {
        const paper = await api<Paper>(`/papers/${paperId}`);
        const notes = await api<Note[]>(`/notes?paper_id=${paperId}`);
        const note = notes[0] || await api<Note>('/notes', {
          method: 'POST',
          body: JSON.stringify({ paper_id: paper.id, title: `Notes — ${paper.title}`, content: '' }),
        });
        if (active) setReader({ paper, note });
      } catch (reason) {
        if (active) setError((reason as Error).message);
      }
    })();
    return () => { active = false; };
  }, [paperId]);

  useEffect(() => {
    if (!reader || !host.current) return;
    const root = host.current;
    const unregisterContext = registerAgentContext(root, () => ({ area: 'reader', paper_id: reader.paper.id, note_id: reader.note.id }));
    const source = root.querySelector<HTMLTextAreaElement>('#library-reader-note-source');
    const editor = root.querySelector<HTMLElement>('#library-reader-note-editor');
    if (!source || !editor) { unregisterContext(); return; }
    source.dataset.agentNoteId = String(reader.note.id);
    editor.dataset.agentNoteId = String(reader.note.id);
    const cached = state.notes.find(note => note.id === reader.note.id);
    if (cached) Object.assign(cached, reader.note); else state.notes.push(reader.note);
    bindMarkdownBlockEditor(editor, source);
    bindMarkdownWritingExperience(source);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let savedContent = source.value;
    let saving: Promise<Note | null> = Promise.resolve(reader.note);
    const setStatus = (message: string) => { if (status.current) status.current.textContent = message; };
    const save = async (): Promise<Note | null> => {
      clearTimeout(timer); timer = undefined;
      if (source.value === savedContent) return saving;
      const content = source.value;
      setStatus('Saving…');
      saving = saving.catch(() => null).then(async () => {
        const current = state.notes.find(note => note.id === reader.note.id) || reader.note;
        const updated = await api<Note>(`/notes/${reader.note.id}`, { method: 'PATCH', body: JSON.stringify({ content, expected_hash: current.content_hash }) });
        Object.assign(current, updated);
        savedContent = updated.content;
        setStatus(source.value === savedContent ? 'Saved' : 'Unsaved changes…');
        return updated;
      }).catch(() => { setStatus('Save failed — draft kept locally'); return null; });
      return saving;
    };
    const queueSave = () => { setStatus('Unsaved changes…'); clearTimeout(timer); timer = setTimeout(() => { void save(); }, 650); };
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
    };
    const format = (event: Event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-reader-md-action]');
      if (!button || !root.contains(button)) return;
      applyMarkdownToEditor(currentMarkdownBlockInput(editor, true), button.dataset.readerMdAction);
    };
    source.addEventListener('input', queueSave);
    root.addEventListener('keydown', shortcut);
    root.addEventListener('click', format);
    saveRef.current = save;
    const unregisterAgentSave = registerAgentSave(async () => {
      const saved = await save();
      if (!saved) throw new Error('The PDF reader note must be saved before starting an agent.');
    });
    const agentUpdated = (event: Event) => {
      const updated = (event as CustomEvent).detail.notes.find((note: Note) => note.id === reader.note.id);
      if (updated && updated.content !== savedContent) {
        // Update only the note document; keep the PDF viewer and its scroll/zoom alive.
        clearTimeout(timer); timer = undefined;
        savedContent = updated.content;
        saving = Promise.resolve(updated);
        Object.assign(reader.note, updated);
        setMarkdownBlockEditorContent(editor, source, updated.content, null, null, true);
        setStatus('Saved');
      }
    };
    window.addEventListener('kavot:agent-notes-updated', agentUpdated);
    const disposePdf = reader.paper.file_path ? bindPdfCapture(
      reader.paper,
      source,
      editor,
      noteAssetBase(reader.note),
      save,
      () => ({ sourceEnd: markdownBlockSourceOffset(editor, currentMarkdownBlockInput(editor)) }),
      root,
      true,
    ) : undefined;
    return () => {
      clearTimeout(timer);
      unregisterAgentSave();
      unregisterContext();
      window.removeEventListener('kavot:agent-notes-updated', agentUpdated);
      source.removeEventListener('input', queueSave);
      root.removeEventListener('keydown', shortcut);
      root.removeEventListener('click', format);
      if (source.value !== savedContent) void save();
      disposePdf?.();
    };
  }, [reader]);

  // Freeze injected markup: resizing re-renders, and saves mutate reader.note in place.
  const noteMarkup = useMemo(() => reader ? markdownBlockEditorMarkup(reader.note.content || '', {
    sourceId: 'library-reader-note-source', editorId: 'library-reader-note-editor', assetBase: noteAssetBase(reader.note), ariaLabel: `Reading note — ${reader.paper.title}`,
  }) : '', [reader]);
  const pdfMarkup = useMemo(() => reader?.paper.file_path ? pdfCaptureWorkspaceMarkup(reader.paper.id, true) : '', [reader]);
  const toolbarMarkup = useMemo(() => markdownFormattingToolbarMarkup('data-reader-md-action'), []);

  if (error) return <section className="library-reader library-reader-error"><button className="button" onClick={onBack}>← Back to library</button><p role="alert">Unable to open this article. {error}</p></section>;
  if (!reader) return <section className="library-reader library-reader-loading" role="status">Opening article…</section>;
  const { paper } = reader;
  const byline = [...(paper.authors || []), paper.published_at].filter(Boolean).join(' · ');
  return <section className="library-reader" ref={host}>
    <header className="library-reader-header">
      <button className="library-reader-back" aria-label="Back to library" title="Back to library" onClick={() => void saveRef.current().then(saved => { if (saved) onBack(); })}><span aria-hidden="true">←</span></button>
      <h1 title={byline ? `${paper.title}\n${byline}` : paper.title}>{paper.title}</h1>
      <div className="library-reader-save"><span ref={status} role="status">Saved</span><button className="library-reader-save-button" aria-label="Save note" title="Save note (Ctrl+S)" onClick={() => void saveRef.current()}><Icon name="check" size={14}/></button></div>

    </header>
    <div className="library-reader-workspace" ref={workspace} style={{ '--reader-pdf-ratio': ratio } as CSSProperties}>
      <section className="library-reader-pdf" aria-label="Article PDF">{paper.file_path ? <div dangerouslySetInnerHTML={{ __html: pdfMarkup }}/> : <div className="paper-reader-error">No PDF is attached to this article yet.</div>}</section>
      <div className="library-reader-splitter" role="separator" tabIndex={0} aria-label="Resize the PDF and note panes" aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(ratio * 100)} title="Drag to resize · double-click to reset" onPointerDown={startResize} onKeyDown={keyResize} onDoubleClick={() => setRatio(.57)}/>
      <section className="library-reader-notes note-pane note-editor" aria-label="Reading notes">
        <div dangerouslySetInnerHTML={{ __html: toolbarMarkup }}/>
        <div className="library-reader-note-editor markdown-block-shell" dangerouslySetInnerHTML={{ __html: noteMarkup }}/>
      </section>
    </div>
  </section>;
}
