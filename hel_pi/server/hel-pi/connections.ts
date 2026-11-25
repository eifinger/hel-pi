import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonValue } from '../config/files';
import { HttpError } from '../http';
import { atomicWrite } from '../settings/configuration';
import { deadline } from './deadline';
import { requestPath } from './local-tool-values';
import { withMcp } from './mcp';

type Tool = {name: string; description?: string; inputSchema: object};
type Connection = {id: string; name: string; kind: 'mcp'|'http'; url: string; authHeader: 'Authorization'|'X-API-Key'; secret: string; allowed: string[]; catalog: Tool[]; status: string};
type Legacy = {mcp_url?: string; mcp_token?: string; mcp_allowed_tools?: string};
type Fields = Record<string, unknown>;

function invalid(message: string): never { throw new HttpError(message, 422); }
function makeConnection({name,kind,url,authHeader = 'Authorization',secret = ''}: Fields): Connection {
  if (typeof name !== 'string' || !name.trim() || name.length > 80) invalid('Choose a connection name of up to 80 characters.');
  if (kind !== 'http' && kind !== 'mcp') invalid('Choose HTTP or MCP.');
  const endpoint = typeof url === 'string' && url.length <= 2048 && URL.parse(url);
  if (!endpoint || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && endpoint.hostname === 'homeassistant')) ||
      endpoint.username || endpoint.password || endpoint.href.includes('?') || endpoint.href.includes('#'))
    invalid('Use an HTTPS URL, or HTTP on the internal homeassistant host. Enter credentials separately.');
  if (authHeader !== 'Authorization' && !(kind === 'http' && authHeader === 'X-API-Key')) invalid('Unsupported credential header.');
  return {id: crypto.randomUUID(), name: name.trim(), kind, url: endpoint.href, authHeader, secret: validateSecret(secret), allowed: [], catalog: [], status: 'Not tested'};
}

function validateSecret(secret: unknown) {
  if (typeof secret !== 'string' || secret.length > 16_384 || /[^\x21-\x7e]/.test(secret)) invalid('Enter a token without spaces or control characters.');
  return secret;
}
function publicRow({secret, ...row}: Connection) { return {...row, hasSecret: !!secret}; }
function headers(row: Connection) { return row.secret ? {[row.authHeader]: row.authHeader === 'Authorization' ? `Bearer ${row.secret}` : row.secret} : {}; }

/** Paths supplied by code are relative to the human-approved base path, never an authority. */
function requestUrl(base: string, path: string) {
  const prefix = new URL(base); prefix.pathname = prefix.pathname.replace(/\/?$/, '/');
  const url = new URL('./' + requestPath(path).replace(/^\//, ''), prefix);
  if (url.origin !== prefix.origin || !url.pathname.startsWith(prefix.pathname)) invalid('Path must stay under the connection base URL.');
  return url;
}

export class Connections {
  private path: string;
  private rows: Connection[];
  constructor(home: string, legacy: Legacy = {}) {
    this.path = join(home, 'config', 'connections.json');
    const stat = lstatSync(this.path, {throwIfNoEntry:false});
    if (stat && !stat.isFile()) throw new Error('Expected a regular connections file.');
    const data = readJsonValue(this.path, []) as Connection[];
    if (!Array.isArray(data)) throw new Error('Invalid connections file.');
    this.rows = data;
    // Import only on first creation. An intentional delete must survive a restart.
    if (!stat) {
      if (legacy.mcp_url?.trim()) {
        const row = makeConnection({name:'MCP server', kind:'mcp', url:legacy.mcp_url.trim(), secret:legacy.mcp_token?.trim()});
        row.allowed = [...new Set((legacy.mcp_allowed_tools ?? '').split(',').map(s => s.trim()).filter(Boolean))];
        this.rows.push(row);
      }
      this.save(this.rows);
    }
  }
  private save(rows: Connection[]) {
    atomicWrite(this.path, JSON.stringify(rows));
    this.rows = rows;
  }
  private row(id: unknown, kind?: Connection['kind']) {
    const c = this.rows.find(c => c.id === id);
    if (!c || kind && c.kind !== kind) throw new HttpError('Connection not found.', 404);
    return c;
  }
  private update(id: string, patch: Partial<Connection>) {
    const current = this.row(id);
    const next = {...current, ...patch};
    this.save(this.rows.map(c => c === current ? next : c));
    return next;
  }
  list() { return this.rows.map(publicRow); }

  async discover(id: string, signal?: AbortSignal) {
    const row = this.row(id, 'mcp');
    let catalog: Tool[];
    try {
      const tools = await withMcp(row.url, row.secret, signal, (client, signal) => client.listTools({signal}));
      catalog = tools.map(({name, description, inputSchema}) => ({name, description, inputSchema}));
      if (catalog.length > 1024 || Buffer.byteLength(JSON.stringify(catalog)) > 512_000) throw new Error();
    } catch {
      if (this.rows.includes(row)) this.update(id, {status:'Discovery failed'});
      throw new HttpError('Discovery failed. Check the MCP endpoint, credential and catalog size.', 502);
    }
    if (this.row(id).secret !== row.secret) throw new HttpError('Credential changed during discovery. Try again.', 409);
    return publicRow(this.update(id, {catalog, allowed:this.row(id).allowed.filter(name => catalog.some(t => t.name === name)), status:'Connected'}));
  }

  async call(id: string, name: string, args: Record<string,unknown>, signal?: AbortSignal) {
    const row = this.row(id, 'mcp');
    const permitted = () => this.row(id).secret === row.secret && this.row(id).allowed.includes(name);
    if (!permitted()) throw new HttpError('This MCP tool is not permitted by Hel-Pi configuration.', 403);
    try {
      return await withMcp(row.url, row.secret, signal, (client, signal) => {
        if (!permitted()) throw new HttpError('Connection permissions changed.', 403);
        return client.callTool(name, args, {signal});
      });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new Error('MCP request failed. If an action was sent, its outcome is unknown; do not repeat it automatically.');
    }
  }

  async get(id: string, path: string, signal: AbortSignal): Promise<unknown> {
    const c = this.row(id, 'http');
    const url = requestUrl(c.url, path);
    try {
      const response = await fetch(url, {headers: {...headers(c), Accept:'application/json'}, redirect:'error', signal:deadline(8000, signal)});
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(); }
      const chunks: Uint8Array[] = []; let length = 0;
      for await (const bytes of response.body) {
        length += bytes.byteLength;
        if (length > 128 * 1024) throw new Error();
        chunks.push(bytes);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (c.secret && text.includes(c.secret)) throw new Error();
      return JSON.parse(text);
    } catch { throw new HttpError('Connection GET failed. Expected a successful JSON response under 128 KiB.', 502); }
  }

  async change(body: Fields, signal?: AbortSignal) {
    if (body.action === 'create') {
      const c = makeConnection(body);
      if (this.rows.length >= 64) invalid('Remove a connection before adding another.');
      if (this.rows.some(r => r.name.toLowerCase() === c.name.toLowerCase())) throw new HttpError('Connection name already exists.', 409);
      this.save([...this.rows,c]); return;
    }
    const c = this.row(body.id);
    switch (body.action) {
      case 'delete': this.save(this.rows.filter(r => r !== c)); return;
      case 'secret': this.update(c.id, {secret:validateSecret(body.secret), status:'Not tested'}); return;
      case 'allow': {
        // Allow revocation even before the first discovery of an imported server.
        const {name, allowed} = body;
        if (c.kind !== 'mcp' || typeof allowed !== 'boolean' || typeof name !== 'string' ||
            !(c.catalog.some(t => t.name === name) || !allowed && c.allowed.includes(name))) invalid('Select one tool from this server’s discovery results.');
        const names = new Set(c.allowed);
        if (allowed) names.add(name); else names.delete(name);
        this.update(c.id, {allowed:[...names]}); return;
      }
      case 'discover': await this.discover(c.id, signal); return;
      case 'test': {
        if (c.kind === 'mcp') { await this.discover(c.id, signal); return; }
        let ok;
        try { const r = await fetch(c.url, {method:'HEAD', headers:headers(c), redirect:'error', signal:deadline(8000, signal)}); ok = r.ok; } catch { ok = false; }
        if (this.row(c.id).secret !== c.secret) throw new HttpError('Credential changed during test. Try again.', 409);
        this.update(c.id, {status:ok ? 'Connected' : 'Test failed'});
        if (!ok) throw new HttpError('The base URL did not accept a HEAD request. Check the URL, credentials and HEAD support.', 502);
        return;
      }
      default: invalid('Unknown connection action.');
    }
  }
}
