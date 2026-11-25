import type { ModelSelection, RuntimeDescription, ThinkingLevel } from "./runtime";

/** A null background selection means it inherits main's model identity. */
export type ModelSettingsSnapshot = {
  revision: string;
  mainModel: ModelSelection | null;
  backgroundModel: ModelSelection | null;
  /** Null means the background model also inherits main's thinking strength. */
  backgroundThinking: ThinkingLevel | null;
  currentModel: ModelSelection | null;
  availableModels: RuntimeDescription["models"];
};

export type SaveModelSettings = {
  baseRevision: string;
  mainModel: ModelSelection | null;
  /** Null means follow main, not a one-time copy. */
  backgroundModel: ModelSelection | null;
  /** Can override thinking while continuing to follow main's model. */
  backgroundThinking: ThinkingLevel | null;
};

export type SaveModelSettingsResult = {
  snapshot: ModelSettingsSnapshot;
  pendingConversations: number;
};
