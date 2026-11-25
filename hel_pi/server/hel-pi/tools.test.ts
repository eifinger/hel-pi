import { afterEach, expect, spyOn, test } from 'bun:test';
import { Resolver } from 'node:dns/promises';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { mcpTools } from './mcp';
import { Connections } from './connections';
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

test('MCP permissions and credentials stay scoped to their server, including after an upgrade', async () => {
  const calls: unknown[] = [];
  const endpoint = 'http://homeassistant/api/mcp';
  const other = 'https://inventory.example/mcp';
  offline(async req => {
    expect([endpoint, other]).toContain(req.url);
    expect(req.headers.get('authorization')).toBe(req.url === endpoint ? 'Bearer test-mcp' : 'Bearer test-inventory');
    expect(req.redirect).toBe('error');
    const { id, method, params } = await req.json();
    if (method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result;
    if (method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'lab', version: '1' } };
    else if (method === 'tools/list') result = { tools: ['GetState', 'SetState'].map(name => ({ name, inputSchema: { type: 'object' } })) };
    else if (method === 'tools/call') { calls.push({url:req.url,params}); result = { content: [{ type: 'text', text: 'Lab state: 19 C' }] }; }
    else throw new Error('Unexpected MCP method');
    return Response.json({ jsonrpc: '2.0', id, result });
  });
  const home = mkdtempSync(join(tmpdir(), 'hel-pi-mcp-'));
  try {
    const legacy = {mcp_url:endpoint, mcp_token:'test-mcp', mcp_allowed_tools:' GetState '};
    const connections = new Connections(home, legacy);
    const [list, call] = mcpTools(connections);
    const tools = JSON.stringify(await list.execute({}, null!, ctx));
    expect(tools).toContain('SetState'); expect(tools).not.toContain('test-mcp');
    const args = { name:'GetState', arguments_json:'{"area":"kitchen"}' };
    expect(await call.execute(args, null!, ctx)).toMatchObject({isError:false});
    await connections.change({action:'create',kind:'mcp',name:'Inventory',url:other,secret:'test-inventory'});
    const [ha, inventory] = connections.list();
    expect(JSON.stringify(await list.execute({}, null!, ctx))).toContain(inventory.id);
    await expect(call.execute(args, null!, ctx)).rejects.toThrow('Choose an MCP server');
    await list.execute({server:inventory.id}, null!, ctx);
    await expect(call.execute({...args,server:inventory.id}, null!, ctx)).rejects.toThrow('not permitted');
    await connections.change({action:'allow',id:inventory.id,name:'SetState',allowed:true});
    await expect(call.execute({...args,server:ha.id,name:'SetState'}, null!, ctx)).rejects.toThrow('not permitted');
    await call.execute({...args,server:inventory.id,name:'SetState'}, null!, ctx);
    await connections.change({action:'allow',id:inventory.id,name:'SetState',allowed:false});
    await connections.change({action:'allow',id:inventory.id,name:'GetState',allowed:true});
    await expect(connections.change({action:'allow',id:inventory.id,allowed:['SetState','GetState']})).rejects.toMatchObject({status:422});
    await expect(call.execute({...args,server:inventory.id,name:'SetState'}, null!, ctx)).rejects.toThrow('not permitted');
    expect(calls).toEqual([{url:endpoint,params:{name:'GetState', arguments:{area:'kitchen'}}},{url:other,params:{name:'SetState',arguments:{area:'kitchen'}}}]);
    await connections.change({action:'delete', id:ha.id});
    expect(new Connections(home,legacy).list().map(c => c.name)).toEqual(['Inventory']);
  } finally { rmSync(home, {recursive:true}); }
});

test('HTTP tool calls stay on the approved service and cannot attach a credential to another destination', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hel-pi-get-'));
  try {
    const store = new Connections(home);
    const config = {action:'create',name:'Inventory',kind:'http',authHeader:'X-API-Key',secret:'example-token',url:'https://inventory.test/v1'};
    await expect(store.change({...config,url:'http://other.test'})).rejects.toThrow('HTTPS');
    await store.change(config);
    const {id} = store.list()[0]; let count = 0;
    offline(async req => {
      count++;
      expect(req.method).toBe('GET'); expect(req.url).toBe('https://inventory.test/v1/items?q=HDMI%20cable');
      expect(req.headers.get('x-api-key')).toBe('replacement-token'); expect(req.redirect).toBe('error');
      return Response.json({location:'top drawer'});
    });
    await store.change({action:'secret',id,secret:'replacement-token'});
    expect(JSON.stringify(store.list())).not.toContain('replacement-token');
    const restored = new Connections(home); const sig = AbortSignal.timeout(2000);
    expect(statSync(join(home,'config/connections.json')).mode & 0o777).toBe(0o600);
    for (const path of ['//other.test/', 'https://other.test/', '/%2e%2e/auth','a/../admin','a/%252f..','/a%2fb']) await expect(restored.get(id,path,sig)).rejects.toThrow();
    expect(await restored.get(id,'/items?q=HDMI%20cable',sig)).toEqual({location:'top drawer'});
    expect(count).toBe(1);
    await restored.change({action:'delete',id}); await restored.change(config);
    await expect(restored.get(id,'/items',sig)).rejects.toThrow('not found');
  } finally { rmSync(home,{recursive:true}); }
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
