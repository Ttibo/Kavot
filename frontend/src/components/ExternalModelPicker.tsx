import { useEffect, useState } from 'react';
import { api } from '../services/api';
import type { ExternalEngine } from './ExternalAgentSettings';

type Model = { id: string; name: string; description?: string; efforts: string[] };
export function ExternalModelPicker({ engine, name, model, effort, onChange, disabled, executable = '', settings = false, compact = false }: {
  engine: ExternalEngine; name: string; model: string; effort: string;
  onChange: (model: string, effort: string) => void; disabled?: boolean; executable?: string; settings?: boolean; compact?: boolean;
}) {
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setModels([]);
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams({ executable, refresh: String(revision > 0) });
      void api<{ models: Model[] }>(`/external-agents/models/${engine}?${query}`, { signal: controller.signal })
        .then(value => { if (!controller.signal.aborted) {
          if (!Array.isArray(value.models)) throw new Error('Model catalog unavailable.');
          setModels(value.models);
        } })
        .catch(reason => { if (!controller.signal.aborted) setError(reason.message); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, executable ? 500 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [engine, executable, revision]);
  const selected = models.find(item => item.id === model);
  const modelLabel = settings ? `Model ${name}` : `Model for ${name}`;
  const effortLabel = settings ? `Intelligence ${name}` : `Reasoning for ${name}`;
  const options = <>
    <label>Intelligence<select aria-label={effortLabel} value={effort} disabled={disabled || loading || !selected?.efforts?.length} onChange={event => onChange(model, event.target.value)}>
      <option value="">Tool default</option>
      {effort && !selected?.efforts?.includes(effort) && <option value={effort}>{effort} (saved)</option>}
      {(selected?.efforts || []).map(level => <option key={level} value={level}>{level}</option>)}
    </select></label>
    {!selected?.efforts?.length && <small>The model’s default setting is used.</small>}
    <button type="button" disabled={disabled || loading} onClick={() => setRevision(value => value + 1)}>Refresh models</button>
  </>;
  return <div className={`external-model-picker${compact ? ' compact-model-picker' : ''}`}>
    <label><span className={compact ? 'assistant-sr-only' : ''}>Model</span><select aria-label={modelLabel} title={selected?.name || model || 'Choose the model'} value={model} disabled={disabled || loading} onChange={event => onChange(event.target.value, '')}>
      <option value="">{loading ? 'Loading…' : compact ? 'Auto model' : 'Tool default model'}</option>
      {model && !selected && <option value={model}>{model} (saved model, availability not checked)</option>}
      {models.map(item => <option key={item.id} value={item.id}>{item.name}{!compact && item.name !== item.id ? ` · ${item.id}` : ''}</option>)}
    </select></label>
    {compact ? <details className="assistant-model-options"><summary aria-label="Model options" title="Reasoning and refresh">⋯</summary><div>{options}</div></details> : options}
    {error && <small role="alert">{error}</small>}
  </div>;
}
