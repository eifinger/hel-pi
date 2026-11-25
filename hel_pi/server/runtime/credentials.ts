import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import type { AuthOperationOptions, Credential, CredentialStore } from "@earendil-works/pi-ai";
import { readApplicationSettings } from "../config";
import { readJsonValue } from "../config/files";

/**
 * `config/auth.json` uses the Pi credential format: one type-tagged entry per provider id, either
 * `{ type: "api_key", key }` or `{ type: "oauth", refresh, access, expires, … }`.
 * Pi owns the refresh protocol; this store commits the new credential under its file lock.
 */
const credential = Type.Union([
  Type.Object({
    type: Type.Literal("api_key"),
    key: Type.String({ minLength: 1 }),
    env: Type.Optional(Type.Record(Type.String(), Type.String())),
  }, { additionalProperties: true }),
  Type.Object({
    type: Type.Literal("oauth"),
    refresh: Type.String(),
    access: Type.String(),
    expires: Type.Number({ minimum: 0 }),
  }, { additionalProperties: true }),
]);
export const storedCredentialsSchema = Type.Record(Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$" }), credential);
export type StoredCredentials = Record<string, Credential>;
const validator = Compile(storedCredentialsSchema);

export function parseStoredCredentials(value: unknown): StoredCredentials {
  if (!validator.Check(value))
    throw new Error("Invalid credential configuration in auth.json.");
  return value as StoredCredentials;
}

// A refresh can rotate a single-use token. Hold the lock from *before* reading through
// the network exchange and atomic replacement, even across separate Models/store instances.
// Different providers also share one file. Piko's backend lock excludes other processes.
const queues = new Map<string, Promise<unknown>>();
function locked<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const result = (queues.get(path) ?? Promise.resolve()).catch(() => {}).then(operation);
  queues.set(path, result);
  return result.finally(() => { if (queues.get(path) === result) queues.delete(path); });
}

function load(path: string) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw new Error("Expected a regular credential file.");
  if (stat && (stat.mode & 0o777) !== 0o600) chmodSync(path, 0o600);
  return parseStoredCredentials(readJsonValue(path, {}));
}

function stage(path: string, values: StoredCredentials) {
  const content = JSON.stringify(parseStoredCredentials(values), null, 2) + "\n";
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.auth-${randomUUID()}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); }
  catch (error) { rmSync(temp, { force: true }); throw error; }
  finally { closeSync(fd); }
  return temp;
}

function replace(from: string, to: string) {
  renameSync(from, to);
  const directory = openSync(dirname(to), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

type Selection = { provider: string; model: string };
function candidateName(path: string, selection: Selection) {
  return `${basename(path)}.activating.${encodeURIComponent(selection.provider)}:${encodeURIComponent(selection.model)}`;
}

function selectedCandidate(path: string) {
  const main = readApplicationSettings(dirname(dirname(path))).agent.profiles.main;
  return main && candidateName(path, main);
}

// auth.json and piko.json cannot be renamed atomically together. If the process stopped
// inside configure(), finish or discard the staged rename according to the durable selection.
function recoverActivation(path: string) {
  const config = dirname(path);
  if (queues.has(path) || !existsSync(config)) return;
  const candidates = readdirSync(config).filter(name => name.startsWith(`${basename(path)}.activating.`));
  if (!candidates.length) return;
  const selected = selectedCandidate(path);
  for (const name of candidates) {
    const candidate = join(config, name);
    if (name === selected) {
      load(candidate); // must be a regular, valid credential file
      replace(candidate, path);
    } else rmSync(candidate);
  }
}

// Only configure() and its awaited Pi calls see an uncommitted login. Unrelated
// requests continue using the old account until configuration actually succeeds.
const configuring = new AsyncLocalStorage<{ path: string; staged?: string }>();

export class StoredCredentialStore implements CredentialStore {
  readonly path: string;
  constructor(path: string) {
    this.path = resolve(path);
    recoverActivation(this.path);
  }
  private file() {
    const view = configuring.getStore();
    return view?.path === this.path && view.staged ? view.staged : this.path;
  }
  apiKey(providerId: string) {
    const stored = load(this.file())[providerId];
    return stored?.type === "api_key" ? stored.key : undefined;
  }
  async read(providerId: string, options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();
    const values = load(this.file());
    return Object.hasOwn(values, providerId) ? values[providerId] : undefined;
  }
  async list(options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();
    return Object.entries(load(this.file())).map(([providerId, value]) => ({ providerId, type: value.type }));
  }
  private update(id: string, fn: (current?: Credential) => Promise<Credential | null | undefined>, options?: AuthOperationOptions) {
    const path = this.file();
    return locked(path, async () => {
      options?.signal?.throwIfAborted();
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error("Invalid provider ID.");
      const values = load(path);
      const current = Object.hasOwn(values, id) ? values[id] : undefined;
      const next = await fn(structuredClone(current));
      if (next === undefined || (next === null && !current)) return current;
      if (next === null) delete values[id];
      else values[id] = next;
      const temp = stage(path, values);
      try { replace(temp, path); } finally { rmSync(temp, { force: true }); }
      return next ?? undefined;
    });
  }
  modify(id: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions) {
    return this.update(id, fn, options);
  }
  async delete(id: string, options?: AuthOperationOptions) {
    await this.update(id, async () => null, options);
  }
  /** Stage a login until its model is configured. Preserve the old account if configuration does not commit. */
  activate(selection: Selection, login: Credential, configure: () => Promise<void>) {
    return locked(this.path, async () => {
      const previous = selectedCandidate(this.path);
      const name = candidateName(this.path, selection);
      const candidate = join(dirname(this.path), name);
      const temp = stage(this.path, { ...load(this.path), [selection.provider]: login });
      const view = { path: this.path, staged: candidate as string | undefined };
      try {
        replace(temp, candidate);
        try { await configuring.run(view, configure); }
        catch (error) {
          // The runtime may persist a changed profile and then fail to sync an open
          // session. Do not leave a committed profile unbootable on the next start.
          if (previous !== name && selectedCandidate(this.path) === name) replace(candidate, this.path);
          else rmSync(candidate, { force: true });
          throw error;
        }
        // If this rename fails, leave the complete 0600 candidate for startup recovery.
        replace(candidate, this.path);
      } finally {
        view.staged = undefined;
        rmSync(temp, { force: true });
      }
    });
  }
}
