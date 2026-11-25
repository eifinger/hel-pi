import { Type, type Static } from "typebox";
import { object } from "./schema.ts";

/** models.json contract: model catalog, adapter metadata and request defaults, never credentials in environment. */

const string = Type.String({ minLength: 1 });
const positive = Type.Integer({ minimum: 1 });
const rates = object({
  input: Type.Number({ minimum: 0 }),
  output: Type.Number({ minimum: 0 }),
  cacheRead: Type.Number({ minimum: 0 }),
  cacheWrite: Type.Number({ minimum: 0 }),
});
const headerEnvironment = Type.Record(Type.String(), Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }));
const thinkingMap = object(
  Object.fromEntries(
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => [
      level,
      Type.Optional(Type.Union([Type.String(), Type.Null()])),
    ]),
  ),
);
// Options implemented by the OpenAI-compatible adapters. Unknown compatibility keys are rejected.
const compat = object({
  ...Object.fromEntries(
    [
      "supportsStore",
      "supportsDeveloperRole",
      "supportsReasoningEffort",
      "supportsUsageInStreaming",
      "supportsFinishReason",
      "requiresToolResultName",
      "requiresAssistantAfterToolResult",
      "requiresThinkingAsText",
      "requiresReasoningContentOnAssistantMessages",
      "supportsStrictMode",
      "supportsLongCacheRetention",
      "supportsMaxOutputTokens",
      "sendSessionAffinityHeaders",
    ].map((field) => [field, Type.Optional(Type.Boolean())]),
  ),
  maxTokensField: Type.Optional(
    Type.Union([
      Type.Literal("max_completion_tokens"),
      Type.Literal("max_tokens"),
    ]),
  ),
  thinkingFormat: Type.Optional(
    Type.Union(
      (
        [
          "openai",
          "openrouter",
          "together",
          "baseten",
          "deepseek",
          "zai",
          "qwen",
          "chat-template",
          "qwen-chat-template",
          "string-thinking",
          "ant-ling",
        ] as const
      ).map((value) => Type.Literal(value)),
    ),
  ),
  sessionAffinityFormat: Type.Optional(
    Type.Union(
      (["openai", "openai-nosession", "openrouter"] as const).map((value) =>
        Type.Literal(value),
      ),
    ),
  ),
});
const request = object({
  temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
  maxTokens: Type.Optional(positive),
});
const modelFields = {
  name: Type.Optional(string),
  api: Type.Optional(string),
  baseUrl: Type.Optional(string),
  reasoning: Type.Optional(Type.Boolean()),
  thinkingLevelMap: Type.Optional(thinkingMap),
  input: Type.Optional(
    Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), {
      minItems: 1,
    }),
  ),
  cost: Type.Optional(rates),
  contextWindow: Type.Optional(positive),
  maxTokens: Type.Optional(positive),
  samplingParams: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  headersEnv: Type.Optional(headerEnvironment),
  compat: Type.Optional(compat),
  request: Type.Optional(request),
};
const modelSchema = object({ id: string, ...modelFields });
const overrideSchema = object(modelFields);
const providerSchema = object({
  name: Type.Optional(string),
  baseUrl: Type.Optional(string),
  api: Type.Optional(string),
  /** Inline credential, matching the Pi models.json format; auth.json stays the higher-priority store. */
  apiKey: Type.Optional(string),
  keyless: Type.Optional(Type.Boolean()),
  headersEnv: Type.Optional(headerEnvironment),
  compat: Type.Optional(compat),
  request: Type.Optional(request),
  models: Type.Optional(Type.Array(modelSchema)),
  modelOverrides: Type.Optional(Type.Record(Type.String(), overrideSchema)),
});
export const modelsSchema = object({
  providers: Type.Record(Type.String(), providerSchema),
});
export type ProviderConfig = Static<typeof providerSchema>;
export type ModelConfig = Static<typeof overrideSchema>;
