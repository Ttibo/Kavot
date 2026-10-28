import type { SearchProgress } from './citationProgress';

const steps = [
  ['start', 'Preparing the search'],
  ['resolve', 'Identifying the article in OpenAlex'],
  ['references', 'Looking for cited references'],
  ['citations', 'Looking for citing articles'],
  ['semantic_scholar', 'Consultation de Semantic Scholar'],
  ['open_citations', 'Querying OpenCitations'],
  ['crossref', 'Consultation de Crossref'],
  ['europe_pmc', 'Querying Europe PMC'],
  ['connections', 'Looking for citations between the pack’s articles'],
  ['merge', 'Merging results and building connections'],
];
const labels = { running: 'En cours', done: 'Done', warning: 'Unavailable', skipped: 'Not queried', waiting: 'En attente' };

export function CitationSearchProgress({ progress, busy, error, retry }: { progress: SearchProgress; busy: boolean; error: string; retry: () => void }) {
  const resolved = steps.filter(([id]) => ['done', 'warning', 'skipped'].includes(progress[id])).length;
  return <div className="citation-canvas citation-search-progress" aria-busy={busy}>
    <section aria-label="Search progress">
      <h2>{busy ? 'Looking for citations and references' : 'Search interrupted'}</h2>
      <p role="status" aria-live="polite">{busy ? `${resolved} steps done out of ${steps.length}` : error}</p>
      <progress value={resolved} max={steps.length} aria-label="Search steps done"/>
      <ol>{steps.map(([id, title]) => {
        const status = progress[id] || 'waiting';
        return <li key={id} data-status={status}><span aria-hidden="true">{status === 'done' ? '✓' : status === 'warning' ? '!' : status === 'skipped' ? '−' : status === 'running' ? '◌' : '○'}</span><span>{title}</span><small>{labels[status]}</small></li>;
      })}</ol>
      <p>Steps change depending on the sources’ answers. Some sources may be unavailable.</p>
      {!busy && <button className="button button-primary" onClick={retry}>Retry the search</button>}
    </section>
  </div>;
}
