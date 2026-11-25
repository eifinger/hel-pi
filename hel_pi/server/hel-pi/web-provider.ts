// API endpoints and authentication headers are fixed by the selected adapter,
// never supplied by the model. Limit the decoded body even without Content-Length.
export async function providerJson(url: string | URL, auth: Record<string, string>, signal: AbortSignal, body?: object) {
  signal.throwIfAborted();
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET', redirect: 'error', credentials: 'omit', signal,
    headers: { Accept: 'application/json', ...(body && { 'Content-Type': 'application/json' }), ...auth },
    body: body && JSON.stringify(body),
  });
  const limit = 1024 * 1024;
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Provider request failed.');
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error('Provider response too large.');
      chunks.push(value);
    }
    signal.throwIfAborted();
    const data = record(JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')));
    if (!data || data.error || data.errors) throw new Error('Invalid provider response.');
    return data;
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// Some services return 200 with request diagnostics in otherwise valid fields.
export function credentialSafe(result: string, key: string) {
  if (result.includes(key)) throw new Error('Invalid provider response.');
  return result;
}
