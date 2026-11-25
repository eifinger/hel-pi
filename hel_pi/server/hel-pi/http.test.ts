import { expect, test } from 'bun:test';
import { link, mkdtemp, rm, symlink } from 'node:fs/promises';
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

test('only Supervisor can open ingress; authenticated direct sessions have the same management access', async () => {
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
    expect(await (await handle(request('/api/account', session), false, undefined)).json()).toEqual({ connected:false });
    for (const path of ['/api/connections','/api/tools','/api/memory','/api/workspace','/api/wiki-review','/api/tasks','/api/posts','/api/side-chats','/api/settings','/api/artifacts']) {
      expect((await handle(request(path), false, undefined)).status).toBe(401);
      expect((await handle(request(path, {...session, origin:'https://other.test'}, {}), false, undefined)).status).toBe(403);
      expect((await handle(request(path, {'x-ingress-path':ingressPath}), true, '172.30.32.3')).status).toBe(403);
    }
    const save = (body: object) => handle(request('/api/memory', session, body), false, undefined);
    const memory = () => handle(request('/api/memory', ingressHeaders), true, supervisor).then(r => r.json());
    const {longTerm} = await memory();
    expect(longTerm.text).toBe('');
    expect((await save({...longTerm, action:'save', text:'- Shelf B4'})).status).toBe(200);
    expect((await save({...longTerm, action:'save', text:'Obsolete'})).status).toBe(409);
    expect((await memory()).longTerm.text).toBe('- Shelf B4');
    const daily = {action:'save',name:'memory/2026-07-13.md',revision:'missing',text:'Repair scheduled.'};
    expect((await save(daily)).status).toBe(200);
    expect((await memory()).dates).toEqual(['2026-07-13']);
    expect((await handle(request('/api/memory?date=2026-07-13', ingressHeaders), true, supervisor).then(r => r.json())).text).toBe(daily.text);
    for (const name of ['../config/auth.json','AGENTS.md','memory/2026-02-31.md']) expect((await save({...daily,name})).status).toBe(422);
    const secret = join(home, 'config/models.json');
    await symlink(secret, join(paths.workspace,'memory/2026-01-01.md'));
    await link(secret, join(paths.workspace,'memory/2026-01-02.md'));
    for (const day of ['01','02']) {
      expect((await handle(request('/api/memory?date=2026-01-'+day, ingressHeaders), true, supervisor)).status).toBe(422);
      expect((await save({...daily,name:`memory/2026-01-${day}.md`})).status).toBe(422);
    }
    const change = await handle(request('/api/connections', session, {action:'create',name:'Household',kind:'http',url:'https://inventory.test',secret:'sample-household-token'}), false, undefined);
    const value = await change.json(); expect(change.status).toBe(200);
    expect(value.connections[0]).toMatchObject({name:'Household', hasSecret:true});
    expect(JSON.stringify(value)).not.toContain('sample-household-token');
    expect(await (await handle(request('/api/connections', ingressHeaders), true, supervisor)).json()).toEqual(value);
    expect(await (await handle(request('/api/tasks', ingressHeaders), true, supervisor)).json()).toEqual({tasks:[]});
    const page = {path:'wiki/topics/spares.md',text:'Keep one spare.',revision:'missing'};
    expect((await handle(request('/api/workspace', session, page), false, undefined)).status).toBe(200);
    expect((await handle(request('/api/workspace', session, page), false, undefined)).status).toBe(409);
    expect(await (await handle(request('/api/workspace?path=wiki/topics/spares.md', ingressHeaders), true, supervisor)).json()).toMatchObject({text:page.text});
    const off = await createHandler(paths, runtime);
    expect((await off(request('/api/chat', session), false, undefined)).status).toBe(403);
  } finally { await runtime.close(); await rm(home, { recursive: true }); }
});

test('a stale task edit cannot re-enable a schedule; retrying an accepted edit is idempotent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hel-pi-task-')), paths = initializeWorkspace(workspacePaths(home));
  const runtime = await openChat(paths);
  try {
    const handle = await createHandler(paths, runtime);
    const api = (path:string, body?:object) => handle(request('/api/tasks' + path, ingressHeaders, body), true, supervisor);
    const original = {title:'Weekly status',prompt:'Check the lights',schedule:{type:'cron',expression:'0 7 * * 1',timezone:'UTC'},scheduleText:'Monday'};
    const {id} = await (await api('',{action:'create',requestId:'new-task',task:original})).json();
    const {task:{revision}} = await (await api('/'+id)).json();
    const manual = {...original,prompt:'Check the temperature',schedule:null,scheduleText:'On demand'};
    const update = {id, action:'update', requestId:'disable-schedule', revision, task:manual};
    expect((await api('',update)).status).toBe(200);
    expect((await (await api('',update)).json()).duplicate).toBe(true);
    expect((await api('',{...update,requestId:'stale',task:{...original,title:'Renamed'}})).status).toBe(409);
    expect((await api('',{...update,requestId:'no-revision',revision:undefined})).status).toBe(422);
    expect((await (await api('/'+id)).json()).task).toMatchObject({...manual,nextDueAt:null,revision:revision+1});
  } finally { await runtime.close(); await rm(home,{recursive:true}); }
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
    const memory = (body?: object) => handle(request('/api/memory', ingressHeaders, body), true, supervisor);
    const {instructions,longTerm} = await (await memory()).json();
    expect((await memory({action:'instructions',previous:instructions,instructions:'Use metric units.'})).status).toBe(200);
    expect((await memory({...longTerm,action:'save',text:'Small parts go in drawer C.'})).status).toBe(200);
    expect((await memory({name:'memory/2026-06-24.md',action:'save',revision:'missing',text:'Yesterday-only marker.'})).status).toBe(200);
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
    expect(JSON.stringify(seen[0].messages)).toContain('Use metric units.');
    expect(JSON.stringify(seen[0].messages)).toContain('Small parts go in drawer C.');
    expect(JSON.stringify(seen[0].messages)).not.toContain('Yesterday-only marker.');
    const baseline = ['local_tool_call', 'local_tool_draft', 'local_tool_list', 'mcp_call', 'mcp_list', 'memory_read', 'memory_save', 'read', 'posts_read', 'posts_search', 'send_attachment', 'sessions_history', 'sessions_search', 'workspace_read', 'workspace_write', 'workspace_skill', 'task_archive', 'task_create', 'task_get', 'task_list', 'task_restore', 'task_run', 'task_stop', 'task_update'];
    expect(seen[0].tools.toSorted()).toEqual(baseline.toSorted());
    expect(JSON.stringify(seen[1].messages.filter(m => m.role === 'tool'))).toContain(marker);
    expect(JSON.stringify(seen[2].messages.filter(m => m.role === 'tool'))).toContain('Only regular uploaded files can be read.');
    expect(JSON.stringify(seen)).not.toContain('test-only-key');
    await runtime.close(); runtime = undefined;
    runtime = await openChat(paths, { web_search: 'brave', brave_api_key: 'fixture-brave', read_web_pages: true,
      mcp_url: 'https://unreachable.invalid/mcp', mcp_token: 'fixture-mcp', assistant_instructions: 'Use nautical units.' });
    handle = await createHandler(paths, runtime);
    expect(await (await memory()).json()).toMatchObject({source:'ha', instructions:'Use nautical units.', longTerm:{text:'Small parts go in drawer C.'},dates:['2026-06-24']});
    expect((await memory({action:'instructions',previous:'Use nautical units.',instructions:'Ignore HA'})).status).toBe(409);
    const history = (await (await chat()).json()).messages;
    expect(history.map((m: { content: string }) => m.content)).toEqual(['Check this inventory.', 'Fixture complete.']);
    expect(history[0].attachments[0].id).toBe(upload);
    const saved = await handle(request('/api/attachments/' + encodeURIComponent(upload), ingressHeaders), true, supervisor);
    expect(await saved.text()).toBe(marker);
    await send({ requestId: 'after-options', message: 'Hello again.' });
    expect(seen.at(-1)?.tools.toSorted()).toEqual([...baseline, 'web_extract', 'web_search'].toSorted());
    expect(JSON.stringify(seen.at(-1)?.messages)).toContain('Use nautical units.');
    expect(JSON.stringify(seen.at(-1)?.messages)).not.toContain('Use metric units.');
    await runtime.close(); runtime = undefined;
    runtime = await openChat(paths); handle = await createHandler(paths, runtime);
    expect(await (await memory()).json()).toMatchObject({source:'local', instructions:'Use metric units.'});
    expect((await memory({action:'instructions',previous:'Use nautical units.',instructions:'Stale edit'})).status).toBe(409);
    expect(await (await memory({action:'instructions',previous:'Use metric units.',instructions:''})).json()).toMatchObject({source:'default', instructions});
    expect(JSON.stringify(seen)).not.toMatch(/fixture-(brave|mcp)/);
    // Clearing the model must also stop chat actions that would otherwise use a stored conversation's old model.
    const {id} = await (await handle(request('/api/side-chats', ingressHeaders, {requestId:'topic'}), true, supervisor)).json();
    const {revision} = await (await handle(request('/api/settings', ingressHeaders), true, supervisor)).json();
    const cleared = new Request('http://app/api/settings', {method:'PUT', headers:{...ingressHeaders,'content-type':'application/json'},
      body:JSON.stringify({baseRevision:revision,mainModel:null,backgroundModel:null,backgroundThinking:null})});
    expect((await handle(cleared, true, supervisor)).status).toBe(200);
    for (const path of ['/api/chat/compact', `/api/side-chats/${id}/title/generate`]) {
      const response = await handle(request(path, ingressHeaders, {}), true, supervisor);
      expect(response.status).toBe(409);
      expect((await response.json()).error).toMatch(/model|ChatGPT/i);
    }
  } finally { if (runtime) await runtime.close(); await model.stop(true); await rm(home, { recursive: true }); }
}, 12_000);
