import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel,
  type Models,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { HarnessSettings } from "@earendil-works/pi-durable";
import { readJson } from "../config/files.ts";
import { runtimePaths } from "./config/paths.ts";
import { type ModelProfile } from "../config/schema.ts";
import type { ApplicationSettings } from "../config.ts";
import { modelsSchema } from "../config/model-schema.ts";
import { StoredCredentialStore } from "./credentials.ts";
import { configureProvider } from "./model-provider";
import type { BackgroundSelection } from "./background";

export type WorkspaceModelConfig = {
  models: Models;
  /** Global front-chat model, synchronized into main and side-chat AgentDocs. */
  main?: ModelProfile;
  /** Effective model for background work; follows main when no explicit override is configured. */
  background?: ModelProfile;
  harnessSettings: Pick<HarnessSettings, "stream">;
};

export type ModelConfigInput = {
  home: string;
  settings: ApplicationSettings;
  env: Record<string, string | undefined>;
  /** Replaces the Pi catalog; used by ad-hoc verification scripts. */
  models?: Models;
};

export async function loadWorkspaceModels({
  home,
  settings,
  env,
  models: injected,
}: ModelConfigInput): Promise<WorkspaceModelConfig> {
  const paths = runtimePaths(home);
  const agent = settings.agent;
  const config = readJson(join(paths.config, "models.json"), modelsSchema, {
    providers: {},
  });
  const credentials = new StoredCredentialStore(
    join(paths.config, "auth.json"),
  );
  const builtins = injected
    ? undefined
    : builtinModels({
        credentials,
        // Model credentials live in config/auth.json and models.json only, never in the process env.
        authContext: {
          env: async () => undefined,
          fileExists: async (path) =>
            existsSync(
              path.startsWith("~/") ? join(homedir(), path.slice(2)) : path,
            ),
        },
      });
  const models = injected ?? builtins!;
  if (!injected) {
    for (const [id, provider] of Object.entries(config.providers))
      builtins!.setProvider(
        configureProvider(
          id,
          provider,
          models.getProvider(id),
          env,
          credentials.apiKey(id),
        ),
      );
  }
  const main = agent.profiles.main;
  const backgroundOverride = agent.profiles.background;
  const background = backgroundOverride ?? (main ? {
    ...main,
    thinking: agent.profiles.backgroundThinking ?? main.thinking,
  } : undefined);
  for (const [role, profile] of [
    ["main", main],
    ["background", background],
  ] as const) {
    if (!profile) continue;
    const model = models.getModel(profile.provider, profile.model);
    if (!model)
      throw new Error(
        `Profile ${role}: unknown model ${profile.provider}/${profile.model}`,
      );
    if (!getSupportedThinkingLevels(model).includes(profile.thinking ?? "off"))
      throw new Error(
        `Profile ${role}: unsupported thinking level ${profile.thinking}`,
      );
  }
  if (main) await requireAvailableModel(models, main);
  return {
    models,
    main,
    background,
    harnessSettings: {
      stream: agent.stream as HarnessSettings["stream"],
    },
  };
}

/** Spawn fails a background job, not startup, when its provider has no usable credentials. */
export async function availableBackground(
  models: Models,
  profile: ModelProfile | undefined,
): Promise<BackgroundSelection | undefined> {
  if (!profile) return undefined;
  try {
    const model = await requireAvailableModel(models, profile);
    return {
      provider: model.provider,
      modelId: model.id,
      thinkingLevel: (profile.thinking ?? "off") as ModelThinkingLevel,
    };
  } catch (error) {
    throw new Error(
      `Background: ${error instanceof Error ? error.message : "model unavailable"}`,
    );
  }
}

export async function requireAvailableModel(
  models: Models,
  profile: ModelProfile,
): Promise<Model<Api>> {
  const model = (await models.getAvailable(profile.provider)).find(
    (model) => model.id === profile.model,
  );
  if (!model)
    throw new Error(
      `Model ${profile.provider}/${profile.model} is unavailable. Add its key to config/auth.json or models.json providers.`,
    );
  return model;
}
