import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { defineDoc, defineExtension, defineTool, ROOT_CONVERSATION_ID, section, type Harness } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { HttpError } from '../http';
import { MemoryReviewDates } from '../runtime/memory-curation';
import { isUserConversation } from '../runtime/subagents/delegations';

const guidance = 'AGENTS.md', stable = 'MEMORY.md';
const maxBytes = 64 * 1024;
const defaults = 'You are Hel-Pi, a personal assistant. Answer in the language of the user.';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const reply = (value: unknown) => ({output: [{type: 'text' as const, text: JSON.stringify(value)}]});
const legacy = defineDoc({kind:'hel-pi.household', version:1, scope:'session', initial:() => ({instructions:'', facts:[] as string[]}), checkpointWhen:() => true});

function day(name: unknown) {
  if (typeof name !== 'string' || !/^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(name)) return false;
  const date = name.slice(7, -3), time = Date.parse(date);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date;
}

/** HTTP, chat and the idle reviewer edit the same private files in the single app process. */
export function household(workspace: string, override = '') {
  const ha = override.trim();
  if (ha.length > 8192) throw new Error('Use at most 8192 characters for assistant instructions.');
  function path(name: unknown) {
    if (typeof name !== 'string' || name !== stable && name !== guidance && !day(name)) throw new HttpError('Choose a memory document.', 422);
    const file = join(workspace, name);
    if (realpathSync(dirname(file)) !== dirname(file)) throw new HttpError('Invalid memory directory.', 422);
    return file;
  }
  function read(name: string) {
    const file = path(name);
    let fd;
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {name, text:'', revision:'missing'};
      throw new HttpError('Cannot read this memory document.', 422);
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new HttpError('Expected a private text file.', 422);
      if (stat.size > maxBytes) return {name, text:'', revision:'oversized'};
      const text = readFileSync(fd, 'utf8');
      return {name, text, revision:digest(text)};
    } finally { closeSync(fd); }
  }
  // No await between revision check and atomic rename: concurrent edits cannot silently overwrite each other.
  function save(name: string, revision: unknown, text: unknown) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > maxBytes) throw new HttpError('Use at most 64 KiB of Markdown.', 422);
    const current = read(name).revision;
    if (current === 'oversized') throw new HttpError(`${name} exceeds 64 KiB. Shorten the workspace file before editing it here.`, 413);
    if (current !== revision) throw new HttpError('This document changed. Reload the latest version before saving.', 409);
    const target = path(name), tmp = join(dirname(target), `.memory-${randomUUID()}.tmp`);
    try {
      writeFileSync(tmp, text, {flag:'wx', mode:0o600, flush:true});
      renameSync(tmp, target);
    } finally { rmSync(tmp, {force:true}); }
    return {name, text, revision:digest(text)};
  }
  function dates() {
    const directory = dirname(path('memory/2000-01-01.md'));
    return readdirSync(directory, {withFileTypes:true}).filter(f => f.isFile() && day('memory/' + f.name)).map(f => f.name.slice(0,-3)).sort().reverse();
  }
  const instructions = () => ha || read(guidance).text || defaults;
  function oversized() {
    return [guidance, stable].filter(name => {
      const stat = lstatSync(path(name), {throwIfNoEntry:false});
      return stat?.isFile() && stat.nlink === 1 && stat.size > maxBytes;
    });
  }
  function view() {
    const effective = instructions();
    return {longTerm:read(stable), dates:dates(), instructions:effective, source:ha ? 'ha' : effective === defaults ? 'default' : 'local', oversized:oversized()};
  }
  const nameSchema = Type.String({description:'MEMORY.md for lasting information, or memory/YYYY-MM-DD.md for a dated note.'});
  const tools = [defineTool({
    name:'memory_read', description:'Read a memory document and its current revision. Omit name to list dates. Read dated notes when the question needs past context.',
    parameters:Type.Object({name:Type.Optional(nameSchema)}), replay:'safe',
    async execute({name}, api, context) {
      const allowed = api.conversationId === ROOT_CONVERSATION_ID ? null : await api.commit(async tx =>
        await isUserConversation(tx, api.conversationId) ? null : [...(await tx.doc(MemoryReviewDates, api.conversationId)).dates], context);
      if (name === undefined) return reply({dates:allowed ?? dates()});
      if (name === guidance) return reply({name, text:instructions()});
      if (allowed && name !== stable && !allowed.some(d => name === `memory/${d}.md`)) throw new HttpError('Outside this review batch.', 403);
      return reply(read(name));
    },
  }), defineTool({
    name:'memory_save', description:'Save revised Markdown for a dated note or long-term memory. Read it first and pass its revision unchanged; on conflict read again and reconcile the changes. Preserve unrelated notes. Do not store credentials. Assistant instructions are read-only.',
    parameters:Type.Object({name:nameSchema, revision:Type.String(), text:Type.String()}), replay:'unsafe',
    async execute({name, revision, text}, api, context) {
      if (name === guidance) throw new HttpError('Only a person can change assistant instructions.', 403);
      if (api.conversationId !== ROOT_CONVERSATION_ID) {
        const allowed = await api.commit(async tx => (await tx.doc(MemoryReviewDates, api.conversationId)).dates.some(d => name === stable || name === `memory/${d}.md`), context);
        if (!allowed) throw new HttpError('Outside this review batch.', 403);
      }
      return reply({name, revision:save(name, revision, text).revision});
    },
  })];
  return {
    async initialize(harness: Harness) {
      // Retain custom 0.1.0 files. Replace only its two verbatim, unused Piko starter templates.
      const a = read(guidance), m = read(stable);
      if (a.revision === 'missing' || a.revision === '86866476625ffcaa8644ddbb0f3b61880a8900980a6a3ac95e9d5008e03e1bec') save(guidance, a.revision, defaults);
      if (m.revision === 'missing' || m.revision === '59bc25f3aa4da2f3f9bb82033f743c31692d1b6ad275abd5adef6c2392d847a2') save(stable, m.revision, '');
      // Early development builds kept explicit facts in SQLite. Import once without duplicating a partially imported list.
      const old = await harness.snapshot(legacy, ctx);
      if (old?.instructions || old?.facts.length) {
        const current = read(stable), lines = current.text.split('\n');
        const facts = old.facts.map(f => `- ${f}`).filter(f => !lines.includes(f));
        const merged = [current.text.trimEnd(), facts.join('\n')].filter(Boolean).join('\n\n') + '\n';
        // Keep the pending migration intact until its destination can accept it without data loss.
        if (current.revision === 'oversized' || a.revision === 'oversized' || (facts.length && Buffer.byteLength(merged) > maxBytes)) return;
        if (facts.length) save(stable, current.revision, merged);
        if (old.instructions && read(guidance).text === defaults) save(guidance, read(guidance).revision, old.instructions);
        await harness.commit(async tx => { const doc = await tx.doc(legacy); doc.instructions = ''; doc.facts = []; }, ctx);
      }
    },
    tools, extension:defineExtension({name:'hel-pi-memory-files', tools}),
    sections:[section('assistant_instructions', () => instructions()), section('household_memory', () => {
      const text = read(stable).text;
      return text ? JSON.stringify(text).replaceAll('<','\\u003c') : undefined;
    })],
    memoryText:() => read(stable).text,
    view, read, oversized,
    change(body: Record<string, unknown>) {
      if (body.action === 'save' && typeof body.name === 'string' && body.name !== guidance) return save(body.name, body.revision, body.text);
      if (body.action !== 'instructions') throw new HttpError('Unknown memory action.', 422);
      if (ha) throw new HttpError('Change assistant instructions in Home Assistant Configuration.', 409);
      if (instructions() !== body.previous) throw new HttpError('Instructions changed. Reload Memories before editing them.', 409);
      if (typeof body.instructions !== 'string' || body.instructions.length > 8192) throw new HttpError('Use at most 8192 characters for instructions.', 422);
      save(guidance, read(guidance).revision, body.instructions.trim() || defaults);
      return view();
    },
  };
}
