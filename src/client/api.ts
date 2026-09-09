export async function request<T>(url: string, method = 'GET', body?: object, csrf?: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store', signal,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'request_failed');
  return data as T;
}
