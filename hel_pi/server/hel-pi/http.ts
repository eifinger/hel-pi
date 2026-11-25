import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAuth } from '../auth';
import { AttachmentStore } from '../attachments/store';
import { attachmentRequest } from '../attachments/http';
import { sentAttachmentRequest } from '../attachments/sent-http';
import { ArtifactStore } from '../artifacts/store';
import { artifactRequest } from '../artifacts/http';
import { chatRequest } from '../chat/http';
import { sideChatRequest } from '../side-chats/http';
import { settingsRequest } from '../settings/http';
import { taskRequest } from '../tasks/http';
import { postRequest } from '../posts/http';
import { AssistantTaskError } from '../domain/tasks';
import { PostError } from '../domain/posts';
import { SideChatError } from '../runtime/side-chats';
import { HttpError, json, readObjectBody } from '../http';
import { ModelConfigurationError, RuntimeBusyError, StorageDeletionBlocked } from '../runtime/types';
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
  const artifacts = new ArtifactStore(paths.workspace);

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
      if (path === '/api/account') return await account(request);
      if (path === '/api/wiki-review') {
        if (request.method === 'GET') return json(await runtime.wikiReview.status());
        if (request.method !== 'POST') return json({error:'Use GET or POST.'}, 405);
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json({error:'Expected JSON.'}, 415);
        return json(await runtime.wikiReview.skip(await readObjectBody(request, 1024)));
      }
      if (path === '/api/workspace') {
        if (request.method === 'GET') return json(runtime.workspace.browse(url.searchParams.get('path') ?? ''));
        if (request.method !== 'POST') return json({error:'Use GET or POST.'}, 405);
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json({error:'Expected JSON.'}, 415);
        return json(runtime.workspace.saveWiki(await readObjectBody(request, 400_000)));
      }
      if (path === '/api/connections' || path === '/api/tools' || path === '/api/memory') {
        if (request.method === 'POST') {
          if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json({error:'Expected JSON.'}, 415);
          const body = await readObjectBody(request, 256_000);
          if (path === '/api/connections') await runtime.connections.change(body, request.signal);
          else if (path === '/api/memory') return json(runtime.changeMemory(body));
          else {
            const {name, revision, action, input, fixtures} = body;
            if (typeof name !== 'string' || typeof revision !== 'number' || !Number.isSafeInteger(revision) ||
                action !== 'approve' && action !== 'reject' && action !== 'test' && action !== 'disable' && action !== 'enable') return json({error:'Invalid tool review.'}, 422);
            return json(await runtime.local.review(name, revision, action, input, fixtures));
          }
        } else if (request.method !== 'GET') return json({error:'Use GET or POST.'}, 405);
        if (path === '/api/memory') {
          const date = url.searchParams.get('date');
          return json(date === null ? runtime.memory() : runtime.memoryFile(`memory/${date}.md`));
        }
        return json(path === '/api/tools' ? runtime.catalog() : {connections:runtime.connections.list()});
      }
      if (request.method === 'GET' && path === '/api/health') return json({ ok: true, app: 'Hel-Pi', runtime: 'Pi', modelReady: await runtime.isModelReady(), activeSessions: runtime.chats.main.size });
      const action = /^\/api\/(?:side-chats\/([^/]+)\/)?chat\/(search|compact)$/.exec(path);
      if (action?.[2] === 'search' && request.method === 'GET') {
        const query = url.searchParams.get('q')?.trim();
        if (!query || query.length > 4096) return json({error:'Enter a search of 1–4096 characters.'}, 422);
        const {results, truncated} = await (await runtime.chatSession(action[1])).searchHistory(query, 25);
        return json({messages:results.map(({messageId, timestamp, role, snippet}) => ({id:messageId, createdAt:timestamp, role, content:snippet})), truncated});
      }
      if (action?.[2] === 'compact' && request.method === 'POST') return json(await (await runtime.chatSession(action[1])).compact());
      const result = await sideChatRequest(request, runtime) ?? await postRequest(request, runtime, 64_000) ??
        await settingsRequest(request, runtime) ?? await chatRequest(request, runtime.chats, uploads, 64_000);
      if (result) return result;
      if (path === '/api/tasks' || path.startsWith('/api/tasks/')) return await taskRequest(request, runtime, 64_000);
      if (path === '/api/attachments' || path.startsWith('/api/attachments/')) {
        if (request.method === 'POST' && Buffer.byteLength(url.searchParams.get('name') ?? '') > 200) return json({ error: 'Use a shorter file name.' }, 422);
      }
      const file = await attachmentRequest(request, uploads) ?? await sentAttachmentRequest(request, uploads) ?? await artifactRequest(request, artifacts);
      if (file) {
        file.headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
        file.headers.set('Cache-Control', 'private, no-store');
        file.headers.set('X-Content-Type-Options', 'nosniff');
        return file;
      }
      return json({ error: 'Not found.' }, 404);
    } catch (error) {
      if (error instanceof HttpError || error instanceof AssistantTaskError || error instanceof PostError || error instanceof SideChatError || error instanceof StorageDeletionBlocked) return json({ error: error.message }, error.status);
      if (error instanceof RuntimeBusyError) return json({error:error.message}, 409);
      if (error instanceof ModelConfigurationError) return json({error:'Connect your ChatGPT plan and select an available conversation model in Model settings.'}, 409);
      console.error('Hel-Pi request failed:', request.method, path.split('/').slice(0, 3).join('/'));
      return json({ error: 'The request failed. Check the Hel-Pi app log.' }, 500);
    }
  };
}
