import { ROOT_CONVERSATION_ID, type Cursor, type EntryId, type EntryRecord, type Tx } from "@earendil-works/pi-durable";
import { CHAT_BATCH_MAX_INPUT_CHARS, localDate, type ChatBatchMessage } from "../domain/chat-batch";
import { internalInput } from "./input-origin";
import { messageText } from "./pi-history";
import { codePointLength } from "../text";

export type CollectedBatch = { messages: ChatBatchMessage[]; userMessageCount: number; throughEntryId: number; budgetReached: boolean };

/** Newest entry ID of the root conversation; background work uses it as a high-water cursor. */
export async function rootHighWater(tx: Tx): Promise<number> {
  const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "descending" }, 1);
  return page.items[0]?.id ?? 0;
}

/** Collect user-visible root chat text. Exclude explicitly internal background-result inputs, but retain the main assistant's visible replies. */
export async function collectMainChatBatch(tx: Tx, input: {
  from: number; through: number; timezone: string; bindings: ReadonlyMap<number, string>; now: number;
}): Promise<CollectedBatch> {
  const { from, through, timezone, bindings, now } = input;
  const entries: EntryRecord[] = []; let cursor: Cursor | undefined;
  if (through > from) do {
    const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, minEntryId: (from + 1) as EntryId,
      maxEntryId: through as EntryId, order: "ascending" }, 500, cursor);
    entries.push(...page.items); cursor = page.next;
  } while (cursor);

  const internalUsers = new Set<number>();
  for (const entry of entries) {
    if (entry.kind !== "pi.user") continue;
    const requestId = bindings.get(entry.id);
    if (!await internalInput(tx, requestId)) continue;
    internalUsers.add(entry.id);
  }

  const messages: ChatBatchMessage[] = []; let userMessageCount = 0; let chars = 0; let processed = from; let budgetReached = false;
  for (const entry of entries) {
    if ((entry.kind !== "pi.user" && entry.kind !== "pi.assistant") || internalUsers.has(entry.id)) {
      processed = entry.id; continue;
    }
    const parts = (entry.model ?? []).filter(message => message.role === "user" || message.role === "assistant")
      .map(message => ({ timestamp: typeof message.timestamp === "number" ? message.timestamp : now,
        content: messageText(message.content).trim() }))
      .filter(message => message.content.length > 0);
    if (!parts.length) { processed = entry.id; continue; }
    const role = entry.kind === "pi.user" ? "user" : "assistant";
    const cost = parts.reduce((sum, part) => sum + codePointLength(part.content), 0);
    if (messages.length && chars + cost > CHAT_BATCH_MAX_INPUT_CHARS) { budgetReached = true; break; }
    if (role === "user") userMessageCount++;
    for (const part of parts)
      messages.push({ role, date: localDate(part.timestamp, timezone), content: part.content });
    chars += cost;
    processed = entry.id;
    if (chars >= CHAT_BATCH_MAX_INPUT_CHARS) { budgetReached = true; break; }
  }
  return { messages, userMessageCount, throughEntryId: Math.max(from, processed), budgetReached };
}
