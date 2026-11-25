import type { ConversationActivity, StreamEvent } from "./chat";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isConversationActivity(value: unknown): value is ConversationActivity {
  return record(value) && (value.kind === "idle" || value.kind === "thinking" || value.kind === "replying" ||
    value.kind === "tool" && typeof value.name === "string");
}

/** Compile-time coverage couples every public event kind to its wire validator. */
const validators = {
  snapshot: value => record(value.conversation) && Array.isArray(value.conversation.messages) &&
    typeof value.conversation.busy === "boolean" && isConversationActivity(value.conversation.activity),
  message: value => record(value.message) && typeof value.message.id === "string" &&
    (value.message.role === "user" || value.message.role === "assistant") &&
    typeof value.message.content === "string" && typeof value.final === "boolean" &&
    (value.message.widget === undefined || record(value.message.widget) && value.message.widget.version === 1 &&
      typeof value.message.widget.html === "string" && value.message.widget.html.length <= 32768) &&
    (value.previousId === undefined || typeof value.previousId === "string"),
  "run-end": value => Array.isArray(value.submissions) && value.submissions.every(item =>
    record(item) && typeof item.id === "string" &&
    (item.requestId === undefined || typeof item.requestId === "string") &&
    (item.status === "queued" || item.status === "placed" || item.status === "done" || item.status === "unanswered") &&
    (item.error === undefined || typeof item.error === "string")),
  activity: value => isConversationActivity(value.activity),
  error: value => typeof value.message === "string",
  deleted: () => true,
} satisfies Record<StreamEvent["type"], (value: Record<string, unknown>) => boolean>;

export function decodeConversationEvent(value: unknown): StreamEvent | undefined {
  if (!record(value) || typeof value.type !== "string" || !Object.hasOwn(validators, value.type)) return undefined;
  const validate = validators[value.type as keyof typeof validators];
  if (!validate(value)) throw new Error(`Invalid conversation event: ${value.type}`);
  return value as StreamEvent;
}
