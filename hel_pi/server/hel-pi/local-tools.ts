import { defineTool } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { HttpError } from '../http';
import { runLocalScript } from './local-tool-sandbox';
import { openToolStore } from './local-tool-store';
import { fixturesObject, invalid, jsonObject, limits } from './local-tool-values';

type Host = {
  connections(): {id: string; name: string}[];
  get(connectionId: string, path: string, signal: AbortSignal): Promise<unknown>;
};
type Action = 'test' | 'approve' | 'reject' | 'disable' | 'enable';
const namePattern = '^[a-z][a-z0-9_]{0,47}$';
const nameSchema = Type.String({pattern: namePattern});
const revisionSchema = Type.Integer({minimum: 1});
const closedSchema = {additionalProperties: false};

function parse(value: string, limit: number, label: string): unknown {
  if (typeof value !== 'string' || Buffer.byteLength(value) > limit) invalid(`${label} exceeds ${limit} bytes.`);
  try { return JSON.parse(value); } catch { invalid(`${label} must be valid JSON.`); }
}
function reply(value: unknown) { return {output: [{type: 'text' as const, text: JSON.stringify(value)}]}; }

export function openLocalTools(home: string, host: Host) {
  const store = openToolStore(home);
  const shutdown = new AbortController();
  const live = new Map<AbortController, string>();
  function requireConnection(id: string) {
    if (!host.connections().some(c => c.id === id)) throw new HttpError('Choose a current HTTP connection ID from the local tool list.', 409);
  }

  async function review(name: string, revision: number, action: Action, input?: unknown, fixtures?: unknown) {
    if (action === 'test') {
      const {version, state} = store.current(name, revision);
      const sample = jsonObject(input === undefined ? version.sampleInput : input, limits.input, 'Sample input');
      const responses = fixturesObject(fixtures === undefined ? version.sampleFixtures : fixtures);
      // The test runner never receives host.get: an invalid or missing fixture cannot fall back to I/O.
      const result = await runLocalScript(version.source, sample, path => {
        if (!Object.hasOwn(responses, path)) invalid('No fixture for the exact GET path (including query).');
        return responses[path];
      }, shutdown.signal);
      store.current(name, revision, state); // Do not report a test for a different revision/state after awaiting.
      return {result};
    }
    if (action !== 'approve' && action !== 'disable' && action !== 'reject' && action !== 'enable') invalid('Unknown local tool review action.');
    if (action === 'approve' || action === 'enable') requireConnection(store.current(name, revision, action === 'enable' ? 'disabled' : 'draft').version.connectionId);
    store.change(name, revision, action);
    if (action === 'approve' || action === 'disable') for (const [controller, tool] of live) if (tool === name) controller.abort();
    return {name, revision, action};
  }

  const tools = [defineTool({
    name: 'local_tool_list', description: 'List callable local tools and HTTP connection IDs and names. Pass one tool name to read its approved and draft definitions, including source and samples, before proposing an edit with local_tool_draft. Disabled and draft revisions cannot be called.',
    parameters: Type.Object({name: Type.Optional(nameSchema)}, closedSchema), replay: 'safe', async execute({name}) {
      if (name !== undefined) {
        const item = store.list(name)[0];
        if (!item) throw new HttpError('No local tool with that name.', 404);
        return reply(item);
      }
      return reply({tools: store.inventory(), connections: host.connections().map(({id, name}) => ({id, name}))});
    },
  }), defineTool({
    name: 'local_tool_draft', description: 'Propose a new or replacement local JavaScript tool for human review. Saving replaces its pending draft, not its approved version. A person can test the sample and approve this exact revision in the tool library.',
    parameters: Type.Object({
      name: nameSchema, description: Type.String({minLength: 1, maxLength: limits.description, description: 'Describe what the tool reads, its input fields and what it returns.'}),
      connectionId: Type.String({minLength: 1, maxLength: 128, description: 'HTTP connection ID from local_tool_list.'}),
      source: Type.String({minLength: 1, maxLength: limits.source, description: 'Async JavaScript function body, without Markdown fences. Read the JSON object input; await http.get(path) for JSON on the selected connection; return a small JSON value. Example: return (await http.get("/state?room=" + encodeURIComponent(input.room))).temperature;'}),
      sample_input_json: Type.String({maxLength: limits.input, description: 'A JSON object of example arguments, e.g. {"room":"hall"}.'}),
      sample_fixtures_json: Type.String({maxLength: limits.fixtures, description: 'A JSON object mapping exact GET paths with queries to mock JSON, e.g. {"/state?room=hall":{"temperature":19}}. Use {} for no GETs.'}),
    }, closedSchema), replay: 'unsafe', async execute({name, description, source, connectionId, sample_input_json, sample_fixtures_json}) {
      if (typeof name !== 'string' || !new RegExp(namePattern).test(name)) invalid('Use a lowercase local tool name with up to 48 letters, digits or underscores.');
      if (typeof description !== 'string' || !description.trim() || Buffer.byteLength(description) > limits.description) invalid('Provide a short tool description.');
      if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > limits.source) invalid('Provide a script of up to 16 KiB.');
      requireConnection(connectionId);
      const sampleInput = jsonObject(parse(sample_input_json, limits.input, 'Sample input'), limits.input, 'Sample input');
      const sampleFixtures = fixturesObject(parse(sample_fixtures_json, limits.fixtures, 'Fixtures'));
      const revision = store.draft(name, {description, source, connectionId, sampleInput, sampleFixtures});
      return reply({name, revision, status: 'awaiting human approval'});
    },
  }), defineTool({
    name: 'local_tool_call', description: 'Run an approved revision from local_tool_list with its input object. The tool can GET JSON only on its reviewed connection. Drafts cannot run from chat.',
    parameters: Type.Object({name: nameSchema, revision: revisionSchema, input_json: Type.String({maxLength: limits.input, description: 'JSON arguments matching the tool description; {} for none.'})}, closedSchema),
    replay: 'unsafe', async execute({name, revision, input_json}, _api, ctx) {
      const {version} = store.current(name, revision, 'enabled');
      requireConnection(version.connectionId);
      const input = jsonObject(parse(input_json, limits.input, 'Input'), limits.input, 'Input');
      const controller = new AbortController();
      live.set(controller, name);
      const signals = [controller.signal, shutdown.signal];
      if (ctx.abortSignal) signals.push(ctx.abortSignal);
      try {
        const result = await runLocalScript(version.source, input, async (path, signal) => {
          store.current(name, revision, 'enabled');
          requireConnection(version.connectionId);
          try { return await host.get(version.connectionId, path, signal); }
          catch { throw new HttpError('The approved connection GET failed.', 502); }
        }, AbortSignal.any(signals));
        store.current(name, revision, 'enabled');
        return reply(result);
      } finally { live.delete(controller); }
    },
  })] as const;

  return {tools, list: store.list, review, close() {
    if (!shutdown.signal.aborted) { shutdown.abort(); store.close(); }
  }};
}
