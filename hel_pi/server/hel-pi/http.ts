import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAuth } from '../auth';
import { AttachmentStore } from '../attachments/store';
import { attachmentRequest } from '../attachments/http';
import { chatRequest } from '../chat/http';
import { HttpError, json } from '../http';
import { ModelConfigurationError } from '../runtime/types';
import { createAccount } from './account';
import type { openChat } from './runtime';
import type { WorkspacePaths } from '../workspace';

const securityHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; base-uri 'self'; frame-ancestors 'self'; object-src 'none'; form-action 'self'; img-src 'self' data:",
};

export async function createHandler(paths: WorkspacePaths, runtime: Awaited<ReturnType<typeof openChat>>, key?: string) {
  const directory = join(import.meta.dir, '../../web');
  const index = await readFile(join(directory, 'index.html'), 'utf8');
  const assets = new Set((await readdir(directory)).filter(file => /\.(?:css|js|svg)$/.test(file)));
  const auth = key ? createAuth(key, [], true) : undefined;
  const account = createAccount(paths.home, runtime);
  const uploads = new AttachmentStore(join(paths.state, 'attachments'));

  return async function handle(request: Request, ingress: boolean, peer: string | undefined) {
    // Ingress identity comes from the connection, never a forwarded IP or browser header.
    if (ingress ? peer !== '172.30.32.2' : !auth) return json({ error: 'Forbidden.' }, 403);
    const url = new URL(request.url);
    const path = url.pathname;
    const prefix = ingress ? request.headers.get('x-ingress-path') : '';
    if (ingress && (!prefix || !/^\/api\/hassio_ingress\/[A-Za-z0-9_-]+$/.test(prefix))) return json({ error: 'Missing Home Assistant ingress path.' }, 400);
    const origin = request.headers.get('origin');
    if (origin) {
      let valid = false;
      try {
        const source = new URL(origin);
        const host = request.headers.get('x-forwarded-host');
        valid = ingress ? (source.origin === origin && ['http:', 'https:'].includes(source.protocol) &&
          (source.host === url.host || source.host === host)) : auth!.allowedOrigin(request);
      } catch { /* Invalid origin. */ }
      if (!valid) return json({ error: 'Origin not allowed.' }, 403);
    }
    try {
      if (request.method === 'GET' && path === '/') {
        const html = index.replace(/<head>/i, `<head><base href="${prefix}/">`);
        return new Response(html, { headers: { ...securityHeaders, 'Content-Type': 'text/html; charset=utf-8' } });
      }
      if (request.method === 'GET' && assets.has(path.slice(1))) return new Response(Bun.file(join(directory, path.slice(1))), { headers: securityHeaders });
      if (path === '/api/access' && request.method === 'GET') return json({ ingress, authenticated: ingress || auth!.authenticated(request) });
      if (!ingress) {
        const response = await auth!.handle(request);
        if (response) return response;
      }
      if (path === '/api/account') return ingress ? await account(request) : json({ error: 'Open Home Assistant to manage the account.' }, 403);
      if (request.method === 'GET' && path === '/api/health') return json({ ok: true, app: 'Hel-Pi', runtime: 'Pi', modelReady: await runtime.isModelReady(), activeSessions: runtime.chats.main.size });
      if (/^\/api\/chat(?:\/(?:events|history|stop))?$/.test(path)) {
        const response = await chatRequest(request, runtime.chats, uploads, 64_000);
        if (response) return response;
      }
      if (path === '/api/attachments' || path.startsWith('/api/attachments/')) {
        if (request.method === 'POST' && Buffer.byteLength(url.searchParams.get('name') ?? '') > 200) return json({ error: 'Use a shorter file name.' }, 422);
        const response = await attachmentRequest(request, uploads);
        if (response) {
          response.headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
          response.headers.set('Cache-Control', 'private, no-store');
          response.headers.set('X-Content-Type-Options', 'nosniff');
          return response;
        }
      }
      return json({ error: 'Not found.' }, 404);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      if (error instanceof ModelConfigurationError) return json({ error: 'Connect your ChatGPT plan in Home Assistant first.' }, 409);
      console.error('Hel-Pi request failed:', request.method, path.split('/').slice(0, 3).join('/'));
      return json({ error: 'The request failed. Check the Hel-Pi app log.' }, 500);
    }
  };
}
