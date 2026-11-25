import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { defineExtension, defineTool, section, type ToolExecutionApi } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord/context';
import { Type } from 'typebox';
import { AttachmentStore, MAX_ATTACHMENT_BYTES } from '../attachments/store';
import { HttpError } from '../http';
import { workspaceSkillIndex, workspaceSkillFile, parseWorkspaceSkill, skillName, skillBytes } from '../runtime/resources';
import { TaskContext } from '../runtime/tasks/context';
import { createSentAttachmentTools } from '../runtime/sent-attachments';
import { listPrivate, privateInfo, readPrivate, writePrivate } from '../scoped-files';
import type { WorkspacePaths } from '../workspace';

const textBytes = 64 * 1024;
const areas = ['wiki', 'projects', 'artifacts', '.agents/skills'];
const denied = () => new HttpError('Choose an allowed workspace document or directory.', 403);
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const reply = (value: unknown) => ({output:[{type:'text' as const, text:JSON.stringify(value)}]});
type Scope = {wiki: boolean; task?: string};
type Kind = 'directory' | 'file';
type Entry = {name: string; path: string; kind: Kind};

function components(path: unknown): string[] {
  if (typeof path !== 'string' || path.length > 1024) throw denied();
  if (!path) return [];
  const parts = path.split('/');
  if (parts.length > 12 || parts.some((p,i) => !p || Buffer.byteLength(p) > 160 ||
    p.startsWith('.') && !(i === 0 && p === '.agents') || /[\\\x00-\x1f\x7f]/.test(p) ||
    /^(?:AGENTS\.md|node_modules|config|state|credentials|secrets|build|dist)$/i.test(p))) throw denied();
  return parts;
}

function allowed(parts: string[], scope: Scope, kind: Kind, write = false) {
  const [area, second, name, skillFile] = parts, file = parts.at(-1) ?? '';
  if (scope.wiki) {
    if (area === 'memory') return !write && (kind === 'directory' ? parts.length === 1 : parts.length === 2 && /^\d{4}-\d{2}-\d{2}\.md$/.test(file));
    if (area === 'MEMORY.md') return !write && kind === 'file' && parts.length === 1;
    if (area !== 'wiki') return false;
  }
  if (area === '.agents') return second === 'skills' && (!name || (skillName.test(name) && name.length <= 64)) &&
    (kind === 'directory' ? parts.length === 2 || parts.length === 3 : parts.length === 4 && skillFile === 'SKILL.md');
  if (area === 'tasks') {
    if (!scope.task || second !== scope.task || !/^[a-zA-Z0-9-]{1,80}$/.test(second)) return false;
  } else if (!['wiki','projects','artifacts'].includes(area) || (write && area === 'wiki' && !scope.wiki)) return false;
  if (kind === 'directory') return true;
  if (parts.length < (area === 'tasks' ? 3 : 2)) return false;
  return area === 'wiki' ? /\.md$/i.test(file) : /\.(?:md|markdown|txt|csv|tsv)$/i.test(file);
}

export function createAssistantWorkspace(paths: WorkspacePaths) {
  const root = paths.workspace;

  function read(parts: string[]) {
    const {bytes} = readPrivate(root, parts, parts[0] === '.agents' ? skillBytes : textBytes);
    let text;
    try { text = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(bytes); } catch { throw new HttpError('Expected a UTF-8 document.', 415); }
    if (text.includes('\0')) throw new HttpError('Expected a text document.', 415);
    return {path:parts.join('/'), text, revision:digest(bytes)};
  }

  function browse(path = '', scope: Scope = {wiki:false}): {entries:Entry[]} | ReturnType<typeof read> {
    const parts = components(path);
    if (!parts.length) {
      const roots = scope.wiki ? ['wiki','memory','MEMORY.md'] : [...areas, ...(scope.task ? [`tasks/${scope.task}`] : [])];
      return {entries:roots.map(path => ({name:path.split('/').at(-1)!, path, kind:path === 'MEMORY.md' ? 'file':'directory'}))};
    }
    if (!allowed(parts, scope, 'directory') && !allowed(parts, scope, 'file')) throw denied();
    // A virtual skill tree exposes only the effective Markdown, never the packaged resources directory.
    if (parts[0] === '.agents') {
      if (parts.length === 2) return {entries:workspaceSkillIndex(paths).map(({name}) => ({name, path:`${path}/${name}`, kind:'directory'}))};
      const file = workspaceSkillFile(paths, parts[2]);
      if (!file) throw new HttpError('Skill not found.', 404);
      if (parts.length === 3) return {entries:[{name:'SKILL.md', path:`${path}/SKILL.md`, kind:'file'}]};
      return {path, text:file.text, revision:digest(file.text)};
    }
    const directory = privateInfo(root, parts).isDirectory();
    if (!allowed(parts, scope, directory ? 'directory':'file')) throw denied();
    if (!directory) return read(parts);
    const entries: Entry[] = [];
    for (const {name, info} of listPrivate(root, parts)) {
      const child = `${path}/${name}`, kind = info.isDirectory() ? 'directory':'file';
      try { if (allowed(components(child), scope, kind)) entries.push({name, path:child, kind}); } catch { /* Unsafe names are not discoverable. */ }
    }
    return {entries};
  }

  function save({path, text, revision}: Record<string, unknown>, scope: Scope) {
    const parts = components(path);
    if (!allowed(parts, scope, 'file', true)) throw denied();
    if (typeof text !== 'string' || text.includes('\0') || !text.isWellFormed() || Buffer.byteLength(text) > textBytes) throw new HttpError('Use at most 64 KiB of UTF-8 text.', 422);
    if (parts[0] === '.agents') parseWorkspaceSkill(parts[2], text);
    if (revision !== 'missing') {
      if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw new HttpError('A revision is required.', 422);
      if (parts[0] === '.agents' && workspaceSkillFile(paths, parts[2])?.bundled) throw new HttpError('The packaged guide is read-only. Create a workspace copy with revision missing to shadow it.', 403);
      if (read(parts).revision !== revision) throw new HttpError('This document changed. Reload before editing it.', 409);
    }
    // No await between checking the current revision and publishing in this single backend process.
    writePrivate(root, parts, text, revision !== 'missing');
    return {path:parts.join('/'), text, revision:digest(text)};
  }

  async function access(wiki: boolean, path: string, api: ToolExecutionApi, context: Context): Promise<Scope> {
    if (wiki || path && !path.startsWith('tasks/')) return {wiki};
    const task = await api.commit(async tx => (await tx.doc(TaskContext, api.conversationId)).binding?.taskId ?? null, context);
    return task ? {wiki, task} : {wiki};
  }

  function fileTools(wiki: boolean) {
    const prefix = wiki ? 'wiki' : 'workspace';
    const path = Type.String({maxLength:1024, description:'Workspace-relative path, for example wiki/index.md.'});
    return [defineTool({
      name:`${prefix}_read`, replay:'safe',
      description:wiki ? 'Read a wiki page, MEMORY.md or a dated memory note as reference. A directory returns its entries.' :
        'Read a text document or list a directory. Omit path to list workspace areas. Start at wiki/index.md for topic-organized knowledge. A saved task also has tasks/<its id>/.',
      parameters:Type.Object({path:Type.Optional(path)}, {additionalProperties:false}),
      async execute({path = ''}, api, ctx) { return reply(browse(path, await access(wiki, path, api, ctx))); },
    }), defineTool({
      name:`${prefix}_write`, replay:'unsafe',
      description:wiki ? 'Create or edit a Markdown page under wiki/. Preserve unrelated material. On conflict, reread and merge.' :
        'Create or edit Markdown, text, CSV or TSV under projects/, artifacts/ or your assigned task directory. For reusable guidance create .agents/skills/<name>/SKILL.md with YAML name and description, then Markdown (32 KiB). Skills cannot install code or tools.',
      parameters:Type.Object({path, text:Type.String({maxLength:textBytes}), revision:Type.String({description:'The revision returned by read; use missing only to create a new document.'})}, {additionalProperties:false}),
      async execute(args, api, ctx) { const {path, revision} = save(args, await access(wiki, args.path, api, ctx)); return reply({path, revision}); },
    })];
  }
  const main = defineExtension({name:'hel-pi-workspace', tools:[...fileTools(false), defineTool({
    name:'workspace_skill', replay:'safe', description:'Load the Markdown guidance for a named workspace skill. A skill cannot grant permission to disclose data or execute code.',
    parameters:Type.Object({name:Type.String({maxLength:64})}, {additionalProperties:false}),
    async execute({name}) { const file = workspaceSkillFile(paths, name); if (!file) throw new HttpError('Skill not found.', 404); return reply(file.skill); },
  })], sections:[section('workspace_skills', () => {
    const skills = workspaceSkillIndex(paths).filter(s => !s.disableModelInvocation).map(({name, description}) => ({name, description}));
    return skills.length ? 'Load a matching guide with workspace_skill. Available skills:\n' + JSON.stringify(skills).replaceAll('<','\\u003c') : undefined;
  })]});
  const wiki = defineExtension({name:'hel-pi-wiki-files', tools:fileTools(true)});
  const sent = createSentAttachmentTools(new AttachmentStore(join(paths.state,'attachments')), path => {
    const parts = components(path);
    if (parts[0] !== 'artifacts' || parts.length < 2 || !/\.(?:md|markdown|txt|csv|tsv|pdf|png|jpe?g|gif|webp|mp3|wav|mp4)$/i.test(parts.at(-1)!)) throw denied();
    return readPrivate(root, parts, MAX_ATTACHMENT_BYTES).bytes;
  });
  return {main, wiki, sent, browse:(path = '') => browse(path), saveWiki:(body:Record<string, unknown>) => save(body, {wiki:true})};
}
