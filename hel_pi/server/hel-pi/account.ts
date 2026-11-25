import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { HttpError, json, readObjectBody } from "../http";
import { runtimePaths } from "../runtime/config/paths";
import { StoredCredentialStore } from "../runtime/credentials";
import type { AppRuntime } from "../runtime/types";

const provider = "openai";
const catalogUrl = "https://api.openai.com/v1/models";
const loginLifetime = 10 * 60_000;

function installationId(config: string) {
  const path = join(config, "hel-pi-installation-id");
  mkdirSync(config, { recursive: true, mode: 0o700 });
  try { writeFileSync(path, randomUUID() + "\n", { flag: "wx", mode: 0o600, flush: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return readFileSync(path, "utf8").trim(); // Pi validates the UUID; never substitute another installation's ID.
}

function begin(config: string) {
  // Pi's SDK always binds its own callback listener (even for the manual-input flow).
  if (process.env.PI_OAUTH_CALLBACK_HOST && process.env.PI_OAUTH_CALLBACK_HOST !== "127.0.0.1")
    throw new Error("A local OAuth listener is required.");
  const controller = new AbortController();
  const url = Promise.withResolvers<string>();
  const input = Promise.withResolvers<string>();
  // Stage in memory: login persists its result, but the currently installed account must
  // survive a failed exchange, ineligible account, or unsuccessful model configuration.
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
  models.setProvider(openaiProvider());
  const login = models.login(provider, "oauth", {
    signal: controller.signal,
    notify(event) { if (event.type === "auth_url") url.resolve(event.url); },
    async prompt(prompt) {
      if (prompt.type !== "manual_code") throw new Error("Unexpected login prompt.");
      const signal = prompt.signal ?? controller.signal;
      signal.throwIfAborted();
      const abort = () => input.reject(new Error("Login cancelled."));
      signal.addEventListener("abort", abort, { once: true });
      try { return await input.promise; } finally { signal.removeEventListener("abort", abort); }
    },
  }, { agentName: "Hel-Pi", getDeviceId: () => installationId(config) });
  // No waiting HTTP request while the user is at OpenAI. Observe failures even if
  // finish is never called, and do not propagate SDK errors (some include token bodies).
  void login.catch(() => url.reject(new Error("Sign-in failed.")));
  return { controller, url: url.promise, input, login, models, credentials, finishing: false, expires: Date.now() + loginLifetime };
}

function matchesAttempt(callback: string, authorizationUrl: string) {
  try {
    const url = new URL(callback);
    const params = new URL(authorizationUrl).searchParams;
    const redirect = new URL(params.get("redirect_uri")!);
    return !url.username && !url.password && !url.hash && url.origin === redirect.origin && url.pathname === redirect.pathname &&
      url.searchParams.getAll("state").length === 1 && url.searchParams.get("state") === params.get("state") &&
      (!!url.searchParams.get("error") || ["code", "client_id"].every(key => url.searchParams.getAll(key).length === 1 && !!url.searchParams.get(key)?.trim()));
  } catch { return false; }
}

async function eligibleModel(attempt: ReturnType<typeof begin>) {
  const signal = AbortSignal.any([attempt.controller.signal, AbortSignal.timeout(20_000)]);
  const resolved = await attempt.models.getAuth(provider, { signal });
  if (resolved?.source !== "OAuth" || !resolved.auth.apiKey) throw new Error("Missing ChatGPT grant.");
  const response = await fetch(catalogUrl, {
    headers: { Authorization: `Bearer ${resolved.auth.apiKey}`, Accept: "application/json" }, redirect: "error", signal,
  });
  if (!response.ok) throw new Error("Catalog unavailable.");
  const catalog = await response.json();
  const compatible = new Set((await attempt.models.getAvailable(provider, { signal }))
    .filter(model => model.api === "openai-responses").map(model => model.id));
  // Keep the account's ordering; never guess an entitlement from Pi's bundled catalog.
  if (Array.isArray(catalog?.models)) {
    for (const item of catalog.models)
      if (item?.visibility === "list" && compatible.has(item.slug)) return item.slug as string;
  }
  return undefined;
}

const error = (message: string, status: number) => json({ error: message }, status);

/** Single account shared by authenticated ingress and direct clients. */
export function createAccount(home: string, runtime: Pick<AppRuntime, "settings" | "configure">) {
  const config = runtimePaths(home).config;
  const store = new StoredCredentialStore(join(config, "auth.json"));
  let pending: ReturnType<typeof begin> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;

  function close(attempt: ReturnType<typeof begin>) {
    attempt.controller.abort();
    if (pending !== attempt) return;
    clearTimeout(expiry);
    pending = undefined;
  }

  return async (request: Request): Promise<Response> => {
    try {
      if (request.method === "GET") {
        if ((await store.read(provider))?.type !== "oauth") return json({ connected: false });
        const main = (await runtime.settings()).mainModel;
        return json({ connected: true, model: main?.provider === provider ? main.model : undefined });
      }
      if (request.method !== "POST") return error("Use GET or POST.", 405);
      if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
        return error("Expected a JSON request.", 415);
      let body;
      try { body = await readObjectBody(request, 16_384); }
      catch (failure) { return error("Invalid account request.", failure instanceof HttpError ? failure.status : 400); }
      if (pending?.finishing) return error("A sign-in is being completed.", 409);
      if (pending && Date.now() >= pending.expires) close(pending);
      if (body.action === "start") {
        if (!pending) {
          const attempt = pending = begin(config);
          expiry = setTimeout(() => close(attempt), loginLifetime);
          expiry.unref();
          void attempt.login.catch(() => close(attempt));
        }
        return json({ url: await pending.url });
      }
      if (body.action !== "finish" || typeof body.callback !== "string")
        return error("Invalid account request.", 400);
      const attempt = pending;
      if (!attempt) return error("Sign-in is missing or expired. Start again.", 409);
      if (!matchesAttempt(body.callback, await attempt.url))
        return error("Paste the complete redirect URL from this sign-in.", 400);
      // Waiting for the URL above can yield to a concurrent finish.
      if (attempt !== pending || attempt.finishing) return error("Sign-in is no longer waiting for a callback.", 409);
      attempt.finishing = true;
      clearTimeout(expiry);
      expiry = setTimeout(() => close(attempt), Math.min(30_000, Math.max(0, attempt.expires - Date.now())));
      expiry.unref();
      try {
        attempt.input.resolve(body.callback);
        await attempt.login;
        const model = await eligibleModel(attempt);
        if (!model) return error("This account has no eligible model supported by this version of Hel-Pi.", 422);
        const credential = await attempt.credentials.read(provider);
        if (credential?.type !== "oauth") throw new Error("Missing grant.");
        const selection = { provider, model };
        await store.activate(selection, credential, async () => {
          attempt.controller.signal.throwIfAborted();
          // From here finish the local transaction even if the caller disconnects.
          clearTimeout(expiry);
          await runtime.configure(selection);
        });
        return json({ connected: true, model });
      } finally { close(attempt); }
    } catch { return error("Could not complete the account request. Please try signing in again.", 502); }
  };
}
