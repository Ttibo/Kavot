/** Shared transport for React views and the document engine. */
export let pendingApiWrites = 0;

export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const writing = !['GET', 'HEAD'].includes((options.method || 'GET').toUpperCase());
  if (writing) pendingApiWrites++;
  try { return await requestApi<T>(path, options); }
  finally { if (writing) pendingApiWrites--; }
}

async function requestApi<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api${path}`, { ...options, headers });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const error = await response.json();
      if (typeof error.detail === 'string') message = error.detail;
      else if (Array.isArray(error.detail)) message = error.detail.map((item: { msg: string }) => item.msg).join(', ');
    } catch { /* Keep the HTTP status when the response is not JSON. */ }
    // The status tells a conflict (409: changed elsewhere) from other failures.
    throw Object.assign(new Error(message), { status: response.status });
  }
  return response.status === 204 ? null as T : response.json();
}
