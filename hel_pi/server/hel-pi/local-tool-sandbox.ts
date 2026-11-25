import { join } from 'node:path';
import { HttpError } from '../http';
import { jsonText, limits, requestPath } from './local-tool-values';

let processes = 0;

/** A separate Bun process lets the parent enforce a wall deadline even inside a QuickJS native
 * builtin that doesn't poll the instruction budget. Only this fixed, packaged entry is started. */
export async function runLocalScript(source: string, input: object, get: (path: string, signal: AbortSignal) => unknown, caller: AbortSignal) {
  caller.throwIfAborted();
  if (processes >= limits.processes) throw new HttpError('Local tool runners are busy. Try again shortly.', 429);
  const finished = new AbortController();
  const signal = AbortSignal.any([caller, finished.signal, AbortSignal.timeout(limits.wallMs)]);
  const result = Promise.withResolvers<unknown>();
  let calls = 0;
  const proc = Bun.spawn([process.execPath, '--no-env-file', '--no-install', join(import.meta.dir, 'local-tool-worker.ts')], {
    cwd: import.meta.dir, env: {}, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    async ipc(msg, child) {
      if (signal.aborted) return;
      try {
        switch (msg?.type) {
          case 'get': {
            if (++calls > limits.calls) throw new HttpError('Too many GET calls.', 422);
            const value = await get(requestPath(msg.path), signal);
            if (!signal.aborted) child.send({id: msg.id, json: jsonText(value, limits.response, 'GET response')});
            return;
          }
          case 'done':
            if (typeof msg.json !== 'string' || Buffer.byteLength(msg.json) > limits.result) throw new Error();
            result.resolve(JSON.parse(msg.json)); return;
          case 'failed': throw new HttpError(`Local tool: ${String(msg.message).slice(0, 512)}`, 422);
          default: throw new Error();
        }
      } catch (error) {
        result.reject(error instanceof HttpError ? error : new HttpError('Local tool execution failed.', 422));
      }
    },
    onExit() { result.reject(new HttpError('Local tool runner exited before returning a result.', 503)); },
  });
  processes++;
  const aborted = () => result.reject(new HttpError('Local tool stopped (cancelled, disabled, or timed out).', 409));
  signal.addEventListener('abort', aborted, {once: true});
  try {
    try { proc.send({source, input}); }
    catch { result.reject(new HttpError('Local tool runner did not start.', 503)); }
    return await result.promise;
  } finally {
    signal.removeEventListener('abort', aborted);
    finished.abort(); // Including GETs the script started but never awaited.
    proc.kill('SIGKILL');
    try { await proc.exited; } finally { processes--; }
  }
}
