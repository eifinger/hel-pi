import { readFileSync } from 'node:fs';
import { configureLogging } from '../logging';
import { clearRuntimeTemp } from '../runtime/startup-files';
import { initializeWorkspace, workspacePaths } from '../workspace';
import { openChat } from './runtime';
import { createHandler } from './http';
import { MAX_ATTACHMENT_BYTES } from '../../shared/chat';

process.umask(0o077);
const home = '/data/piko';
configureLogging(home);
const options = JSON.parse(readFileSync('/run/hel-pi/options.json', 'utf8'));
const key: string | undefined = options.direct_access_key?.trim();
if (key && key.length < 32) throw new Error('Use a direct access key of at least 32 characters, or leave it blank.');
const paths = initializeWorkspace(workspacePaths(home));
await clearRuntimeTemp(paths.state);
const runtime = await openChat(paths);
const handle = await createHandler(paths, runtime, key);
const limits = { development: false, maxRequestBodySize: MAX_ATTACHMENT_BYTES };
const ingress = Bun.serve({ ...limits, hostname: '0.0.0.0', port: 8099, idleTimeout: 120,
  fetch: (req, server) => handle(req, true, server.requestIP(req)?.address),
});
const direct = key && Bun.serve({ ...limits, unix: '/run/hel-pi/direct.sock', fetch(req, server) {
  server.timeout(req, 120);
  return handle(req, false, undefined);
} });
const tailscale = key && Bun.spawn(['containerboot'], { stdout: 'inherit', stderr: 'inherit', env: {
  PATH: process.env.PATH, HOME: '/home/bun', TS_USERSPACE: 'true', TS_HOSTNAME: 'hel-pi',
  TS_STATE_DIR: '/data/piko/tailscale', TS_SOCKET: '/run/hel-pi/tailscaled.sock', TS_ACCEPT_DNS: 'false',
  TS_SERVE_CONFIG: '/opt/hel-pi/serve.json', TS_AUTH_ONCE: 'true', TS_BOOT_TIMEOUT: '10m', TS_NO_LOGS_NO_SUPPORT: 'true',
} });
console.info(`Hel-Pi ready. Ingress: 8099. Tailscale: ${key ? 'starting' : 'disabled'}.`);
let stopping = false;
if (tailscale) void tailscale.exited.then(() => {
  if (!stopping) console.error('Tailscale stopped. Home Assistant ingress is still available. Check the app log and restart to retry.');
});
async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (tailscale) tailscale.kill('SIGTERM');
  await Promise.all([ingress.stop(true), direct && direct.stop(true)]);
  await runtime.close();
  if (tailscale) await tailscale.exited;
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
