import OpenAI from 'openai';
import { defineTool } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import type { WorkspaceModelConfig } from '../runtime/model-config';
import { deadline } from './deadline';
import { credentialSafe, providerJson, record, text } from './web-provider';

const names = { brave: 'Brave Search', chatgpt: 'the connected ChatGPT plan', exa: 'Exa', tavily: 'Tavily', deepseek: 'DeepSeek' };
export type SearchProvider = keyof typeof names;

async function apiSearch(provider: Exclude<SearchProvider, 'chatgpt'>, query: string, key: string, signal: AbortSignal) {
  const count = 5, excerpt = 1200;
  let results: unknown;
  switch (provider) {
    case 'brave': {
      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(count));
      url.searchParams.set('text_decorations', 'false');
      const data = await providerJson(url, { 'X-Subscription-Token': key }, signal);
      results = record(data.web)?.results ?? [];
      break;
    }
    case 'exa':
      results = (await providerJson('https://api.exa.ai/search', { 'x-api-key': key }, signal, {
        query, type: 'lite', numResults: count, contents: { highlights: { maxCharacters: excerpt } },
      })).results;
      break;
    case 'tavily':
      results = (await providerJson('https://api.tavily.com/search', { Authorization: `Bearer ${key}` }, signal, {
        query, max_results: count, search_depth: 'basic', include_answer: false, include_raw_content: false, include_published_date: true,
      })).results;
      break;
    case 'deepseek':
      results = (await providerJson('https://api.deepseek.com/v1/tools/search', { Authorization: `Bearer ${key}` }, signal, {
        query, count, need_content: false,
      })).results;
      break;
  }
  if (!Array.isArray(results)) throw new Error('Missing search results.');
  const lines: string[] = [];
  for (const value of results) {
    const r = record(value);
    const url = URL.parse(text(r?.url));
    if (!r || !url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096) continue;
    const snippet = provider === 'exa' ? (Array.isArray(r.highlights) && r.highlights.map(text).filter(Boolean).join('\n')) || text(r.text)
      : provider === 'tavily' ? text(r.content) : provider === 'deepseek' ? text(r.summary) || text(r.snippet) : text(r.description);
    const date = text(r.published_date) || text(r.publishedDate) || text(r.date);
    lines.push([text(r.title).slice(0, 300) || 'Untitled', url.href, date.slice(0, 100), snippet.slice(0, excerpt)].filter(Boolean).join('\n'));
    if (lines.length === count) break;
  }
  return credentialSafe(lines.join('\n\n') || 'No web results.', key);
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
    if (lines.length) return credentialSafe(lines.join('\n'), grant.auth.apiKey);
  }
  throw new Error('No completed search.');
}

export function searchTool(provider: SearchProvider, key: string | undefined, config: WorkspaceModelConfig) {
  if (!Object.hasOwn(names, provider)) throw new Error('Unknown web search provider.');
  const name = names[provider], limit = provider === 'deepseek' ? 128 : 600;
  if (provider !== 'chatgpt' && !key) throw new Error(`Set the ${name} API key or choose another search provider.`);
  return defineTool({ name: 'web_search', description: `Send a public web query to ${name} and cite the source URLs. Include private home or chat data only with the user's explicit permission to share it.`,
    parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: limit }) }, { additionalProperties: false }), replay: 'unsafe',
    async execute({ query }, _api, ctx) {
      const signal = deadline(60_000, ctx.abortSignal);
      if (!query.trim() || Array.from(query).length > limit) throw new Error(`Use a search query of 1 to ${limit} characters.`);
      try {
        const text = provider === 'chatgpt' ? await chatgpt(query, config, signal) : await apiSearch(provider, query, key!, signal);
        return { output: [{ type: 'text', text }] };
      } catch { throw new Error(provider === 'chatgpt' ? 'ChatGPT search unavailable. Check the connection, model and workspace search policy.' :
        `${name} unavailable. Check the API key, quota, or network.`); }
    },
  });
}
