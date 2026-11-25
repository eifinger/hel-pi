import { McpClient, StreamableHttpTransport, toLlmContent } from '@earendil-works/pi-mcp';
import { defineTool } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import type { Connections } from './connections';
import { deadline } from './deadline';

export async function withMcp<T>(url: string, secret: string, signal: AbortSignal | undefined, operation: (client: McpClient, signal: AbortSignal) => Promise<T>) {
  const client = new McpClient({ name: 'hel-pi', version: '0.2.1', requestTimeoutMs: 15_000 });
  const limit = deadline(20_000, signal);
  try {
    await client.connect(new StreamableHttpTransport({ url, headers: secret ? { Authorization: `Bearer ${secret}` } : {},
      openGetStream: false, maxMessageBytes: 512_000, reconnect: { maxRetries: 0 },
      fetch: (input, init) => fetch(input, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([limit, init.signal]) : limit }),
    }));
    return await operation(client, limit);
  } finally { await client.close().catch(() => {}); }
}

export function mcpTools(connections: Connections) {
  const server = Type.Optional(Type.String({ description: 'Connection ID from mcp_list. Optional if there is exactly one MCP server.' }));
  const servers = () => connections.list().filter(c => c.kind === 'mcp');
  return [defineTool({ name: 'mcp_list', description: 'List MCP servers, or discover tools and permitted argument schemas on one server.',
    parameters: Type.Object({ server }), replay: 'unsafe', async execute({server}, _api, ctx) {
      const all = servers();
      if (!server && all.length !== 1) return { output: [{ type: 'text', text: JSON.stringify(all.map(({id,name}) => ({id,name}))) }] };
      const row = await connections.discover(server ?? all[0].id, ctx.abortSignal);
      const tools = row.catalog.map(tool => row.allowed.includes(tool.name) ? {...tool, permitted: true} : {name: tool.name, permitted: false});
      return { output: [{ type: 'text', text: JSON.stringify({server: row.id, tools}) }] };
    },
  }), defineTool({ name: 'mcp_call', description: 'Call a tool permitted on the selected MCP server. Only perform device actions requested by the user.',
    parameters: Type.Object({ server, name: Type.String(), arguments_json: Type.String({ description: 'JSON object matching the listed input schema.', maxLength: 16_384 }) }), replay: 'unsafe',
    async execute({ server, name, arguments_json }, _api, ctx) {
      const all = servers();
      if (!server && all.length !== 1) throw new Error('Choose an MCP server ID from mcp_list.');
      let args;
      try { args = JSON.parse(arguments_json); } catch { throw new Error('MCP arguments must be a JSON object.'); }
      if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error('MCP arguments must be a JSON object.');
      const result = await connections.call(server ?? all[0].id, name, args, ctx.abortSignal);
      return { output: toLlmContent(result), isError: result.isError === true };
    },
  })] as const;
}
