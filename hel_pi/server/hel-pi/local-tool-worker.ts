// Trusted subprocess entry. Only Pi's QuickJS VM evaluates source; this process receives no
// credentials, connection IDs, URLs or filesystem handles from Hel-Pi.
import { InlineCodemodeSandbox, loadQuickJSWasm } from '@earendil-works/pi-codemode';
import { jsonText, limits, requestPath } from './local-tool-values';

const waiting = new Map<number, (value: unknown) => void>();
const send = (message: object) => process.send!(message);
process.on('disconnect', () => process.exit(0));

process.once('message', async ({source, input}: {source: string; input: object}) => {
  const stop = new AbortController();
  let calls = 0;
  const vm = new InlineCodemodeSandbox({
    wasm: loadQuickJSWasm(), memoryLimitBytes: limits.heap, interruptBudget: limits.polls,
    globals: [{ name: 'http.get', execute(path) {
      const id = ++calls;
      if (id > limits.calls) {
        stop.abort(new Error('Too many GET calls.'));
        throw new Error('Too many GET calls.');
      }
      // Nothing from the script crosses IPC until it is small and of the expected type.
      const relative = requestPath(path);
      const answer = Promise.withResolvers<unknown>();
      waiting.set(id, answer.resolve);
      send({type: 'get', id, path: relative});
      return answer.promise;
    } }],
  });
  process.on('message', ({id, json}: {id: number; json: string}) => {
    waiting.get(id)?.(JSON.parse(json));
    waiting.delete(id);
  });
  try {
    const run = await vm.execute(`const input = load('input');\n${source}`, {store: {input}, signal: stop.signal});
    if (!run.ok) throw new Error(run.error.kind === 'sandbox' ? 'QuickJS could not complete the script.' : run.error.message.slice(0, 512));
    if (run.output.length) throw new Error('Return a JSON value instead of logging or printing output.');
    const json = jsonText(run.value, limits.result, 'Script result');
    send({type: 'done', json});
  } catch (error) {
    send({type: 'failed', message: error instanceof Error ? error.message.slice(0, 512) : 'Script failed.'});
  } finally { await vm.close(); }
});
