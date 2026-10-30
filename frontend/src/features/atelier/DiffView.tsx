import { useState } from 'react';
import type { FileDiff } from './types';

const LINE_LIMIT = 1500;

function Patch({ patch }: { patch: string }) {
  const [all, setAll] = useState(false);
  const lines = patch.split('\n');
  // The `diff --git` and index headers repeat the file name shown above.
  const body = lines.slice(Math.max(0, lines.findIndex(line => line.startsWith('@@'))));
  const shown = all ? body : body.slice(0, LINE_LIMIT);
  return <>
    <pre className="atelier-patch">{shown.map((line, index) => <span key={index} className={line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : ''}>{line || ' '}{'\n'}</span>)}</pre>
    {body.length > shown.length && <button className="text-link atelier-more" onClick={() => setAll(true)}>Show {body.length - shown.length} more lines</button>}
  </>;
}

export function DiffView({ files, truncated, empty = 'No changes.' }: { files: FileDiff[]; truncated?: boolean; empty?: string }) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  if (!files.length) return <p className="atelier-empty">{empty}</p>;
  const toggle = (path: string) => setClosed(current => { const next = new Set(current); next.has(path) ? next.delete(path) : next.add(path); return next; });
  const additions = files.reduce((sum, file) => sum + file.additions, 0), deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return <div className="atelier-diff">
    <p className="atelier-diff-summary">{files.length} file{files.length > 1 ? 's' : ''} · <span className="add">+{additions}</span> <span className="del">−{deletions}</span>{truncated && ' · diff truncated'}</p>
    {files.map(file => <section key={file.path} className="atelier-diff-file">
      <button className="atelier-diff-head" aria-expanded={!closed.has(file.path)} onClick={() => toggle(file.path)}>
        <span className={`atelier-file-status ${file.status}`}>{file.status}</span>
        <code>{file.status === 'renamed' ? `${file.old_path} → ${file.path}` : file.path}</code>
        <span className="atelier-diff-count"><span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span></span>
      </button>
      {!closed.has(file.path) && (file.binary ? <p className="atelier-empty">Binary file</p>
        : file.patch ? <Patch patch={file.patch}/> : <p className="atelier-empty">{file.status === 'untracked' ? 'New file, not yet tracked by Git.' : 'No textual change.'}</p>)}
    </section>)}
  </div>;
}
