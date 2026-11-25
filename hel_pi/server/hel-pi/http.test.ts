import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeWorkspace, workspacePaths } from '../workspace';
import { createHandler } from './http';
import { openChat } from './runtime';

const supervisor = '172.30.32.2';
const ingressPath = '/api/hassio_ingress/test-prefix';
const ingressHeaders = { 'x-ingress-path': ingressPath, 'x-forwarded-host': 'ha.test' };
const request = (path: string, headers: Record<string, string> = {}, body?: unknown) => new Request('http://app' + path, {
  headers: { 'content-type': 'application/json', ...headers }, method: body === undefined ? 'GET' : 'POST',
  body: body === undefined ? undefined : JSON.stringify(body),
});

test('only Supervisor can open ingress; direct sessions can chat but cannot manage the account', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hel-pi-access-'));
  const paths = initializeWorkspace(workspacePaths(home));
  const runtime = await openChat(paths);
  try {
    const key = crypto.randomUUID();
    const handle = await createHandler(paths, runtime, key);
    const admin = request('/api/account', { ...ingressHeaders, 'x-forwarded-for': supervisor });
    expect((await handle(admin, true, '172.30.32.3')).status).toBe(403);
    expect((await handle(admin, false, supervisor)).status).toBe(401);
    expect(await (await handle(admin, true, supervisor)).json()).toEqual({ connected: false });
    expect((await handle(request('/api/account', { ...ingressHeaders, origin: 'https://other.test' }), true, supervisor)).status).toBe(403);
    expect(await (await handle(request('/', ingressHeaders), true, supervisor)).text()).toContain(`<base href="${ingressPath}/">`);
    const browser = { origin: 'https://hel-pi.test', 'x-forwarded-host': 'hel-pi.test' };
    expect((await handle(request('/api/auth/login', { ...browser, origin: 'https://other.test' }, { key }), false, undefined)).status).toBe(403);
    const login = await handle(request('/api/auth/login', browser, { key }), false, undefined);
    const cookie = login.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('Secure');
    const session = { ...browser, cookie: cookie.split(';')[0] };
    expect((await handle(request('/api/chat', session), false, undefined)).status).toBe(200);
    expect((await handle(request('/api/account', session, { action: 'start' }), false, undefined)).status).toBe(403);
    expect((await handle(request('/api/tasks', ingressHeaders), true, supervisor)).status).toBe(404);
    const off = await createHandler(paths, runtime);
    expect((await off(request('/api/chat', session), false, undefined)).status).toBe(403);
  } finally { await runtime.close(); await rm(home, { recursive: true }); }
});

test('the model can read an upload but not app credentials, and the chat survives restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hel-pi-chat-'));
  const paths = initializeWorkspace(workspacePaths(home));
  const marker = 'Fixture: six copper washers.';
  let upload = '';
  const seen: { tools: string[], messages: { role: string, content: unknown }[] }[] = [];
  const model = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const body = await req.json();
    seen.push({ messages: body.messages, tools: body.tools?.map((t: { function: { name: string } }) => t.function.name) ?? [] });
    const call = seen.length;
    const read = { index: 0, id: `call_${call}`, type: 'function', function: { name: 'read',
      arguments: JSON.stringify({ path: call === 1 ? join(paths.state, 'attachments', upload) : join(home, 'config/models.json') }) } };
    const delta = call <= 2 ? { role: 'assistant', tool_calls: [read] } : { role: 'assistant', content: 'Fixture complete.' };
    const chunks = [{ delta, finish_reason: null }, { delta: {}, finish_reason: call <= 2 ? 'tool_calls' : 'stop' }];
    return new Response(chunks.map(c => `data: ${JSON.stringify({ id: `m${call}`, model: 'fixture', choices: [{ index: 0, ...c }] })}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  let runtime: Awaited<ReturnType<typeof openChat>> | undefined;
  try {
    await Bun.write(join(home, 'config/models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: `${model.url.origin}/v1`, apiKey: 'test-only-key', models: [{ id: 'fixture', name: 'Fixture', maxTokens: 1000, contextWindow: 32000 }] } } }));
    await Bun.write(join(home, 'config/piko.json'), JSON.stringify({ version: 1, agent: { profiles: { main: { provider: 'fixture', model: 'fixture' } } } }));
    runtime = await openChat(paths);
    let handle = await createHandler(paths, runtime);
    const file = await handle(new Request('http://app/api/attachments?name=inventory.txt', { method: 'POST', headers: ingressHeaders, body: marker }), true, supervisor);
    expect(file.status).toBe(201); upload = (await file.json()).id;
    const chat = () => handle(request('/api/chat', ingressHeaders), true, supervisor);
    async function send(input: object) {
      const events = await handle(request('/api/chat/events', ingressHeaders), true, supervisor);
      expect(events.headers.get('content-type')).toBe('text/event-stream');
      const reader = events.body!.getReader();
      try {
        expect((await handle(request('/api/chat', ingressHeaders, input), true, supervisor)).status).toBe(200);
        let stream = '';
        while (!stream.includes('"type":"run-end"')) {
          const item = await reader.read();
          if (item.done) throw new Error('Stream closed before run end.');
          stream += new TextDecoder().decode(item.value);
        }
        expect(stream).toContain('Fixture complete.');
      } finally { await reader.cancel(); }
    }
    await send({ requestId: 'fixture-turn', message: 'Check this inventory.', attachmentIds: [upload] });
    expect(seen).toHaveLength(3);
    expect(seen[0].tools).toEqual(['read']);
    expect(JSON.stringify(seen[1].messages.filter(m => m.role === 'tool'))).toContain(marker);
    expect(JSON.stringify(seen[2].messages.filter(m => m.role === 'tool'))).toContain('Only uploaded files can be read.');
    expect(JSON.stringify(seen)).not.toContain('test-only-key');
    await runtime.close(); runtime = undefined;
    runtime = await openChat(paths, { web_search: 'brave', brave_api_key: 'fixture-brave', read_web_pages: true,
      mcp_url: 'https://unreachable.invalid/mcp', mcp_token: 'fixture-mcp' });
    handle = await createHandler(paths, runtime);
    const history = (await (await chat()).json()).messages;
    expect(history.map((m: { content: string }) => m.content)).toEqual(['Check this inventory.', 'Fixture complete.']);
    expect(history[0].attachments[0].id).toBe(upload);
    const saved = await handle(request('/api/attachments/' + encodeURIComponent(upload), ingressHeaders), true, supervisor);
    expect(await saved.text()).toBe(marker);
    await send({ requestId: 'after-options', message: 'Hello again.' });
    expect(seen.at(-1)?.tools.toSorted()).toEqual(['mcp_call', 'mcp_list', 'read', 'web_extract', 'web_search']);
    expect(JSON.stringify(seen)).not.toMatch(/fixture-(brave|mcp)/);
  } finally { if (runtime) await runtime.close(); await model.stop(true); await rm(home, { recursive: true }); }
}, 12_000);
