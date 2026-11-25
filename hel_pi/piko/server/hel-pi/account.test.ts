import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import { readApplicationSettings } from "../config";
import { StoredCredentialStore } from "../runtime/credentials";
import { loadWorkspaceModels } from "../runtime/model-config";
import { ModelSettingsStore } from "../settings/configuration";
import { initializeWorkspace, workspacePaths } from "../workspace";
import { createAccount } from "./account";
import { openChat } from "./runtime";

const endpoint = "http://hel-pi.test/api/account";
const tokenEndpoint = "https://auth.openai.com/api/accounts/oauth/token";
const catalogEndpoint = "https://api.openai.com/v1/models";
const nativeFetch = globalThis.fetch;
let home: string;
let authPath: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hel-pi-account-test-"));
  authPath = join(home, "config", "auth.json");
  offline(() => { throw new Error("Unexpected network request in offline test"); });
});
afterEach(() => {
  globalThis.fetch = nativeFetch;
  setSystemTime();
  rmSync(home, { recursive: true, force: true });
});

function offline(simulate: (request: Request) => Response | Promise<Response>) {
  globalThis.fetch = (async (input, init) => simulate(new Request(input, init))) as typeof fetch;
}
const token = (suffix: string) => ({
  access_token: `test-access-${suffix}`, refresh_token: `test-refresh-${suffix}`, id_token: "test-id",
  expires_in: 3600, scope: "chatgpt.tokens.use.direct",
});
type Account = ReturnType<typeof createAccount>;
function post(account: Account, body: object) {
  return account(new Request(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}
async function start(account: Account) {
  const response = await post(account, { action: "start" });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const body = await response.json();
  expect(Object.keys(body)).toEqual(["url"]);
  return new URL(body.url);
}
function redirect(url: URL) {
  const callback = new URL(url.searchParams.get("redirect_uri")!);
  callback.search = new URLSearchParams({ state: url.searchParams.get("state")!, code: "test-code", client_id: "test-issued-client" }).toString();
  return callback.href;
}
function finish(account: Account, url: URL) { return post(account, { action: "finish", callback: redirect(url) }); }
const get = async (account: Account) => (await account(new Request(endpoint))).json();
const modelsFromDisk = async () => (await loadWorkspaceModels({ home, settings: readApplicationSettings(home), env: {} })).models;

test("live chat selects the first listed, compatible model; Pi refreshes once and a reopened runtime uses the rotated grant", async () => {
  const paths = initializeWorkspace(workspacePaths(home));
  const store = new StoredCredentialStore(authPath);
  const other: Credential = { type: "api_key", key: "test-unrelated" };
  await store.modify("other", async () => other);
  // Open the actual runtime before sign-in, with its own Models and credential store.
  let runtime = await openChat(paths);
  try {
    const account = createAccount(home, runtime);
    expect(await get(account)).toEqual({ connected: false });
    const url = await start(account);
    expect((await start(account)).href).toBe(url.href);
    expect(url.origin).toBe("https://auth.openai.com");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("agent_name_hint")).toBe("Hel-Pi");
    const host = url.searchParams.get("ext_agent_host_id");
    expect(host).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);

    let exchanges = 0, catalogs = 0, refreshes = 0, responses = 0;
    offline(async request => {
      if (request.url === tokenEndpoint) {
        expect(request.method).toBe("POST");
        const form = new URLSearchParams(await request.text());
        expect(form.get("client_id")).toBe("test-issued-client");
        expect(form.get("resource")).toBe("https://api.openai.com/v1");
        if (form.get("grant_type") === "authorization_code") {
          exchanges++;
          expect(form.get("code")).toBe("test-code");
          expect(createHash("sha256").update(form.get("code_verifier")!).digest("base64url")).toBe(url.searchParams.get("code_challenge")!);
          return Response.json(token("initial"));
        }
        expect(form.get("grant_type")).toBe("refresh_token");
        expect(form.get("refresh_token")).toBe("test-refresh-initial");
        refreshes++;
        return Response.json(token("rotated"));
      }
      if (request.url === catalogEndpoint) {
        catalogs++;
        expect(request.method).toBe("GET");
        expect(request.headers.get("authorization")).toBe("Bearer test-access-initial");
        return Response.json({ models: [
          { visibility: "hide", slug: "gpt-5.4" }, { visibility: "list", slug: "not-in-pi" },
          { visibility: "list", slug: "gpt-6.1-sol" }, { visibility: "list", slug: "gpt-5.4-mini" },
        ] });
      }
      if (request.url === "https://api.openai.com/v1/responses") {
        responses++;
        expect(request.headers.get("authorization")).toBe("Bearer test-access-rotated");
        expect(await request.json()).toMatchObject({ model: "gpt-6.1-sol", stream: true, store: false });
        return new Response('data: {"type":"response.completed","response":{"id":"test-response","status":"completed","output":[]}}\n\n',
          { headers: { "Content-Type": "text/event-stream" } });
      }
      throw new Error("Unexpected URL");
    });
    const connected = { connected: true, model: "gpt-6.1-sol" };
    expect(await (await finish(account, url)).json()).toEqual(connected);
    expect(await get(account)).toEqual(connected);
    expect(await runtime.isModelReady()).toBe(true);
    expect(await store.read("openai")).toMatchObject({ type: "oauth", access: "test-access-initial", refresh: "test-refresh-initial", clientId: "test-issued-client" });
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
    expect((await finish(account, url)).status).toBe(409);
    expect(exchanges).toBe(1);
    expect(catalogs).toBe(1);

    const a = await modelsFromDisk(), b = await modelsFromDisk();
    await store.modify("openai", async current => ({ ...current!, expires: 0 }));
    const grants = await Promise.all([a.getAuth("openai"), b.getAuth("openai")]);
    expect(grants.map(grant => grant?.auth.apiKey)).toEqual(["test-access-rotated", "test-access-rotated"]);
    expect(await store.read("openai")).toMatchObject({ refresh: "test-refresh-rotated" });
    expect(await store.read("other")).toEqual(other);

    await runtime.close();
    runtime = await openChat(paths);
    const restarted = createAccount(home, runtime);
    expect(await get(restarted)).toEqual(connected);
    const afterRestart = await modelsFromDisk();
    const reply = await afterRestart.completeSimple(afterRestart.getModel("openai", connected.model)!,
      { messages: [{ role: "user", content: "offline check", timestamp: 0 }] }, { maxRetries: 0 });
    expect(reply.stopReason).toBe("stop");
    expect([refreshes, responses]).toEqual([1, 1]);
    const newUrl = await start(restarted);
    expect(newUrl.searchParams.get("ext_agent_host_id")).toBe(host);
    expect(newUrl.searchParams.get("state")).not.toBe(url.searchParams.get("state"));
    const denied = new URL(redirect(newUrl));
    denied.searchParams.set("error", "test-private-denial");
    expect((await post(restarted, { action: "finish", callback: denied.href })).status).toBe(502);

    offline(request => {
      if (request.url === tokenEndpoint) return Response.json(token("second-account"));
      expect(request.url).toBe(catalogEndpoint);
      expect(request.headers.get("authorization")).toBe("Bearer test-access-second-account");
      return Response.json({ models: [{ visibility: "list", slug: "gpt-5.4-mini" }] });
    });
    expect(await (await finish(restarted, await start(restarted))).json()).toEqual({ connected: true, model: "gpt-5.4-mini" });
    expect(readApplicationSettings(home).agent.profiles.main?.model).toBe("gpt-5.4-mini");
    expect(await store.read("openai")).toMatchObject({ refresh: "test-refresh-second-account" });
    expect(await store.read("other")).toEqual(other);
  } finally { await runtime.close(); }
});

test("bad callbacks can be corrected; expired attempts, provider failures and failed reconnects leave the existing account intact", async () => {
  const store = new StoredCredentialStore(authPath);
  const previous: Credential = { type: "oauth", access: "test-previous", refresh: "test-previous-refresh", expires: Date.now() + 3600_000 };
  await store.modify("openai", async () => previous);
  const originalInode = statSync(authPath).ino;
  let configured = 0;
  const inConfigure = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  const account = createAccount(home, {
    settings: async () => { throw new Error("unexpected settings request"); },
    async configure() {
      configured++;
      expect(await store.read("openai")).toMatchObject({ access: "test-access-new" });
      inConfigure.resolve(); await resume.promise;
      throw new Error("test-private-configuration-error");
    },
  });
  let mode: "token error" | "catalog error" | "no overlap" | "configure" = "token error";
  let requests = 0;
  offline(request => {
    requests++;
    if (request.url === tokenEndpoint) return mode === "token error"
      ? new Response("test-private-token-error", { status: 400 }) : Response.json(token("new"));
    expect(request.url).toBe(catalogEndpoint);
    if (mode === "catalog error") return new Response("test-private-catalog-error", { status: 403 });
    return Response.json({ models: mode === "no overlap" ? [{ visibility: "hide", slug: "gpt-6.1-sol" }]
      : [{ visibility: "list", slug: "gpt-6.1-sol" }] });
  });
  const expired = await start(account);
  setSystemTime(Date.now() + 11 * 60_000);
  expect((await finish(account, expired)).status).toBe(409);
  setSystemTime();
  const url = await start(account);
  for (const callback of [redirect(expired), redirect(url).replace("127.0.0.1", "attacker.invalid"), "test-code"]) {
    expect((await post(account, { action: "finish", callback })).status).toBe(400);
  }
  expect(requests).toBe(0);
  for (const stage of ["token error", "catalog error", "no overlap"] as const) {
    mode = stage;
    const failed = await finish(account, stage === "token error" ? url : await start(account));
    expect(failed.status).toBe(stage === "no overlap" ? 422 : 502);
    const payload = await failed.json();
    expect(payload).toEqual({ error: expect.any(String) });
    expect(payload.error).not.toMatch(/test-|callback\?/);
    expect(await store.read("openai")).toEqual(previous);
  }
  expect(configured).toBe(0);
  mode = "configure";
  const retry = await start(account), failed = finish(account, retry);
  await inConfigure.promise;
  try {
    expect((await finish(account, retry)).status).toBe(409);
    expect((await post(account, { action: "start" })).status).toBe(409);
    expect(await store.read("openai")).toEqual(previous); // a concurrent chat still uses the original grant
  } finally { resume.resolve(); }
  expect(await (await failed).json()).toEqual({ error: expect.not.stringMatching(/test-/) });
  expect(configured).toBe(1);
  expect(statSync(authPath).ino).toBe(originalInode);
  expect(readdirSync(join(home, "config")).sort()).toEqual(["auth.json", "hel-pi-installation-id"]);
});

test("store serializes read/modify/delete across providers and instances; rejected/aborted operations cannot clobber a newer file", async () => {
  const a = new StoredCredentialStore(authPath), b = new StoredCredentialStore(authPath);
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const first = a.modify("p", async () => { entered.resolve(); await gate.promise; return { type: "api_key", key: "test-one" }; });
  await entered.promise;
  const second = b.modify("p", async current => { expect(current).toEqual({ type: "api_key", key: "test-one" }); return { type: "api_key", key: "test-two" }; });
  const add = a.modify("q", async () => ({ type: "api_key", key: "test-independent", env: { CUSTOM: "test-setting" } }));
  const remove = b.delete("p");
  const controller = new AbortController();
  const cancelled = b.delete("q", { signal: controller.signal });
  controller.abort(); gate.resolve();
  await Promise.all([first, second, add, remove, expect(cancelled).rejects.toThrow()]);
  expect(await a.list()).toEqual([{ providerId: "q", type: "api_key" }]);
  const before = statSync(authPath);
  await expect(b.modify("q", async () => { throw new Error("fixture"); })).rejects.toThrow("fixture");
  expect(await b.modify("q", async () => undefined)).toMatchObject({ key: "test-independent" });
  expect(statSync(authPath).ino).toBe(before.ino);
  await a.modify("q", async () => ({ type: "api_key", key: "test-three" }));
  expect(statSync(authPath).ino).not.toBe(before.ino);
  expect(statSync(authPath).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({ q: { type: "api_key", key: "test-three" } });
});

test("process exit on either side of the model settings save recovers the matching credential", async () => {
  const grant: Credential = { type: "oauth", access: "test-interrupted", refresh: "test-interrupted-refresh", expires: 0 };
  for (const persistModel of [false, true]) {
    const child = Bun.spawnSync([process.execPath, "-e", `
      import { StoredCredentialStore } from "./server/runtime/credentials.ts";
      import { ModelSettingsStore } from "./server/settings/configuration.ts";
      const settings = new ModelSettingsStore(${JSON.stringify(home)});
      const store = new StoredCredentialStore(${JSON.stringify(authPath)});
      const mainModel = {provider: "openai", model: "gpt-4.1", thinking: "off"};
      await store.activate(mainModel, ${JSON.stringify(grant)}, async () => {
        if (${persistModel}) await settings.save({baseRevision: (await settings.snapshot()).revision, mainModel, backgroundModel: null, backgroundThinking: null});
        process.exit(42);
      });
    `], { cwd: join(import.meta.dir, "../..") });
    expect(child.exitCode).toBe(42);
    const restored = new StoredCredentialStore(authPath);
    expect(await restored.read("openai")).toEqual(persistModel ? grant : undefined);
    expect(readdirSync(join(home, "config")).some(name => name.includes(".activating."))).toBe(false);
  }
});

test("a runtime error after committing a new profile leaves the matching login bootable", async () => {
  const store = new StoredCredentialStore(authPath), settings = new ModelSettingsStore(home);
  const grant: Credential = { type: "oauth", access: "test-committed", refresh: "test-refresh", expires: 0 };
  const mainModel = { provider: "openai", model: "gpt-4.1" };
  await expect(store.activate(mainModel, grant, async () => {
    await settings.save({ baseRevision: (await settings.snapshot()).revision, mainModel, backgroundModel: null, backgroundThinking: null });
    throw new Error("session sync failed");
  })).rejects.toThrow("session sync failed");
  expect(await new StoredCredentialStore(authPath).read("openai")).toEqual(grant);
  expect((await (await modelsFromDisk()).getAvailable("openai")).some(model => model.id === mainModel.model)).toBe(true);
});
