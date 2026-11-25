import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { parseHTML } from 'linkedom';
// Bun's built-in undici shim does not implement custom connection handling.
import { Client, buildConnector } from 'undici/index.js';
import { defineTool } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { deadline } from './deadline';

// Resolve each redirect separately and dial only the vetted IP. Re-resolving the
// hostname at connection time would let a public name point into HA's network.
export async function readPublicPage(input: string, signal: AbortSignal) {
  let url = new URL(input);
  const resolver = new Resolver({ timeout: 2000, tries: 2 });
  for (let hop = 0; hop <= 4; hop++) {
    signal.throwIfAborted();
    const host = url.hostname.replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.port || url.username || url.password || isIP(host) ||
        !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) || /\.(?:local|localhost|internal|home\.arpa|ts\.net)$/i.test(host))
      throw new Error('Only public HTTPS pages on the standard port can be read.');
    const addresses = await resolver.resolve4(host + '.');
    if (!addresses.length || addresses.some(ip => ipaddr.parse(ip).range() !== 'unicast')) throw new Error('Not a public IPv4 destination.');
    const connect = buildConnector({ timeout: 5000, rejectUnauthorized: true });
    const client = new Client(url.origin, { maxResponseSize: 1024 * 1024,
      connect: (opts, cb) => connect({ ...opts, hostname: addresses[0], servername: host }, cb),
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
      return `${url.href}\n${text.trim().slice(0, 24_000)}${text.trim().length > 24_000 ? '\n[Page truncated]' : ''}`;
    } finally { await client.destroy(); }
  }
  throw new Error('Too many redirects.');
}

export const readPageTool = defineTool({ name: 'web_extract', description: 'Read the text of a public HTTPS page. Does not run JavaScript or use a browser login.',
  parameters: Type.Object({ url: Type.String({ maxLength: 4096 }) }), replay: 'unsafe',
  async execute({ url }, _api, ctx) {
    try { return { output: [{ type: 'text', text: await readPublicPage(url, deadline(15_000, ctx.abortSignal)) }] }; }
    catch { throw new Error('Could not read that page. Use a public HTTPS URL serving HTML or text under 1 MiB.'); }
  },
});
