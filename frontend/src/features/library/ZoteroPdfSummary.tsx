import type { ZoteroPdfResult } from './useZotero';

export function ZoteroPdfSummary({ result }: { result?: ZoteroPdfResult }) {
  if (!result) return null;
  return <div className="zotero-pdf-summary">
    <p>{result.downloaded} PDF downloaded · {result.existing} already present · {result.unavailable} unavailable · {result.failed} failed</p>
    {result.errors.length > 0 && <details><summary>PDFs needing attention ({result.errors.length})</summary><ul>{result.errors.map(error => <li key={error.paper_id}><strong>{error.title}</strong><span>{error.message}</span></li>)}</ul><p>Fix the file access or synchronize the files in Zotero, then run Sync Zotero again. PDFs already imported will be kept.</p></details>}
  </div>;
}
