import { afterEach, expect, spyOn, test } from 'bun:test';
import { Resolver } from 'node:dns/promises';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { mcpTools } from './mcp';
import { readPublicPage } from './page';
import { searchTool } from './search';

const nativeFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = nativeFetch; });
function offline(handler: (request: Request) => Promise<Response>) {
  globalThis.fetch = (async (input, init) => handler(new Request(input, init))) as typeof fetch;
}

test('search uses only the selected provider and returns its sources', async () => {
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials });
  models.setProvider(openaiProvider());
  await credentials.modify('openai', async () => ({ type: 'oauth', access: 'test-access', refresh: 'test-refresh', expires: Date.now() + 3_600_000 }));
  const config = { main: { provider: 'openai', model: 'gpt-5.4' }, models, harnessSettings: {} };
  const args = { query: 'solar & battery' };
  const planSearch = searchTool('chatgpt', undefined, config);
  const braveSearch = searchTool('brave', 'test-brave', config);
  const urls: string[] = [];
  offline(async req => {
    const url = new URL(req.url);
    urls.push(url.host);
    if (url.host === 'api.search.brave.com') {
      expect(url.pathname).toBe('/res/v1/web/search');
      expect(url.searchParams.get('q')).toBe(args.query);
      expect(req.headers.get('x-subscription-token')).toBe('test-brave');
      expect(req.headers.has('authorization')).toBe(false);
      return Response.json({ web: { results: [{ title: 'Solar', url: 'https://brave-source.test/', description: 'First passage.' }] } });
    }
    expect(req.url).toBe('https://api.openai.com/v1/responses');
    expect(req.headers.get('authorization')).toBe('Bearer test-access');
    expect(req.headers.has('x-subscription-token')).toBe(false);
    expect(await req.json()).toMatchObject({ store: false, stream: true, model: 'gpt-5.4', tools: [{ type: 'web_search' }],
      input: [{ role: 'user', content: args.query }] });
    if (urls.length > 2) return new Response('test-sensitive-provider-error', { status: 403 });
    const result = { type: 'response.completed', response: { output: [{ type: 'web_search_call', status: 'completed' },
      { type: 'message', content: [{ type: 'output_text', text: 'Second passage.', annotations: [{ type: 'url_citation', title: 'Battery', url: 'https://plan-source.test/' }] }] }] } };
    return new Response(`data: ${JSON.stringify(result)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  expect(JSON.stringify(await braveSearch.execute(args, null!, ctx))).toContain('https://brave-source.test/');
  expect(JSON.stringify(await planSearch.execute(args, null!, ctx))).toContain('Battery: https://plan-source.test/');
  await expect(planSearch.execute(args, null!, ctx)).rejects.toThrow('workspace search policy');
  expect(urls).toEqual(['api.search.brave.com', 'api.openai.com', 'api.openai.com']);
});

test('MCP discovery is not permission to call; only the configured name and arguments reach the server', async () => {
  const calls: unknown[] = [];
  const endpoint = 'http://homeassistant/api/mcp';
  offline(async req => {
    expect(req.url).toBe(endpoint);
    expect(req.headers.get('authorization')).toBe('Bearer test-mcp');
    expect(req.redirect).toBe('error');
    const { id, method, params } = await req.json();
    if (method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result;
    if (method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'lab', version: '1' } };
    else if (method === 'tools/list') result = { tools: ['GetState', 'SetState'].map(name => ({ name, inputSchema: { type: 'object' } })) };
    else if (method === 'tools/call') { calls.push(params); result = { content: [{ type: 'text', text: 'Lab state: 19 C' }] }; }
    else throw new Error('Unexpected MCP method');
    return Response.json({ jsonrpc: '2.0', id, result });
  });
  expect(() => mcpTools('http://other.test/api/mcp', undefined, '')).toThrow('HTTPS');
  const [list, call] = mcpTools(endpoint, 'test-mcp', ' GetState ');
  const tools = JSON.stringify(await list.execute({}, null!, ctx));
  expect(tools).toContain('SetState'); expect(tools).not.toContain('test-mcp');
  const args = { name: 'GetState', arguments_json: '{"area":"kitchen"}' };
  const [, discoverOnly] = mcpTools(endpoint, 'test-mcp', '');
  await expect(discoverOnly.execute(args, null!, ctx)).rejects.toThrow('not permitted');
  await expect(call.execute({ ...args, name: 'SetState' }, null!, ctx)).rejects.toThrow('not permitted');
  expect(await call.execute(args, null!, ctx)).toMatchObject({ output: [{ type: 'text', text: 'Lab state: 19 C' }], isError: false });
  expect(calls).toEqual([{ name: 'GetState', arguments: { area: 'kitchen' } }]);
});

test('the public page reader rejects private answers even for a public-looking hostname', async () => {
  const resolve = spyOn(Resolver.prototype, 'resolve4').mockResolvedValue(['8.8.8.8', '100.64.1.2']);
  try {
    const signal = AbortSignal.timeout(1000);
    await expect(readPublicPage('https://mixed.example/', signal)).rejects.toThrow('Not a public IPv4 destination');
    for (const url of ['http://example.org/', 'https://127.0.0.1/', 'https://[::1]/', 'https://homeassistant.local/', 'https://node.example.ts.net/', 'https://example.org:8123/'])
      await expect(readPublicPage(url, signal)).rejects.toThrow('Only public HTTPS');
  } finally { resolve.mockRestore(); }
});
