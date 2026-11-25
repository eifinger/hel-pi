import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { parseHTML } from 'linkedom';
// Bun's built-in undici shim does not implement custom connection handling.
import { Client, buildConnector } from 'undici/index.js';
import { defineTool } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { deadline } from './deadline';
import { credentialSafe, providerJson, record, text } from './web-provider';

const urlParameters = Type.Object({ url: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false });

async function publicDestination(url: URL, signal: AbortSignal) {
  signal.throwIfAborted();
  const host = url.hostname.replace(/\.$/, '');
  if (url.href.length > 4096 || url.protocol !== 'https:' || url.port || url.username || url.password || isIP(host) ||
      !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) || /(?:^|\.)(?:local|localhost|internal|home\.arpa|ts\.net)$/i.test(host))
    throw new Error('Only public HTTPS pages on the standard port can be read.');
  const resolver = new Resolver({ timeout: 2000, tries: 2 });
  const addresses = await resolver.resolve4(host + '.');
  if (!addresses.length || addresses.some(ip => ipaddr.parse(ip).range() !== 'unicast')) throw new Error('Not a public IPv4 destination.');
  signal.throwIfAborted();
  return { host, address: addresses[0] };
}

function pageExcerpt(content: string) {
  const value = content.trim();
  return value.slice(0, 24_000) + (value.length > 24_000 ? '\n[Page truncated]' : '');
}

// Resolve each redirect separately and dial only the vetted IP. Re-resolving the
// hostname at connection time would let a public name point into HA's network.
export async function readPublicPage(input: string, signal: AbortSignal) {
  let url = new URL(input);
  for (let hop = 0; hop <= 4; hop++) {
    const { host, address } = await publicDestination(url, signal);
    const connect = buildConnector({ timeout: 5000, rejectUnauthorized: true });
    const client = new Client(url.origin, { maxResponseSize: 1024 * 1024,
      connect: (opts, cb) => connect({ ...opts, hostname: address, servername: host }, cb),
    });
    try {
      const { statusCode, headers, body } = await client.request({ method: 'GET', path: url.pathname + url.search, signal,
        headers: { accept: 'text/html, text/plain', 'accept-encoding': 'identity' } });
      if ([301, 302, 303, 307, 308].includes(statusCode) && typeof headers.location === 'string') {
        url = new URL(headers.location, url);
        continue;
      }
      const mime = headers['content-type'];
      const type = typeof mime === 'string' && mime.split(';')[0].trim().toLowerCase();
      if (statusCode !== 200 || (type !== 'text/html' && type !== 'text/plain')) throw new Error('Expected a public HTML or text page.');
      let text = await body.text();
      if (type === 'text/html') {
        const { document } = parseHTML(text);
        for (const el of document.querySelectorAll('script,style,noscript,nav,footer,template,iframe,[hidden]')) el.remove();
        const main = document.querySelector<HTMLElement>('article,main') ?? document.body;
        text = main.innerText;
      }
      return `${url.href}\n${pageExcerpt(text)}`;
    } finally { await client.destroy(); }
  }
  throw new Error('Too many redirects.');
}

export const readPageTool = defineTool({ name: 'web_extract', description: 'Read the text of a public HTTPS page. Does not run JavaScript or use a browser login.',
  parameters: urlParameters, replay: 'unsafe',
  async execute({ url }, _api, ctx) {
    try { return { output: [{ type: 'text', text: await readPublicPage(url, deadline(15_000, ctx.abortSignal)) }] }; }
    catch { throw new Error('Could not read that page. Use a public HTTPS URL serving HTML or text under 1 MiB.'); }
  },
});

const remoteNames = { exa: 'Exa', firecrawl: 'Firecrawl', deepseek: 'DeepSeek' };
export type RemoteExtractor = keyof typeof remoteNames;

async function extract(provider: RemoteExtractor, url: string, key: string, signal: AbortSignal) {
  let title: string, content: string;
  switch (provider) {
    case 'exa': {
      const data = await providerJson('https://api.exa.ai/contents', { Authorization: `Bearer ${key}` }, signal, { ids: [url], text: {} });
      if (!Array.isArray(data.results)) throw new Error('Missing page results.');
      const results = data.results.map(record);
      const page = results.find(r => URL.parse(text(r?.url))?.href === url) ?? results[0];
      title = text(page?.title);
      content = text(page?.text);
      break;
    }
    case 'firecrawl': {
      const data = await providerJson('https://api.firecrawl.dev/v2/scrape', { Authorization: `Bearer ${key}` }, signal,
        { url, formats: ['markdown'], onlyMainContent: true });
      const page = record(data.data);
      title = text(record(page?.metadata)?.title) || text(page?.title);
      content = data.success === false ? '' : text(page?.markdown);
      break;
    }
    case 'deepseek': {
      const data = await providerJson('https://api.deepseek.com/v1/tools/fetch', { Authorization: `Bearer ${key}` }, signal, { url });
      title = text(data.title);
      content = text(data.content);
      break;
    }
  }
  if (!content) throw new Error('No readable content.');
  return credentialSafe([url, title.slice(0, 300), pageExcerpt(content)].filter(Boolean).join('\n'), key);
}

export function remotePageTool(provider: RemoteExtractor, key?: string) {
  if (!Object.hasOwn(remoteNames, provider)) throw new Error('Unknown web extraction provider.');
  const name = remoteNames[provider];
  if (!key) throw new Error(`Set the ${name} API key or choose another extraction provider.`);
  return defineTool({ name: 'web_extract', description: `Send a public HTTPS page URL to ${name} for extraction. Ask before sharing a URL that contains private data; never send a URL containing credentials.`,
    parameters: urlParameters, replay: 'unsafe',
    async execute(args, _api, ctx) {
      const signal = deadline(45_000, ctx.abortSignal);
      let url: URL;
      try {
        url = new URL(args.url);
        await publicDestination(url, signal);
        url.hash = ''; // Fragments are local to a browser, not part of an HTTP request.
      } catch { throw new Error('Use a public HTTPS page on the standard port with no embedded credentials.'); }
      try {
        const result = await extract(provider, url.href, key, signal);
        return { output: [{ type: 'text', text: result }] };
      } catch { throw new Error(`${name} could not extract that page. Check the API key, quota, or page availability.`); }
    },
  });
}
