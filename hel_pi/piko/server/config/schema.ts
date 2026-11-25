import { Type, type Static } from "typebox";

export const object = <T extends Record<string, import("typebox").TSchema>>(fields: T) =>
  Type.Object(fields, { additionalProperties: false });
const nonNegative = Type.Integer({ minimum: 0 });
const thinkingSchema = Type.Union([
  Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"),
  Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max"),
]);
const profileSchema = object({
  provider: Type.String({ minLength: 1 }),
  model: Type.String({ minLength: 1 }),
  thinking: Type.Optional(thinkingSchema),
});

/** Piko owns model presets, not Durable's retry or compaction policies. */
export const agentSchema = object({
  /** Fixed role slots: main is the global front-chat model, background runs delegated work. */
  profiles: object({
    main: Type.Optional(profileSchema),
    background: Type.Optional(profileSchema),
    backgroundThinking: Type.Optional(thinkingSchema),
  }),
  stream: Type.Optional(object({
    transport: Type.Optional(Type.Union([
      Type.Literal("sse"), Type.Literal("websocket"), Type.Literal("websocket-cached"), Type.Literal("auto"),
    ])),
    timeoutMs: Type.Optional(nonNegative),
    maxRetries: Type.Optional(nonNegative),
    maxRetryDelayMs: Type.Optional(nonNegative),
    cacheRetention: Type.Optional(Type.Union([
      Type.Literal("none"), Type.Literal("short"), Type.Literal("long"),
    ])),
  })),
});

export type AgentSettings = Static<typeof agentSchema>;
export type ModelProfile = Static<typeof profileSchema>;
