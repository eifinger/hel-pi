import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createRegistry, ROOT_CONVERSATION_ID as root, type TaskId } from '@earendil-works/pi-durable';
import { readApplicationSettings } from '../config';
import { createAssistantWorkspace } from '../hel-pi/workspace';
import { initializeWorkspace, workspacePaths } from '../workspace';
import { openRuntime } from './bootstrap';
import { MemoryCurationService } from './memory-curation';
import { loadWorkspaceModels } from './model-config';
import { createWikiCurationExtension, WikiCurationDoc, wikiReviewRecovery } from './wiki-curation';

test.each(['saved range, expired task', 'legacy, retained task', 'legacy, expired task'])('recover a failed wiki write across SQLite restarts: %s', async scenario => {
  const home = await mkdtemp(join(tmpdir(), 'hel-pi-wiki-batch-')), paths = initializeWorkspace(workspacePaths(home));
  const path = 'wiki/bench.md', before = ['Saw goes on the bench.', 'Oil the blade.', 'Keep the teeth covered.'];
  const later = ['Store the brushes upright.', 'Wash the bristles.', 'Let them dry.'];
  const requests: string[] = [];
  const model = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const body = await req.json(); requests.push(JSON.stringify(body.messages));
    if (requests.length === 2) return Response.json({ error: { message: 'Forced failure after the tool committed.' } }, { status: 400 });
    const write = requests.length === 1;
    const delta = write ? {role:'assistant',tool_calls:[{index:0,id:'save',type:'function',function:{name:'wiki_write',
      arguments:JSON.stringify({path, revision:'missing', text:'Keep the saw covered.'})}}]} : {role:'assistant',content:'No further changes.'};
    const parts = [{delta,finish_reason:null},{delta:{},finish_reason:write ? 'tool_calls':'stop'}];
    return new Response(parts.map(c => `data: ${JSON.stringify({id:'m',model:'test',choices:[{index:0,...c}]})}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }});
  let runtime: Awaited<ReturnType<typeof openRuntime>> | undefined, service: MemoryCurationService | undefined;
  try {
    await Bun.write(join(home,'config/models.json'),JSON.stringify({providers:{test:{api:'openai-completions',baseUrl:model.url.origin+'/v1',apiKey:'fixture',models:[{id:'test',name:'Test',contextWindow:32000,maxTokens:1000}]}}}));
    await Bun.write(join(home,'config/piko.json'),JSON.stringify({version:1,agent:{profiles:{main:{provider:'test',model:'test'}}}}));
    const config = await loadWorkspaceModels({home,settings:readApplicationSettings(home),env:{}}), area = createAssistantWorkspace(paths);
    const registry = createRegistry(), bindings = () => new Map<number,string>();
    const wiki = createWikiCurationExtension({workspace:paths.workspace, coding:area.wiki, bindings, background:async () => undefined});
    registry.install(wiki.extension); registry.install(area.wiki);
    let now = Date.now();
    async function open() {
      service?.close(); await runtime?.harness.close(ctx);
      runtime = await openRuntime(paths,config,registry,{});
      service = new MemoryCurationService(runtime.harness,wiki.task,bindings,() => now,WikiCurationDoc);
      const review = wikiReviewRecovery(runtime.harness,bindings);
      await service.start(); await review.initialize();
      return {review, service, harness:runtime.harness, maintenance:runtime.maintenance};
    }
    let h = await open();
    const add = (messages: string[]) => h.harness.commit(async tx => {
      let id = 0;
      for (const content of messages) id = (await tx.appendEntry(root,{kind:'pi.user',model:[{role:'user',content,timestamp:now}]})).id;
      return id;
    },ctx);
    const state = () => h.harness.snapshot(WikiCurationDoc,root,ctx);
    const first = await add(before); await h.service.onRunEnd(); now += 31*60_000;
    expect(await h.service.tick()).toBe('started');
    const admission = (await state())!.wikiBatch!;
    expect(admission).toMatchObject({fromEntryId:0,throughEntryId:first});
    await h.harness.waitForTask(admission.taskId as TaskId,ctx);
    const saved = area.browse(path); expect(saved).toMatchObject({text:'Keep the saw covered.'});
    expect((await state())?.blocked).toBe(true);
    const next = await add(later); await h.service.onRunEnd(); now += 31*60_000;
    expect(await h.service.tick()).toBe('nothing-new');
    h = await open();
    const paused = await h.review.status();
    expect(paused.batch).toEqual(admission); expect(paused.messages?.map(m=>m.content)).toEqual(before);
    // Older builds only kept the range in the task record, which retention could remove.
    if (scenario.startsWith('legacy')) await h.harness.commit(async tx => { delete (await tx.doc(WikiCurationDoc,root)).wikiBatch; },ctx);
    if (scenario.endsWith('expired task')) expect(await h.maintenance.eraseExpired(h.harness,{kind:'memory',taskId:admission.taskId},now)).toMatchObject({tasks:[admission.taskId]});
    h = await open();
    let end = first, latest = next, pending = later;
    let ack: Record<string,unknown> = {action:'skip', taskId:admission.taskId};
    const unknown = scenario === 'legacy, expired task';
    if (!unknown) {
      expect((await state())?.wikiBatch).toEqual(admission);
      await expect(h.review.skip({...ack, taskId:admission.taskId+1})).rejects.toMatchObject({status:409});
    } else {
      expect(await h.harness.getTask(admission.taskId as TaskId,ctx)).toBeUndefined();
      await expect(h.review.skip(ack)).rejects.toMatchObject({status:409});
      const legacy = await h.review.status(), boundary = legacy.boundary!;
      expect(legacy.batch).toBeNull(); expect(boundary).toMatchObject({fromEntryId:0,throughEntryId:next});
      end = next; pending = ['New compost bin.', 'Turn it weekly.', 'Keep it covered.'];
      latest = await add(pending); await h.service.onRunEnd(); now += 31*60_000;
      h = await open(); expect((await h.review.status()).boundary).toEqual(boundary);
      ack = {action:'skip-through',token:boundary.token,throughEntryId:next};
      await expect(h.review.skip({...ack, token:'stale'})).rejects.toMatchObject({status:409});
      await expect(h.review.skip({...ack, throughEntryId:latest})).rejects.toMatchObject({status:409});
    }
    expect(await h.service.tick()).toBe('nothing-new'); expect(requests).toHaveLength(2);
    expect(await h.review.skip(ack)).toEqual({blocked:false});
    await expect(h.review.skip(ack)).rejects.toMatchObject({status:409});
    expect((await state())?.cursor).toBe(end); expect(area.browse(path)).toEqual(saved);
    h = await open(); expect(await h.review.status()).toEqual({blocked:false});
    expect(await h.service.tick()).toBe('started');
    const second = (await state())!.wikiBatch!;
    expect(second).toMatchObject({fromEntryId:end,throughEntryId:latest});
    await h.harness.waitForTask(second.taskId as TaskId,ctx);
    expect((await state())?.cursor).toBe(latest); expect(requests).toHaveLength(3);
    for (const msg of pending) expect(requests[2]).toContain(msg);
    if (unknown) for (const msg of later) expect(requests[2]).not.toContain(msg);
    for (const msg of before) expect(requests[2]).not.toContain(msg);
    expect(area.browse(path)).toEqual(saved);
  } finally { service?.close(); await runtime?.harness.close(ctx); await model.stop(true); await rm(home,{recursive:true,force:true}); }
});
