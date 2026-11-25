import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { openLocalTools } from './local-tools';
import { runLocalScript } from './local-tool-sandbox';
import { limits } from './local-tool-values';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const clean of cleanup.splice(0).reverse()) clean(); });

const name = 'read_room';
const args = {
  name, connectionId: 'http-one', description: 'Read the temperature for the supplied room.',
  source: 'return (await http.get("/state?room=" + encodeURIComponent(input.room))).temperature;',
  sample_input_json: '{"room":"my room"}', sample_fixtures_json: '{"/state?room=my%20room":{"temperature":17}}',
};
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'helpi-local-tools-'));
  cleanup.push(() => rmSync(home, {recursive: true, force: true}));
  const calls: [string, string][] = [];
  const host = {
    connections: () => [{id: 'http-one', name: 'Room', secret: 'test-secret'}, {id: 'http-two', name: 'Other', secret: 'another'}],
    async get(id: string, path: string, _signal: AbortSignal) { calls.push([id, path]); return {temperature: 24}; },
  };
  const open = () => {
    const lib = openLocalTools(home, host);
    cleanup.push(lib.close);
    const [inventory, proposal, run] = lib.tools;
    function read(result: Awaited<ReturnType<typeof run.execute>>) {
      const item = result.output?.[0];
      if (item?.type !== 'text') throw new Error('Expected JSON text.');
      return JSON.parse(item.text);
    }
    return {...lib,
      async inventory(name?: string) { return read(await inventory.execute(name === undefined ? {} : {name}, null!, ctx)); },
      async draft(overrides: Partial<typeof args> = {}): Promise<number> {
        return read(await proposal.execute({...args, ...overrides}, null!, ctx)).revision;
      },
      async call(revision: number, input_json = '{"room":"garage"}') {
        return read(await run.execute({name, revision, input_json}, null!, ctx));
      },
    };
  };
  return {home, open, calls, host};
}

test('chat proposes but cannot approve, test, or run drafts; real calls are pinned to the reviewed ID', async () => {
  const {open, calls, host} = setup(); const lib = open();
  expect(lib.tools.map(t => t.name)).toEqual(['local_tool_list', 'local_tool_draft', 'local_tool_call']);
  const revision = await lib.draft();
  expect(await lib.inventory()).toEqual({tools: [], connections: [{id: 'http-one', name: 'Room'}, {id: 'http-two', name: 'Other'}]});
  await expect(lib.call(revision)).rejects.toThrow('revision');
  expect(await lib.review(name, revision, 'test')).toEqual({result: 17});
  expect(await lib.review(name, revision, 'test', {room: 'A/B'}, {'/state?room=A%2FB': {temperature: 0}})).toEqual({result: 0});
  for (const fixtures of [null, false, [], 'bad JSON', {'https://invalid.example/': 1}, {}, {'/state': {temperature: 27}}])
    await expect(lib.review(name, revision, 'test', undefined, fixtures)).rejects.toThrow();
  expect(calls).toEqual([]);
  await lib.review(name, revision, 'approve');
  expect((await lib.inventory()).tools).toEqual([{name, description: args.description, connectionId: 'http-one', revision}]);
  expect(await lib.call(revision)).toBe(24);
  host.connections = () => [{id: 'different-id', name: 'Room', secret: 'replacement'}];
  await expect(lib.call(revision)).rejects.toThrow('connection');
  expect(calls).toEqual([['http-one', '/state?room=garage']]);
});

test('active and draft survive restart; stale decisions cannot activate, reject or disable a newer revision', async () => {
  const {open, home} = setup(); let lib = open();
  const rev1 = await lib.draft(); await lib.review(name, rev1, 'approve');
  const rev2 = await lib.draft({source: 'return 2;'});
  const rev3 = await lib.draft({source: 'return 3;', connectionId: 'http-two'});
  const before = lib.list();
  expect(before).toEqual([{name, enabled: true, active: {revision: rev1, description: args.description, source: args.source, connectionId: args.connectionId,
    sampleInput: JSON.parse(args.sample_input_json), sampleFixtures: JSON.parse(args.sample_fixtures_json)},
    draft: {...before[0].active!, revision: rev3, source: 'return 3;', connectionId: 'http-two'}}]);
  lib.close(); lib = open(); expect(lib.list()).toEqual(before);
  expect(statSync(join(home, 'local-tools')).mode & 0o777).toBe(0o700);
  expect(statSync(join(home, 'local-tools/tools.sqlite')).mode & 0o777).toBe(0o600);
  for (const action of ['test', 'approve', 'reject', 'disable'] as const) await expect(lib.review(name, rev2, action)).rejects.toThrow('revision');
  await expect(lib.call(rev3)).rejects.toThrow('revision');
  expect(await lib.call(rev1)).toBe(24);
  await lib.review(name, rev3, 'reject');
  expect(lib.list()[0].draft).toBeNull(); expect(await lib.call(rev1)).toBe(24);
  const rev4 = await lib.draft({source: 'return 4;'});
  await lib.review(name, rev4, 'approve');
  await expect(lib.call(rev1)).rejects.toThrow('revision');
  await expect(lib.review(name, rev1, 'disable')).rejects.toThrow('revision');
  expect(await lib.call(rev4)).toBe(4);
  await lib.review(name, rev4, 'disable'); lib.close(); lib = open();
  expect((await lib.inventory()).tools).toEqual([]);
  const rev5 = await lib.draft(); expect(rev5).toBeGreaterThan(rev4);
  await expect(lib.review(name, rev4, 'approve')).rejects.toThrow('revision');
  await expect(lib.call(rev4)).rejects.toThrow('revision');
});

test('disable preserves both definitions for named lookup and restart; enabling requires the disabled revision and its bound ID', async () => {
  const {open, host, calls} = setup(); let lib = open();
  const first = await lib.draft(); await lib.review(name, first, 'approve');
  const next = await lib.draft({source: 'return 33;', connectionId: 'http-two'});
  const [before] = lib.list();
  await lib.review(name, first, 'disable'); lib.close(); lib = open();
  expect(lib.list()).toEqual([{...before, enabled: false}]);
  expect(await lib.inventory(name)).toEqual({...before, enabled: false});
  expect((await lib.inventory()).tools).toEqual([]);
  await expect(lib.inventory('missing')).rejects.toThrow('No local tool');
  for (const revision of [first, next]) await expect(lib.call(revision)).rejects.toThrow('revision');
  await expect(lib.review(name, next, 'enable')).rejects.toThrow('revision');
  const original = host.connections; host.connections = () => original().filter(c => c.id !== args.connectionId);
  await expect(lib.review(name, first, 'enable')).rejects.toThrow('connection');
  expect(await lib.review(name, first, 'test')).toEqual({result: 17});
  expect(calls).toEqual([]);
  host.connections = original;
  await lib.review(name, first, 'enable'); expect(lib.list()).toEqual([before]);
  expect(await lib.call(first)).toBe(24);
  await lib.review(name, first, 'disable'); await lib.review(name, next, 'approve');
  await expect(lib.review(name, first, 'enable')).rejects.toThrow('revision');
  expect((await lib.inventory()).tools).toEqual([]);
  await lib.review(name, next, 'enable');
  expect(await lib.call(next)).toBe(33);
});

test('replacing a draft during a sample test discards its stale result', async () => {
  const {open, calls} = setup(); const lib = open(); const rev = await lib.draft();
  const test = lib.review(name, rev, 'test');
  await lib.draft({source: 'return null;'});
  await expect(test).rejects.toThrow('revision'); expect(calls).toEqual([]);
});

test('disabling an active revision cancels in-flight GETs and prevents the next one', async () => {
  const {host, open} = setup(); const lib = open();
  const rev = await lib.draft({source: 'await http.get("first"); return await http.get("second");'});
  await lib.review(name, rev, 'approve');
  const first = Promise.withResolvers<AbortSignal>(); const requests: string[] = [];
  host.get = (_id, path, signal) => {
    requests.push(path); first.resolve(signal);
    return new Promise((_resolve, reject) => signal.addEventListener('abort', reject, {once: true}));
  };
  const result = lib.call(rev); const signal = await first.promise;
  await lib.review(name, rev, 'disable');
  await expect(result).rejects.toThrow('stopped');
  expect(signal.aborted).toBe(true); expect(requests).toEqual(['first']);
});

test('real QuickJS has no ambient host I/O, module loader or reusable script state', async () => {
  const {open, calls} = setup(); const lib = open();
  const rev = await lib.draft({source: `const before = load('prior'); store('prior', 'do not persist');
    let imported = false; try { await import('node:fs'); imported = true; } catch {}
    return [typeof process, typeof Bun, typeof fetch, typeof require, typeof WebSocket, typeof WebAssembly, imported, before ?? null, ALL_TOOLS.length, input];`});
  for (let i = 0; i < 2; i++) expect(await lib.review(name, rev, 'test', {text: '"; return 1; //'})).toEqual({
    result: ['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined', false, null, 0, {text: '"; return 1; //'}],
  });
  expect(calls).toEqual([]);
});

test('script, output, heap, loops, and bridge calls are bounded without poisoning the next VM', async () => {
  const paths: string[] = [];
  const run = (source: string) => runLocalScript(source, {}, p => { paths.push(p); return 1; }, new AbortController().signal);
  for (const [source, message] of [
    ['while (true) {}', /interrupt budget/], ['while (true) await null;', /interrupt budget/],
    [`return new Uint8Array(${limits.heap * 2}).length;`, /memory|QuickJS/],
    [`return '🔆'.repeat(${limits.result});`, /result/], ['console.log("not a return value"); return 1;', /logging/],
    ['return 2n;', /BigInt/i], ['return undefined;', /result/],
    ['return await http.get("https://not-the-connection.invalid");', /relative/],
    ['return await http.get({path:"/ok", headers:{}});', /relative/],
    [`for (let n=0;n<${limits.calls + 1};n++) await http.get('ok'); return 0;`, /Too many GET/],
  ] as const) await expect(run(source)).rejects.toThrow(message);
  expect(paths).toEqual(Array(limits.calls).fill('ok')); expect(await run('return 42;')).toBe(42);
});
