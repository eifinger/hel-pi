import { defineDocFamily, ROOT_CONVERSATION_ID, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import type { InputSource } from "./types";

// Provenance and control metadata only; native submissions/tasks remain the execution authority.
export const InputOrigin = defineDocFamily<{ registered: boolean; internal: boolean; source: InputSource; child?: ConversationId }, null>({
  kind: "piko.input-origin", version: 1, scope: "conversation", history: "latest", fork: "initial", family: true,
  checkpointWhen: () => false,
  initial: () => ({ registered: false, internal: false, source: { channel: "app" } }),
});
export async function registerInput(tx: Tx, requestId: string, source: InputSource, internal = false, child?: ConversationId, conversationId = ROOT_CONVERSATION_ID) {
  const origin = await tx.doc(InputOrigin, conversationId, requestId, null);
  if (origin.registered) {
    if (origin.internal !== internal) throw new Error("Input identity belongs to a different source.");
    return;
  }
  origin.registered = true; origin.internal = internal; origin.source = source; if (child !== undefined) origin.child = child;
}
export async function internalInput(tx: Tx, requestId?: string, conversationId = ROOT_CONVERSATION_ID) {
  return !!requestId && (await tx.doc(InputOrigin, conversationId, requestId, null)).internal;
}

