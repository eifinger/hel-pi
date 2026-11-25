import type { Agent } from "@earendil-works/pi-durable";
import type { ModelSettingsSnapshot } from "../../shared/settings";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ModelSettingsState } from "../settings/configuration";
import type { WorkspaceModelConfig } from "./model-config";

/** Return only model choices and role selections; provider credentials/config stay deployment-managed. */
export async function settingsSnapshot(
  agent: Agent,
  config: WorkspaceModelConfig,
  state: ModelSettingsState,
): Promise<ModelSettingsSnapshot> {
  const models = await config.models.getAvailable();
  return {
    ...state,
    currentModel: agent.model ? { provider: agent.model.provider, model: agent.model.modelId, thinking: agent.thinkingLevel } : null,
    availableModels: models.map(model => ({
      provider: model.provider, id: model.id, name: model.name, imageInput: model.input.includes("image"),
      contextWindow: model.contextWindow, thinkingLevels: getSupportedThinkingLevels(model),
    })),
  };
}
