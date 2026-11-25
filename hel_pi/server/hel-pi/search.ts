import OpenAI from 'openai';
import { defineTool } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import type { WorkspaceModelConfig } from '../runtime/model-config';
import { deadline } from './deadline';

async function brave(query: string, key: string, signal: AbortSignal) {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', '5');
  url.searchParams.set('text_decorations', 'false');
  const response = await fetch(url, { headers: { Accept: 'application/json', 'X-Subscription-Token': key }, redirect: 'error', signal });
  if (!response.ok) throw new Error('Brave Search rejected the request. Check the key or quota.');
  const body = await response.json();
  const results = body.web?.results ?? [];
  return results.slice(0, 5).map((r: { title: string; url: string; description?: string }) =>
    `${r.title}\n${r.url}\n${r.description ?? ''}`).join('\n\n') || 'No web results.';
}

async function chatgpt(query: string, config: WorkspaceModelConfig, signal: AbortSignal) {
  const model = config.main;
  const grant = await config.models.getAuth('openai', { signal });
  if (model?.provider !== 'openai' || grant?.source !== 'OAuth' || !grant.auth.apiKey) throw new Error('Connect your ChatGPT plan.');
  const client = new OpenAI({ apiKey: grant.auth.apiKey, baseURL: 'https://api.openai.com/v1', maxRetries: 0,
    organization: null, project: null, fetchOptions: { redirect: 'error' } });
  const events = await client.responses.create({ model: model.model, stream: true, store: false,
    tools: [{ type: 'web_search' }], tool_choice: 'required', instructions: 'Search the public web. Give a concise answer with source URLs.',
    input: [{ role: 'user', content: query }],
  }, { signal });
  for await (const event of events) {
    if (event.type !== 'response.completed') continue;
    const items = event.response.output;
    if (!items.some(i => i.type === 'web_search_call' && i.status === 'completed')) break;
    const lines = items.flatMap(i => i.type === 'message' ? i.content.flatMap(c => c.type === 'output_text'
      ? [c.text, ...c.annotations.flatMap(a => a.type === 'url_citation' ? [`${a.title}: ${a.url}`] : [])] : []) : []);
    if (lines.length) return lines.join('\n');
  }
  throw new Error('No completed search.');
}

export function searchTool(provider: 'brave' | 'chatgpt', key: string | undefined, config: WorkspaceModelConfig) {
  if (provider === 'brave' && !key) throw new Error('Set the Brave Search API key or choose another search provider.');
  return defineTool({ name: 'web_search', description: `Search the public web using ${provider === 'brave' ? 'Brave' : 'the connected ChatGPT plan'}. Cite source URLs in the answer.`,
    parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 600 }) }), replay: 'unsafe',
    async execute({ query }, _api, ctx) {
      const signal = deadline(60_000, ctx.abortSignal);
      try {
        const text = provider === 'brave' ? await brave(query, key!, signal) : await chatgpt(query, config, signal);
        return { output: [{ type: 'text', text }] };
      } catch { throw new Error(provider === 'brave' ? 'Brave Search unavailable. Check the API key, quota, or network.' :
        'ChatGPT search unavailable. Check the connection, model and workspace search policy, or select Brave in Hel-Pi configuration.'); }
    },
  });
}
