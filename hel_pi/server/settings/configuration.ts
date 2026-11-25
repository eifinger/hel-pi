import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync, writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ModelSelection, ThinkingLevel } from "../../shared/runtime";
import type { SaveModelSettings } from "../../shared/settings";
import { readApplicationSettings, validateApplicationSettings } from "../config";
import type { ApplicationSettings } from "../config";
import type { ModelProfile } from "../config/schema";

export class SettingsRevisionConflictError extends Error {
  readonly status = 409;
  constructor() { super("模型设置已被其他操作修改，请重新读取后再保存。"); }
}

export class SettingsValidationError extends Error {
  readonly status = 400;
}

export type ModelSettingsState = {
  revision: string;
  mainModel: ModelSelection | null;
  /** Null means dynamically follow main. */
  backgroundModel: ModelSelection | null;
  backgroundThinking: ThinkingLevel | null;
};

function selection(value: ModelProfile | undefined): ModelSelection | null {
  return value ? {
    provider: value.provider,
    model: value.model,
    thinking: value.thinking ?? "off",
  } : null;
}

function profile(value: ModelSelection | null): ModelProfile | undefined {
  return value ? {
    provider: value.provider,
    model: value.model,
    thinking: value.thinking ?? "off",
  } : undefined;
}

function normalized(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(normalized).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${normalized((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function assertRegularOrMissing(path: string) {
  try {
    if (!lstatSync(path).isFile()) throw new SettingsValidationError("piko.json 必须是普通文件。");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function syncDirectory(path: string) {
  let fd: number | undefined;
  try { fd = openSync(path, "r"); fsyncSync(fd); }
  catch { /* directory sync is not supported on every filesystem */ }
  finally { if (fd !== undefined) closeSync(fd); }
}

function atomicWrite(path: string, content: string) {
  assertRegularOrMissing(path);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw new SettingsValidationError("配置目录必须是普通目录。");
  const temporary = join(directory, `.piko-model-settings-${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    const bytes = Buffer.from(content);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temporary, path);
    syncDirectory(directory);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Writes only the two user-selectable model profiles in piko.json; deployment settings stay read-only. */
export class ModelSettingsStore {
  private readonly revisionSecret = randomBytes(32);
  private queue: Promise<unknown> = Promise.resolve();
  private readonly home: string;

  constructor(home: string) { this.home = resolve(home); }

  private path() { return join(this.home, "config", "piko.json"); }

  private revision() {
    const path = this.path();
    assertRegularOrMissing(path);
    const hmac = createHmac("sha256", this.revisionSecret);
    try { hmac.update(readFileSync(path)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hmac.update("<missing>");
    }
    return hmac.digest("hex");
  }

  async snapshot(): Promise<ModelSettingsState> {
    const revision = this.revision();
    const application = readApplicationSettings(this.home);
    if (revision !== this.revision()) throw new SettingsRevisionConflictError();
    return {
      revision,
      mainModel: selection(application.agent.profiles.main),
      backgroundModel: selection(application.agent.profiles.background),
      backgroundThinking: application.agent.profiles.background
        ? null : application.agent.profiles.backgroundThinking ?? null,
    };
  }

  save(
    draft: SaveModelSettings,
    validate?: (candidate: Pick<ModelSettingsState, "mainModel" | "backgroundModel" | "backgroundThinking">) => Promise<void> | void,
  ): Promise<{ snapshot: ModelSettingsState; changed: boolean }> {
    const task = this.queue.catch(() => {}).then(() => this.saveLocked(draft, validate));
    this.queue = task;
    return task;
  }

  private async saveLocked(
    draft: SaveModelSettings,
    validate?: (candidate: Pick<ModelSettingsState, "mainModel" | "backgroundModel" | "backgroundThinking">) => Promise<void> | void,
  ) {
    const currentRevision = this.revision();
    const expected = Buffer.from(draft.baseRevision);
    const actual = Buffer.from(currentRevision);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      throw new SettingsRevisionConflictError();

    const application: ApplicationSettings = structuredClone(readApplicationSettings(this.home));
    const main = profile(draft.mainModel);
    const background = profile(draft.backgroundModel);
    application.agent.profiles.main = main;
    application.agent.profiles.background = background;
    application.agent.profiles.backgroundThinking = background
      ? undefined : draft.backgroundThinking ?? undefined;
    try { validateApplicationSettings(application); }
    catch (error) {
      throw new SettingsValidationError(error instanceof Error ? error.message : "模型设置无效。");
    }

    await validate?.({
      mainModel: draft.mainModel,
      backgroundModel: draft.backgroundModel,
      backgroundThinking: draft.backgroundThinking,
    });
    const current = readApplicationSettings(this.home);
    const changed = normalized({
      mainModel: selection(current.agent.profiles.main),
      backgroundModel: selection(current.agent.profiles.background),
      backgroundThinking: current.agent.profiles.background
        ? null : current.agent.profiles.backgroundThinking ?? null,
    }) !== normalized({
      mainModel: selection(main),
      backgroundModel: selection(background),
      backgroundThinking: background ? null : draft.backgroundThinking ?? null,
    });
    if (currentRevision !== this.revision()) throw new SettingsRevisionConflictError();
    if (changed) atomicWrite(this.path(), `${JSON.stringify(application, null, 2)}\n`);
    return { snapshot: await this.snapshot(), changed };
  }
}
