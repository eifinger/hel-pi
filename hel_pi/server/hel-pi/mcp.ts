import { McpClient, StreamableHttpTransport, toLlmContent } from '@earendil-works/pi-mcp';
import { defineTool } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { deadline } from './deadline';

export function mcpTools(endpoint: string, token: string | undefined, allowedNames: string) {
  const url = URL.parse(endpoint);
  if (!url || (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'homeassistant')) || url.username || url.password || url.search || url.hash)
    throw new Error('Use an HTTPS MCP URL, or HTTP on the internal homeassistant host. Set the token separately.');
  const allowed = new Set(allowedNames.split(',').map(name => name.trim()).filter(Boolean));

  // Connect on demand: an unavailable HA integration must not block chat or require a Hel-Pi restart.
  async function session<T>(signal: AbortSignal | undefined, operation: (client: McpClient, signal: AbortSignal) => Promise<T>) {
    const client = new McpClient({ name: 'hel-pi', version: '0.1.0', requestTimeoutMs: 15_000 });
    const limit = deadline(20_000, signal);
    try {
      await client.connect(new StreamableHttpTransport({ url: endpoint, headers: token ? { Authorization: `Bearer ${token}` } : {},
        openGetStream: false, maxMessageBytes: 512_000, reconnect: { maxRetries: 0 },
        fetch: (input, init) => fetch(input, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([limit, init.signal]) : limit }),
      }));
      return await operation(client, limit);
    } catch { throw new Error('MCP request failed. Check the server URL, token and permissions. If an action was sent, its outcome is unknown; do not repeat it automatically.'); }
    finally { await client.close().catch(() => {}); }
  }
  return [defineTool({ name: 'mcp_list', description: 'List tool names on the configured MCP server. Permitted tools include their descriptions and argument schemas.',
    parameters: Type.Object({}), replay: 'unsafe', async execute(_args, _api, ctx) {
      const tools = await session(ctx.abortSignal, (client, signal) => client.listTools({ signal }));
      const catalog = tools.map(({ name, description, inputSchema }) =>
        allowed.has(name) ? { name, description, inputSchema, permitted: true } : { name, permitted: false });
      return { output: [{ type: 'text', text: JSON.stringify(catalog) }] };
    },
  }), defineTool({ name: 'mcp_call', description: 'Call a permitted MCP tool from mcp_list with its JSON arguments. Actions can change devices. Only take actions requested by the user.',
    parameters: Type.Object({ name: Type.String(), arguments_json: Type.String({ description: 'A JSON object matching the listed input schema; use {} for no arguments.', maxLength: 16_384 }) }), replay: 'unsafe',
    async execute({ name, arguments_json }, _api, ctx) {
      if (!allowed.has(name)) throw new Error('This MCP tool is not permitted by Hel-Pi configuration.');
      let args;
      try { args = JSON.parse(arguments_json); } catch { throw new Error('MCP arguments must be a JSON object.'); }
      if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error('MCP arguments must be a JSON object.');
      const result = await session(ctx.abortSignal, (client, signal) => client.callTool(name, args, { signal }));
      return { output: toLlmContent(result), isError: result.isError === true };
    },
  })] as const;
}
