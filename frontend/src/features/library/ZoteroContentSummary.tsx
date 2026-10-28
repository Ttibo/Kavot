import type { ZoteroContentResult } from './useZotero';

export function ZoteroContentSummary({ result }: { result?: ZoteroContentResult | null }) {
  if (!result) return null;
  return <div className="zotero-content-summary">
    {result.collections && <p>{result.collections.total} folders synchronized · hierarchy and article memberships preserved</p>}
    {result.notes && <>
      <p>{result.notes.imported} notes imported · {result.notes.updated} updated · {result.notes.existing} already present</p>
      {result.notes.errors.length > 0 && <details><summary>Notes needing attention ({result.notes.conflicts})</summary><ul>{result.notes.errors.map(error => <li key={`${error.note_id}-${error.title}`}><strong>{error.title}</strong><p>{error.message}</p></li>)}</ul></details>}
    </>}
  </div>;
}
