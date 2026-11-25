import { afterEach, expect, spyOn, test } from 'bun:test';
import { Resolver } from 'node:dns/promises';
import { BACKGROUND_CONTEXT as ctx, withCancel } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import type { ToolRegistration } from '@earendil-works/pi-durable';
import { readPageTool } from './page';
import { createWebTools, type WebToolOptions } from './web-tools';

const keys = { exa_api_key: 'mock-exa', tavily_api_key: 'mock-tavily', deepseek_api_key: 'mock-deepseek', firecrawl_api_key: 'mock-firecrawl', brave_api_key: 'mock-brave' };
const config = { models: createModels(), harnessSettings: {} };
function tools(options: WebToolOptions): ToolRegistration[] { return createWebTools({ ...keys, ...options }, config); }

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
function offline(response: () => Response) {
  const requests: Request[] = [];
  globalThis.fetch = (async (input, init) => { requests.push(new Request(input, init)); return response(); }) as typeof fetch;
  return requests;
}

test('keys alone do not enable tools; explicit extraction selection overrides the legacy local-only switch', () => {
  const requests = offline(() => { throw new Error('Unexpected fetch'); });
  expect(tools({})).toEqual([]);
  expect(tools({ read_web_pages: true })).toEqual([readPageTool]);
  expect(tools({ web_extract: 'built-in' })).toEqual([readPageTool]);
  expect(tools({ web_extract: 'off', read_web_pages: true })).toEqual([]);
  expect(tools({ web_search: 'chatgpt', web_extract: 'built-in' }).map(t => t.name)).toEqual(['web_search', 'web_extract']);
  expect(() => tools({ web_search: 'tavily', tavily_api_key: '  ' })).toThrow('Set the Tavily API key');
  expect(() => tools({ web_extract: 'exa', exa_api_key: '', read_web_pages: true })).toThrow('Set the Exa API key');
  expect(requests).toHaveLength(0);
});

const url = 'https://article.example/news?q=public';
const title = 'Release notes', query = 'solar & storage', passage = 'A public source.';
for (const [provider, endpoint, body, fields] of [
  ['exa', 'https://api.exa.ai/search', { query, type: 'lite', numResults: 5, contents: { highlights: { maxCharacters: 1200 } } }, { highlights: [passage], publishedDate: '2025-01-01' }],
  ['tavily', 'https://api.tavily.com/search', { query, max_results: 5, search_depth: 'basic', include_answer: false, include_raw_content: false, include_published_date: true }, { content: passage, published_date: '2025-01-01' }],
  ['deepseek', 'https://api.deepseek.com/v1/tools/search', { query, count: 5, need_content: false }, { summary: passage, date: '2025-01-01' }],
] as const) {
  test(`${provider} search sends only the query and selected credential, and returns citable results`, async () => {
    const [tool] = tools({ web_search: provider });
    const requests = offline(() => Response.json({ debug: 'not for chat', results: [{ title, url, ...fields }] }));
    const result = await tool.execute({ query }, null!, ctx);
    expect(result).toEqual({ output: [{ type: 'text', text: `${title}\n${url}\n2025-01-01\n${passage}` }] });
    expect(requests).toHaveLength(1);
    const [req] = requests;
    expect([req.url, req.method, req.redirect]).toEqual([endpoint, 'POST', 'error']);
    expect(await req.json()).toEqual(body);
    expect(req.headers.get('x-api-key')).toBe(provider === 'exa' ? keys.exa_api_key : null);
    expect(req.headers.get('authorization')).toBe(provider === 'exa' ? null : `Bearer ${keys[`${provider}_api_key`]}`);
    expect(req.headers.has('x-subscription-token')).toBe(false);
    expect(JSON.stringify(tool)).not.toContain('mock-');
  });
}

for (const [provider, endpoint, body, response] of [
  ['firecrawl', 'https://api.firecrawl.dev/v2/scrape', { url, formats: ['markdown'], onlyMainContent: true }, { success: true, data: { metadata: { title }, markdown: passage } }],
  ['exa', 'https://api.exa.ai/contents', { ids: [url], text: {} }, { results: [{ url: 'https://wrong.example', text: 'Wrong result' }, { title, url, text: passage }] }],
  ['deepseek', 'https://api.deepseek.com/v1/tools/fetch', { url }, { title, content: passage }],
] as const) {
  test(`${provider} extracts only the selected public URL, without its fragment`, async () => {
    const resolve = spyOn(Resolver.prototype, 'resolve4').mockResolvedValue(['8.8.8.8']);
    try {
      const [tool] = tools({ web_extract: provider, read_web_pages: true });
      const requests = offline(() => Response.json(response));
      expect(await tool.execute({ url: `${url}#private-fragment` }, null!, ctx)).toEqual({ output: [{ type: 'text', text: `${url}\n${title}\n${passage}` }] });
      expect(resolve).toHaveBeenCalledWith('article.example.');
      expect(requests).toHaveLength(1);
      const [req] = requests;
      expect([req.url, req.method, req.redirect]).toEqual([endpoint, 'POST', 'error']);
      expect(await req.json()).toEqual(body);
      expect(req.headers.get('authorization')).toBe(`Bearer ${keys[`${provider}_api_key`]}`);
      expect(req.headers.has('x-api-key')).toBe(false);
      expect(JSON.stringify(tool)).not.toContain('mock-');
    } finally { resolve.mockRestore(); }
  });
}

test('remote extraction rejects nonpublic names, mixed DNS, URL credentials, and nonstandard HTTPS before any API call', async () => {
  const requests = offline(() => Response.json({}));
  const resolve = spyOn(Resolver.prototype, 'resolve4').mockResolvedValue(['8.8.8.8', '10.0.0.1']);
  try {
    const [tool] = tools({ web_extract: 'firecrawl' });
    for (const url of ['https://homeassistant.local/', 'https://127.0.0.1/', 'https://[::1]/', 'https://some.internal/', 'https://node.example.ts.net/',
      'https://user:pwd@article.example/', 'http://article.example/', 'https://article.example:8123/', 'https://mixed.example/'])
      await expect(tool.execute({ url }, null!, ctx)).rejects.toThrow('Use a public HTTPS page');
    expect(resolve.mock.calls.map(([host]) => host)).toEqual(['mixed.example.']);
    expect(requests).toHaveLength(0);
  } finally { resolve.mockRestore(); }
});

test('DeepSeek query limit is checked before sending; an empty result is not a fallback trigger', async () => {
  const [tool] = tools({ web_search: 'deepseek' });
  const requests = offline(() => Response.json({ results: [] }));
  await expect(tool.execute({ query: '🌞'.repeat(129) }, null!, ctx)).rejects.toThrow('128 characters');
  expect(await tool.execute({ query: '🌞'.repeat(128) }, null!, ctx)).toEqual({ output: [{ type: 'text', text: 'No web results.' }] });
  expect(requests.map(req => req.url)).toEqual(['https://api.deepseek.com/v1/tools/search']);
});

test('auth failures, including error envelopes and reflected credentials, return no provider diagnostics or fallback results', async () => {
  const [search, extract] = tools({ web_search: 'tavily', web_extract: 'deepseek' });
  const resolve = spyOn(Resolver.prototype, 'resolve4').mockResolvedValue(['8.8.8.8']);
  try {
    for (const response of [() => new Response('upstream-sensitive-detail', { status: 403 }),
      () => Response.json({ error: 'upstream-sensitive-detail' }),
      () => Response.json({ content: keys.deepseek_api_key, results: [{ title, url, content: keys.tavily_api_key }] }),
    ]) {
      const requests = offline(response);
      await expect(search.execute({ query }, null!, ctx)).rejects.toThrow(/^Tavily unavailable\. Check the API key, quota, or network\.$/);
      await expect(extract.execute({ url }, null!, ctx)).rejects.toThrow(/^DeepSeek could not extract that page\. Check the API key, quota, or page availability\.$/);
      expect(requests.map(r => r.url)).toEqual(['https://api.tavily.com/search', 'https://api.deepseek.com/v1/tools/fetch']);
    }
  } finally { resolve.mockRestore(); }
});

test('extraction clips page content at 24,000 characters and rejects a streamed response over 1 MiB', async () => {
  const [tool] = tools({ web_extract: 'deepseek' });
  const resolve = spyOn(Resolver.prototype, 'resolve4').mockResolvedValue(['8.8.8.8']);
  try {
    offline(() => Response.json({ content: 'A'.repeat(24_001) }));
    expect(await tool.execute({ url }, null!, ctx)).toEqual({ output: [{ type: 'text', text: `${url}\n${'A'.repeat(24_000)}\n[Page truncated]` }] });
    offline(() => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from('{"content":"')); controller.enqueue(Buffer.alloc(1024 * 1024, 65)); controller.enqueue(Buffer.from('"}')); controller.close();
    } })));
    await expect(tool.execute({ url }, null!, ctx)).rejects.toThrow('could not extract');
  } finally { resolve.mockRestore(); }
});

test('cancellation stops a pending provider body read', async () => {
  const { context, cancel } = withCancel(ctx);
  const reading = Promise.withResolvers<void>();
  let cancelled = false;
  offline(() => new Response(new ReadableStream({ pull() { reading.resolve(); }, cancel() { cancelled = true; } })));
  const [tool] = tools({ web_search: 'exa' });
  const result = tool.execute({ query }, null!, context);
  await reading.promise;
  cancel();
  await expect(result).rejects.toThrow();
  expect(cancelled).toBe(true);
});
