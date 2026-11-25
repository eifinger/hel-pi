export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelSelection = { provider: string; model: string; thinking?: ThinkingLevel };
export type RuntimeSelection = ModelSelection | { thinking: ThinkingLevel };
export type CompactionResult = { status: "compacted" } | { status: "cancelled" };
export type ActiveCompaction = { id: string; reason: "manual" | "threshold" | "overflow" };
export type CompactionEvent = { type: "compaction"; phase: "start"; id: string; reason: ActiveCompaction["reason"] }
  | { type: "compaction"; phase: "end"; id: string; reason: ActiveCompaction["reason"]; result: CompactionResult | { status: "failed" } };
export type RuntimeDescription = {
  runtime: "pi-durable";
  tools: { name: string; status: "available" | "unconfigured" }[];
  selection?: ModelSelection;
  models: { provider: string; id: string; name: string; imageInput: boolean; contextWindow?: number; thinkingLevels: ThinkingLevel[] }[];
  skills: { name: string; description: string; path: string; disableModelInvocation: boolean }[];
};
