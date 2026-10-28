type SearchStepStatus = 'running' | 'done' | 'warning' | 'skipped';
export type SearchProgress = Record<string, SearchStepStatus>;

export async function loadCitationGraph<T>(path: string, options: RequestInit, onProgress: (step: string, status: SearchStepStatus) => void): Promise<T> {
  const response = await fetch(`/api${path}?stream=true`, {
    ...options, headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(typeof error?.detail === 'string' ? error.detail : `Search unavailable (${response.status})`);
  }
  // Older servers may still return the graph as a single JSON response.
  if (!response.headers.get('content-type')?.includes('application/x-ndjson')) return response.json();
  if (!response.body) throw new Error('Search progress is unavailable.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      if (done && buffer.trim()) lines.push(buffer);
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === 'progress') onProgress(event.step, event.status);
        if (event.type === 'error') throw new Error(event.message);
        if (event.type === 'result') return event.data;
      }
      if (done) throw new Error('The search was interrupted. Try again.');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
