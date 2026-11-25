import { expect, setSystemTime, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeWorkspace, workspacePaths } from '../workspace';
import { openChat } from './runtime';

test('oversized workspace files survive startup; existing main and side chats reload each valid file per request', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hel-pi-context-')), paths = initializeWorkspace(workspacePaths(home));
  const guidance = join(paths.workspace,'AGENTS.md'), memory = join(paths.workspace,'MEMORY.md');
  const atLimit = 'Drawer: C.'.padEnd(65_534) + 'é', tooLarge = atLimit + '!';
  const seen: string[] = [];
  const model = Bun.serve({port:0, hostname:'127.0.0.1', async fetch(req) {
    const {messages, tools} = await req.json();
    // Only chat replies carry tools. A long input can also trigger a separate compaction request.
    if (tools?.length) seen.push(messages.filter((m:{role:string}) => m.role === 'system' || m.role === 'developer').map((m:{content:string}) => m.content).join('\n'));
    const part = {id:'m',model:'fixture',choices:[{index:0,delta:{role:'assistant',content:'OK'},finish_reason:'stop'}]};
    return new Response(`data: ${JSON.stringify(part)}\n\ndata: [DONE]\n\n`, {headers:{'Content-Type':'text/event-stream'}});
  }});
  let runtime;
  try {
    await Bun.write(join(home,'config/models.json'), JSON.stringify({providers:{fixture:{api:'openai-completions', baseUrl:model.url.origin+'/v1', apiKey:'fixture', models:[{id:'fixture',name:'Fixture',contextWindow:64000,maxTokens:1000}]}}}));
    await Bun.write(join(home,'config/piko.json'), JSON.stringify({version:1,agent:{profiles:{main:{provider:'fixture',model:'fixture'}}}}));
    await Bun.write(guidance, 'Obsolete style'.padEnd(65_537)); await Bun.write(memory, tooLarge);
    runtime = await openChat(paths);
    const {id} = await runtime.sideChats.create('separate-chat');
    const chats = [runtime.chats.main, await runtime.chats.side(id)];
    async function turn(index: number, warnings: string[]) {
      const store = chats[index];
      expect((await store.snapshot()).oversizedMemoryFiles).toEqual(warnings);
      const session = await store.get(), done = Promise.withResolvers<void>();
      const off = session.subscribe(event => {if (event.type === 'run-end') done.resolve();});
      const count = seen.length;
      try { await session.submit('Check', `turn-${count}`); await done.promise; } finally { off(); }
      expect(seen).toHaveLength(count+1); return seen[count]!;
    }
    expect(await turn(0,['AGENTS.md','MEMORY.md'])).not.toMatch(/Obsolete style|Drawer: C/);
    expect(() => runtime!.changeMemory({action:'save',name:'MEMORY.md',revision:'oversized',text:'Replace'})).toThrow('Shorten');
    expect(await Bun.file(memory).text()).toBe(tooLarge);
    await Bun.write(memory, atLimit);
    expect(await turn(1,['AGENTS.md'])).toContain(atLimit);
    await Bun.write(guidance,'Use metric units.'); await Bun.write(memory, tooLarge);
    const partial = await turn(0,['MEMORY.md']); expect(partial).toContain('Use metric units.'); expect(partial).not.toContain('Drawer: C.');
    await Bun.write(memory,'Drawer: D.');
    for (const index of [1,0]) {
      const prompt = await turn(index,[]); expect(prompt).toContain('Use metric units.'); expect(prompt).toContain('Drawer: D.'); expect(prompt).not.toContain('Drawer: C.');
    }
  } finally { await runtime?.close(); await model.stop(true); await rm(home,{recursive:true}); }
});

test('a pending main-chat batch survives restart and produces separate dated notes and editable wiki pages', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hel-pi-review-'));
  const paths = initializeWorkspace(workspacePaths(home));
  const messages = ['Sorted the washers.', 'The new shelf is blue.', 'Both boxes are on it.'];
  const requests: {names:string[], prompt:string}[] = [];
  const note = 'Both boxes were moved to the blue shelf.';
  const topic = 'wiki/topics/parts.md', page = '# Parts storage\n\nBoth boxes are on the blue shelf.';
  const model = Bun.serve({port:0, hostname:'127.0.0.1', async fetch(req) {
    const body = await req.json(), prompt = JSON.stringify(body.messages);
    const review = prompt.includes('Conversation, oldest first:');
    const isWiki = prompt.includes('Organize this new batch');
    const date = /Dates: (\d{4}-\d{2}-\d{2})/.exec(prompt)?.[1];
    let delta: object = {role:'assistant',content:'Noted.'};
    const write = review && body.messages.at(-1)?.role === 'user';
    if (write) {
      requests.push({names:body.tools.map((t:{function:{name:string}}) => t.function.name).sort(), prompt});
      delta = {role:'assistant',tool_calls:[{index:0,id:'save_document',type:'function',function:{name:isWiki ? 'wiki_write' : 'memory_save',
        arguments:JSON.stringify(isWiki ? {path:topic,revision:'missing',text:page} : {name:`memory/${date}.md`,revision:'missing',text:note})}}]};
    }
    const chunks = [{delta, finish_reason:null}, {delta:{},finish_reason:write ? 'tool_calls' : 'stop'}];
    return new Response(chunks.map(c => `data: ${JSON.stringify({id:'m',model:'fixture',choices:[{index:0,...c}]})}\n\n`).join('') + 'data: [DONE]\n\n', {headers:{'Content-Type':'text/event-stream'}});
  }});
  let runtime;
  try {
    await Bun.write(join(home,'config/models.json'), JSON.stringify({providers:{fixture:{api:'openai-completions', baseUrl:`${model.url.origin}/v1`, apiKey:'fixture', models:[{id:'fixture',name:'Fixture',contextWindow:32000,maxTokens:1000}]}}}));
    await Bun.write(join(home,'config/piko.json'), JSON.stringify({version:1,agent:{profiles:{main:{provider:'fixture',model:'fixture'}}}}));
    runtime = await openChat(paths);
    const session = await runtime.chats.main.get();
    for (const [i, text] of messages.entries()) {
      const done = Promise.withResolvers<void>();
      const off = session.subscribe(event => { if (event.type === 'run-end') done.resolve(); });
      try { await session.submit(text, `batch-${i}`); await done.promise; } finally { off(); }
    }
    expect(runtime.memory().dates).toEqual([]);
    await runtime.close(); runtime = undefined;
    setSystemTime(new Date(Date.now() + 31 * 60_000));
    runtime = await openChat(paths);
    // Use the production poller: no manual review trigger or drop in the message threshold.
    const deadline = performance.now() + 19_000;
    while ((!runtime.memory().dates.length || !await Bun.file(join(paths.workspace,topic)).exists()) && performance.now() < deadline) await Bun.sleep(100);
    const [date] = runtime.memory().dates;
    expect(date).toBeDefined();
    expect(runtime.memoryFile(`memory/${date}.md`).text).toBe(note);
    expect(runtime.memory().longTerm.text).toBe('');
    expect(requests.map(r => r.names).sort()).toEqual([['memory_read','memory_save'],['wiki_read','wiki_write']]);
    for (const review of requests) for (const text of [...messages, 'Noted.']) expect(review.prompt).toContain(text);
    const doc = runtime.workspace.browse(topic);
    if (!('text' in doc)) throw new Error('Expected the wiki page, not a folder.');
    expect(doc.text).toBe(page);
    expect(runtime.workspace.saveWiki({...doc,text:'Corrected shelf: green.'}).revision).not.toBe(doc.revision);
    expect(runtime.memoryFile(`memory/${date}.md`).text).toBe(note);
    expect((await runtime.chats.main.snapshot()).messages).toHaveLength(6);
  } finally { try { await runtime?.close(); } finally { setSystemTime(); await model.stop(true); await rm(home, {recursive:true}); } }
}, 24_000);
