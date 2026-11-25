import { afterEach, beforeEach, expect, test } from 'bun:test';
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import type { Extension } from '@earendil-works/pi-durable';
import { ArtifactStore } from '../artifacts/store';
import { createUploadReadTool } from '../attachments/read-tool';
import { AttachmentStore } from '../attachments/store';
import type { SentAttachment } from '../runtime/sent-attachments';
import { initializeWorkspace, workspacePaths } from '../workspace';
import { createAssistantWorkspace } from './workspace';

let home: string, root: string, area: ReturnType<typeof createAssistantWorkspace>;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'hel-pi-workspace-'));
  const paths = initializeWorkspace(workspacePaths(home));
  root = paths.workspace; area = createAssistantWorkspace(paths);
});
afterEach(async () => { await rm(home, {recursive:true, force:true}); });

async function call(ext: Extension, name: string, input: object, task?: string) {
  const doc = async () => ({binding:task ? {taskId:task} : null});
  const api = {conversationId:7, commit:(fn: (tx:{doc:typeof doc}) => unknown) => fn({doc})};
  const tool = ext.tools!.find(t => t.name === name)!;
  const result = await tool.execute(input, api as never, ctx);
  return JSON.parse((result.output![0] as {text:string}).text);
}
const create = (path: string, text = 'Created.') => ({path, text, revision:'missing'});

test('wiki is editable memory: empty index, nested human creation, curator conflict and human conflict', async () => {
  expect(area.browse('wiki')).toEqual({entries:[]});
  const path = 'wiki/topics/Heating.md', human = area.saveWiki(create(path, 'Human note'));
  expect(area.browse(path)).toEqual(human);
  expect(area.browse('wiki')).toEqual({entries:[{name:'topics', path:'wiki/topics', kind:'directory'}]});
  expect(await call(area.main, 'workspace_read', {path})).toEqual(human);
  const old = await call(area.wiki, 'wiki_read', {path});
  const edit = area.saveWiki({...human, text:'New human note'});
  await expect(call(area.wiki, 'wiki_write', {...old, text:'Stale reviewer'})).rejects.toMatchObject({status:409});
  const updated = await call(area.wiki, 'wiki_write', {...edit, text:'Merged note'});
  expect(() => area.saveWiki({...edit, text:'Stale human edit'})).toThrow('changed');
  expect(() => area.saveWiki(create(path))).toThrow('exists');
  expect(area.browse(path)).toEqual({...updated, text:'Merged note'});
});

test('curator reads stable and dated memories, writes only wiki Markdown; human save has the same write boundary', async () => {
  expect(area.wiki.tools!.map(t => t.name).sort()).toEqual(['wiki_read','wiki_write']);
  await writeFile(join(root,'MEMORY.md'), 'Stable'); await writeFile(join(root,'memory/2026-10-01.md'), 'Dated');
  for (const [path, text] of [['MEMORY.md','Stable'],['memory/2026-10-01.md','Dated']]) {
    expect((await call(area.wiki,'wiki_read',{path})).text).toBe(text);
    await expect(call(area.wiki,'wiki_write',create(path))).rejects.toMatchObject({status:403});
    expect(() => area.saveWiki(create(path))).toThrow();
  }
  for (const path of ['AGENTS.md','wiki/AGENTS.md','projects/n.md','artifacts/n.md','.agents/skills/new/SKILL.md', 'tasks/one/MEMORY.md','wiki/../escape.md','wiki/.hidden/n.md','wiki/topic.js']) {
    await expect(call(area.wiki,'wiki_write',create(path), 'one')).rejects.toMatchObject({status:403});
    expect(() => area.saveWiki(create(path))).toThrow();
  }
  expect(() => area.saveWiki(create('wiki/huge.md', 'é'.repeat(33000)))).toThrow('64 KiB');
});

test('workspace skills: discover metadata only, load on demand, create and revise Markdown but not programs', async () => {
  const path = '.agents/skills/folding-maps/SKILL.md';
  const text = '---\nname: folding-maps\ndescription: Folds printed maps for storage.\n---\n\nFold along the inner seam.';
  const result = await call(area.main, 'workspace_write', create(path, text));
  const index = () => area.main.sections![0].render({} as never, ctx);
  expect(await index()).toContain('piko-workspace'); expect(await index()).toContain('Folds printed maps');
  expect(await index()).not.toContain('inner seam');
  expect((await call(area.main, 'workspace_skill', {name:'folding-maps'})).body).toBe('Fold along the inner seam.');
  const disabled = text.replace('\n---\n\n', '\ndisable-model-invocation: true\n---\n\n');
  await call(area.main, 'workspace_write', {...result, text:disabled});
  expect(await index()).not.toContain('folding-maps');
  await expect(call(area.main, 'workspace_write', create('.agents/skills/other/SKILL.md', text))).rejects.toMatchObject({status:422});
  for (const invalid of ['.agents/skills/folding-maps/scripts/fold.sh','.agents/skills/folding-maps/mcp.json','.agents/hooks.md','projects/calc.ts','artifacts/AGENTS.md'])
    await expect(call(area.main, 'workspace_write', create(invalid))).rejects.toMatchObject({status:403});
  await expect(call(area.main, 'workspace_skill', {name:'../config/options.json'})).rejects.toThrow();
  await rename(join(root,'.agents'), join(root,'saved-skills'));
  await symlink(join(root,'saved-skills'), join(root,'.agents'));
  await expect(call(area.main, 'workspace_skill', {name:'folding-maps'})).rejects.toThrow();
});

test('the Skills browser and runtime see the same read-only packaged guide, then the same workspace override', async () => {
  const skills = '.agents/skills', name = 'piko-workspace', directory = `${skills}/${name}`, path = `${directory}/SKILL.md`;
  expect(area.browse(skills)).toEqual({entries:[{name, path:directory, kind:'directory'}]});
  expect(area.browse(directory)).toEqual({entries:[{name:'SKILL.md', path, kind:'file'}]});
  const packaged = area.browse(path);
  if (!('text' in packaged)) throw new Error('Expected packaged Markdown.');
  expect(packaged.text).toContain((await call(area.main,'workspace_skill',{name})).body);
  await expect(call(area.main, 'workspace_write', packaged)).rejects.toMatchObject({status:403});
  const text = `---\nname: ${name}\ndescription: A house-specific guide.\n---\n\nUse the household index.`;
  await call(area.main,'workspace_write',create(path, text));
  expect(area.browse(path)).toMatchObject({text});
  expect(await call(area.main,'workspace_skill',{name})).toMatchObject({description:'A house-specific guide.'});
  expect(area.browse(skills)).toEqual({entries:[{name, path:directory, kind:'directory'}]});
  await unlink(join(root,path));
  expect(area.browse(path)).toEqual(packaged);
});

test('task files use TaskContext, not an id chosen by the caller; public browse cannot enumerate tasks', async () => {
  const path = 'tasks/one/MEMORY.md';
  const saved = await call(area.main, 'workspace_write', create(path), 'one');
  expect(await call(area.main, 'workspace_read', {path}, 'one')).toEqual({...saved, text:'Created.'});
  for (const task of ['two',undefined]) {
    await expect(call(area.main, 'workspace_read', {path}, task)).rejects.toMatchObject({status:403});
    await expect(call(area.main, 'workspace_write', create('tasks/one/note.md'), task)).rejects.toMatchObject({status:403});
  }
  expect(() => area.browse(path)).toThrow(); expect(() => area.browse('tasks')).toThrow();
});

test('links, private config, instructions, binary files and oversized reads are not workspace documents', async () => {
  const hidden = join(home,'config/private.md'); await writeFile(hidden, 'Fixture private data');
  await link(hidden, join(root,'projects/hard.md')); await symlink(hidden, join(root,'projects/soft.md'));
  await symlink(join(home,'config'), join(root,'wiki/linked'));
  expect(area.browse('projects')).toEqual({entries:[]});
  for (const path of ['config/private.md','../config/private.md',hidden,'/etc/passwd','AGENTS.md','wiki/linked/private.md','projects/hard.md','projects/soft.md']) expect(() => area.browse(path)).toThrow();
  expect(() => area.saveWiki(create('wiki/linked/new.md'))).toThrow();
  await expect(readFile(join(home,'config/new.md'))).rejects.toThrow();
  await expect(call(area.main,'workspace_write',create('projects/hard.md'))).rejects.toThrow();
  expect(await readFile(hidden,'utf8')).toBe('Fixture private data');
  await writeFile(join(root,'projects/large.txt'), Buffer.alloc(65537));
  await writeFile(join(root,'projects/binary.txt'), Buffer.from([255,0]));
  expect(() => area.browse('projects/large.txt')).toThrow('64 KiB');
  expect(() => area.browse('projects/binary.txt')).toThrow('UTF-8');
});

test('initialization refuses private configuration redirected into the workspace', async () => {
  await rename(join(home,'config'), join(home,'original-config'));
  await symlink(join(root,'artifacts'), join(home,'config'));
  expect(() => initializeWorkspace(workspacePaths(home))).toThrow();
  await expect(readFile(join(root,'artifacts/models.json'))).rejects.toThrow();
});

test('sent files are immutable snapshots of allowed artifacts only; download and preview reject links', async () => {
  const attachments = new AttachmentStore(join(home,'state/attachments')), artifacts = new ArtifactStore(root);
  const tool = area.sent.tools![0];
  const recorded: SentAttachment[] = [];
  const tx = {appendEntry:(_kind:unknown, _id:unknown, entry:{data:SentAttachment}) => recorded.push(entry.data)};
  const api = {conversationId:7, now:() => 123, commit:(f:(t:typeof tx) => unknown) => f(tx)} as never;
  const send = (path: string) => tool.execute({path}, api, ctx);
  await call(area.main,'workspace_write',create('artifacts/report.md','First version'));
  expect((await send('artifacts/report.md')).isError).not.toBe(true);
  await writeFile(join(root,'artifacts/report.md'),'Second version');
  expect(recorded).toHaveLength(1); expect(recorded[0]).toMatchObject({name:'report.md', createdAt:123, bytes:13});
  expect(Buffer.from((await attachments.readSnapshot(recorded[0].id))!).toString()).toBe('First version');
  expect((await artifacts.download('report.md')).bytes.toString()).toBe('Second version');
  await link(join(home,'config/piko.json'),join(root,'artifacts/linked.md'));
  await symlink(join(home,'config'),join(root,'artifacts/linked-dir'));
  for (const path of ['linked.md','linked-dir/piko.json','../config/piko.json']) {
    await expect(artifacts.download(path)).rejects.toThrow(); await expect(artifacts.preview(path)).rejects.toThrow();
  }
  for (const path of ['artifacts/linked.md','artifacts/linked-dir/read.md','../config/piko.json',join(home,'config/piko.json'),'wiki/index.md']) expect((await send(path)).isError).toBe(true);
  expect(recorded).toHaveLength(1); expect((await artifacts.list()).entries.map(e => e.name)).toEqual(['report.md']);
  const snapshot = join(attachments.directory,recorded[0].id);
  await unlink(snapshot); await link(join(home,'config/piko.json'),snapshot);
  expect(await attachments.readSnapshot(recorded[0].id)).toBeUndefined();
});

test('uploaded text still uses Durable read; a hard-linked upload cannot be read through the model or store', async () => {
  const directory = join(home,'state/attachments'), store = new AttachmentStore(directory), tool = createUploadReadTool(directory);
  const file = await store.save({name:'ordinary.txt', bytes:Buffer.from('Upload content')});
  const api = {env:new NodeExecutionEnv({cwd:root})} as never;
  expect((await tool.execute({path:file.path}, api, ctx)).structuredOutput).toBe('Upload content');
  await unlink(file.path); await link(join(home,'config/piko.json'), file.path);
  expect((await tool.execute({path:file.path}, api, ctx)).isError).toBe(true);
  expect(await store.lookup(file.id)).toBeUndefined(); expect(await store.read(file.id)).toBeUndefined();
});

test('deleting an artifact folder with a hidden descendant preserves all entries', async () => {
  const artifacts = new ArtifactStore(root), folder = join(root,'artifacts/report');
  await mkdir(join(folder,'tables'), {recursive:true});
  await writeFile(join(folder,'summary.md'), 'keep');
  await writeFile(join(folder,'tables/data.csv'), 'also keep');
  await writeFile(join(folder,'tables/.DS_Store'), 'hidden');
  await expect(artifacts.delete('report')).rejects.toMatchObject({status:409});
  expect((await artifacts.download('report/summary.md')).bytes.toString()).toBe('keep');
  expect((await artifacts.download('report/tables/data.csv')).bytes.toString()).toBe('also keep');
  expect(await readFile(join(folder,'tables/.DS_Store'),'utf8')).toBe('hidden');
  await unlink(join(folder,'tables/.DS_Store'));
  expect(await artifacts.delete('report')).toEqual({path:'report',kind:'directory'});
  expect((await artifacts.list()).entries).toEqual([]);
});
