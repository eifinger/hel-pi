import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Type, type Static } from "typebox";
import { Compile } from "typebox/compile";
import { workspacePaths, type WorkspacePaths } from "./workspace";
import { readConfigEnvironment, readJsonValue } from "./config/files";
import { defaultPikoFile, defaultDeployment } from "./config/defaults";
import { object, agentSchema } from "./config/schema";

export type ServerConfig = {
  hostname: string;
  port: number;
  maxRequestBytes: number;
};
export type TelegramConfig = { token: string; userId: string };
export type PikoConfig = {
  paths: WorkspacePaths;
  http: ServerConfig;
  tools: WebToolsConfig;
  channels: {
    telegram: { enabled: false } | ({ enabled: true } & TelegramConfig);
  };
};
const text = Type.String({ minLength: 1 });
const tool = object({ enabled: Type.Boolean() });
const searchProvider = Type.Union([
  Type.Literal("exa"), Type.Literal("tavily"), Type.Literal("deepseek"), Type.Literal("brave"),
]);
const webSearchTool = object({
  enabled: Type.Boolean(),
  providers: Type.Array(searchProvider, { minItems: 1, uniqueItems: true }),
});
const applicationSchema = object({
  version: Type.Literal(1),
  agent: agentSchema,
  channels: object({
    telegram: object({ enabled: Type.Boolean(), userId: Type.Optional(text) }),
  }),
  tools: object({ web_search: webSearchTool, web_extract: tool }),
});
export type ApplicationSettings = Static<typeof applicationSchema>;
export type WebToolsConfig = ApplicationSettings["tools"];
const applicationValidator = Compile(applicationSchema);

export function defaultServerConfig(): ServerConfig {
  return {
    hostname: defaultDeployment.host,
    port: defaultDeployment.port,
    maxRequestBytes: 64_000,
  };
}
function invalid(field: string, expected: string): never {
  throw new Error(
    `Invalid Piko configuration at ${field}: expected ${expected}.`,
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function merge(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (!record(override) || !record(base)) return override;
  return {
    ...base,
    ...Object.fromEntries(
      Object.entries(override).map(([key, value]) => [
        key,
        merge(base[key], value),
      ]),
    ),
  };
}

/** JSON owns application behavior exclusively. Deployment and credentials are not accepted here. */
export function validateApplicationSettings(value: unknown): ApplicationSettings {
  if (!record(value)) invalid("configuration", "a JSON object");
  if (!applicationValidator.Check(value)) {
    const error = [...applicationValidator.Errors(value)][0];
    const field =
      error?.instancePath?.slice(1).replaceAll("/", ".") || "configuration";
    throw new Error(
      `Invalid configuration in piko.json at ${field}: JSON accepts only application behavior, not deployment parameters or credentials.`,
    );
  }
  return value;
}

export function readApplicationSettings(home: string): ApplicationSettings {
  const path = join(home, "config", "piko.json");
  const file = readJsonValue(path, {});
  if (!record(file)) invalid("configuration", "a JSON object");
  return validateApplicationSettings(merge(defaultPikoFile, file));
}

function telegramConfig(
  settings: ApplicationSettings["channels"]["telegram"],
  env: Record<string, string | undefined>,
): PikoConfig["channels"]["telegram"] {
  if (!settings.enabled) return { enabled: false };
  const token = env.PIKO_TELEGRAM_BOT_TOKEN?.trim();
  if (!token)
    invalid(
      "PIKO_TELEGRAM_BOT_TOKEN",
      "a backend environment token when Telegram is enabled",
    );
  const userId = settings.userId?.trim() ?? "";
  if (!/^[1-9]\d*$/.test(userId) || !Number.isSafeInteger(Number(userId)))
    invalid(
      "channels.telegram.userId",
      "a positive numeric Telegram user ID in piko.json",
    );
  return { enabled: true, token, userId };
}

/** JSON behavior and environment deployment have disjoint fields; neither overrides the other. */
export function loadPikoConfig(
  ambient: Record<string, string | undefined> = process.env,
): PikoConfig {
  // Home locates its own .env; it is necessarily a process bootstrap parameter.
  const home = ambient.PIKO_HOME ?? join(homedir(), ".piko");
  if (!isAbsolute(home)) invalid("PIKO_HOME", "an absolute path");
  const root = resolve(home);
  const env = readConfigEnvironment(root, ambient);
  const settings = readApplicationSettings(root);
  const hostname = (env.PIKO_HOST ?? defaultDeployment.host).trim();
  if (!hostname || /\s/.test(hostname))
    invalid("PIKO_HOST", "a nonempty host without whitespace");
  const rawPort = env.PIKO_PORT ?? String(defaultDeployment.port);
  const port = /^\d+$/.test(rawPort.trim()) ? Number(rawPort) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    invalid("PIKO_PORT", "an integer from 1 to 65535");
  const workspace = env.PIKO_WORKSPACE ?? join(root, "workspace");
  if (!isAbsolute(workspace)) invalid("PIKO_WORKSPACE", "an absolute path");
  const telegram = telegramConfig(settings.channels.telegram, env);
  return {
    paths: workspacePaths(root, workspace),
    http: { ...defaultServerConfig(), hostname, port },
    tools: settings.tools,
    channels: { telegram },
  };
}
