import { HttpError } from '../http';

export const limits = {
  tools: 64, description: 512, source: 16_384, input: 16_384, fixtures: 65_536,
  path: 2048, calls: 8, response: 131_072, result: 32_768,
  heap: 8 * 1024 * 1024, polls: 2_000, wallMs: 10_000, processes: 2,
} as const;

export function invalid(message: string): never { throw new HttpError(message, 422); }

export function jsonText(value: unknown, limit: number, label: string): string {
  let text: string | undefined;
  try { text = JSON.stringify(value); } catch { /* Cyclic, too deep or otherwise not JSON. */ }
  if (text === undefined || Buffer.byteLength(text) > limit) invalid(`${label} must be JSON under ${limit} bytes.`);
  return text;
}

export function jsonObject(value: unknown, limit: number, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be a JSON object.`);
  // Copy the JSON boundary: later mutations of caller-owned objects cannot change a running test.
  const copy = JSON.parse(jsonText(value, limit, label));
  if (copy === null || typeof copy !== 'object' || Array.isArray(copy)) invalid(`${label} must be a JSON object.`);
  return copy;
}

/** A request path (optionally with query), relative to the connection's base, never a URL. */
export function requestPath(path: unknown): string {
  if (typeof path !== 'string' || !path || path.length > limits.path || /[\\#\s\x00-\x1f\x7f]/.test(path) ||
      /^(\/\/|[a-z][a-z\d+.-]*:)/i.test(path)) invalid('Use a relative GET path on the selected connection.');
  for (const segment of path.split('?')[0].split('/')) {
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { invalid('Invalid GET path encoding.'); }
    if (decoded === '.' || decoded === '..' || /[\\/%#?;\x00-\x1f\x7f]/.test(decoded)) invalid('GET path must stay under the connection base.');
  }
  return path;
}

export function fixturesObject(value: unknown) {
  const fixtures = jsonObject(value, limits.fixtures, 'Fixtures');
  for (const key of Object.keys(fixtures)) requestPath(key);
  return fixtures;
}
