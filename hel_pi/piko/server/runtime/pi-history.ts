import type { Cursor, EntryId, EntryRecord, Session, Storage, ConversationId, Tx } from "@earendil-works/pi-durable";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { internalInput } from "./input-origin";
import { CHAT_PAGE_SIZE, type HistoryPage, type Message, type MessageAttachment } from "../../shared/chat";
import { detectExtension, isSnapshotId } from "../attachments/store";
import { PREVIEW_EXCERPT_MAX_CHARS } from "../domain/text-limits";
import { SentAttachmentEntry, sentAttachmentMessage } from "./sent-attachments";
import { WidgetEntry, widgetMessage } from "./widgets";

export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part): part is { type: "text"; text: string } =>
    part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
}

/** Full history, including entries before reset/compaction and context edits. */
export async function readPiEntries(session: Session, conversationId: ConversationId = ROOT_CONVERSATION_ID): Promise<EntryRecord[]> {
  return session.commit(tx => entriesFromTransaction(tx, conversationId), context);
}

export async function entriesFromTransaction(tx: Tx, conversationId = ROOT_CONVERSATION_ID): Promise<EntryRecord[]> {
  const entries: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId }, 500, cursor);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return entries.sort((a, b) => a.id - b.id);
}

export async function readPiInputs(session: Session, storage: Storage, conversationId = ROOT_CONVERSATION_ID): Promise<Map<number, string>> {
  return session.commit(() => inputsFromStorage(storage, conversationId), context);
}

/** Call on the native commit line so submission bindings and entries share a consistent read. */
export async function inputsFromStorage(storage: Storage, conversationId = ROOT_CONVERSATION_ID): Promise<Map<number, string>> {
  const bindings = new Map<number, string>(); let cursor: Cursor | undefined;
  do {
    const page = await storage.scanSubmissions({ conversationId }, 500, cursor, context);
    for (const record of page.items) if (record.type === "input" && record.requestId && record.entry !== undefined) bindings.set(record.entry, record.requestId);
    cursor = page.next;
  } while (cursor);
  return bindings;
}
/** Read only enough raw entries to fill a visible page plus one lookahead message.
 * Bounds use immutable entry IDs, so new writes cannot shift an older-page cursor.
 * Bindings are an in-memory projection of native submissions, never a second store.
 */
export async function historyPageFromTransaction(tx: Tx, inputs: ReadonlyMap<number, string>, before?: string, limit = CHAT_PAGE_SIZE, conversationId = ROOT_CONVERSATION_ID) {
  const entries: EntryRecord[] = [];
  const messages: Message[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId, order: "descending",
      ...(before && { maxEntryId: (Number(before) - 1) as EntryRecord["id"] }) }, 100, cursor);
    for (const entry of page.items) {
      entries.push(entry);
      if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant" && !SentAttachmentEntry.is(entry) && !WidgetEntry.is(entry)) continue;
      const requestId = inputs.get(entry.id);
      if (requestId && await internalInput(tx, requestId, conversationId)) continue;
      const projected = projectPiHistory([entry], requestId ? new Map([[entry.id, requestId]]) : undefined).messages;
      messages.push(...projected.reverse());
      if (messages.length > limit) break;
    }
    cursor = page.next;
  } while (cursor && messages.length <= limit);
  const selected = messages.slice(0, limit).reverse();
  const result: HistoryPage = { messages: selected,
    ...(messages.length > limit && { nextBefore: selected[0]!.id }) };
  return { ...result, entries };
}

/** Attachment paths are model input; the UI gets ids and served URLs instead of the raw block. */
const ATTACHED = /^<attached>\n([\s\S]*?)\n<\/attached>\n?/;
export function splitAttachments(content: string): { text: string; attachments?: MessageAttachment[] } {
  const match = ATTACHED.exec(content);
  if (!match) return { text: content };
  const attachments = match[1].split("\n").map(line => line.trim()).filter(Boolean).map(path => {
    const segments = path.split("/");
    const name = segments.at(-1)!;
    const parent = segments.at(-2);
    const id = parent && isSnapshotId(parent) ? `${parent}/${name}` : name;
    return { id, name, url: `/api/attachments/${encodeURIComponent(id)}`, mime: detectExtension(name) };
  });
  return { text: content.slice(match[0].length).trim(), ...(attachments.length && { attachments }) };
}

export function projectPiHistory(
  entries: readonly EntryRecord[],
  inputs: ReadonlyMap<number, string> = new Map<number, string>(),
  hidden: ReadonlySet<number> = new Set<number>(),
) {
  const messages: Message[] = [];
  for (const entry of entries) {
    if (hidden.has(entry.id)) continue;
    if (WidgetEntry.is(entry)) {
      messages.push(widgetMessage(entry.id, entry.data));
    } else if (SentAttachmentEntry.is(entry)) {
      messages.push(sentAttachmentMessage(entry.id, entry.data));
    } else if (entry.kind === "pi.user" || entry.kind === "pi.assistant") {
      for (const message of entry.model ?? []) {
        if (message.role !== "user" && message.role !== "assistant") continue;
        const raw = messageText(message.content);
        const { text, attachments } = message.role === "user" ? splitAttachments(raw) : { text: raw };
        const requestId = message.role === "user" ? inputs.get(entry.id) : undefined;
        if (text.trim() || attachments?.length) messages.push({ id: String(entry.id), role: message.role, content: text,
          createdAt: message.timestamp, ...(requestId && { requestId }), ...(attachments && { attachments }) });
      }
    }
  }
  return { messages };
}

export type SessionSearchHit = {
  messageId: string;
  role: Message["role"];
  timestamp: number;
  snippet: string;
};

export type SessionHistoryWindow = {
  messages: Pick<Message, "id" | "role" | "content" | "createdAt">[];
  messagesBefore: number;
  messagesAfter: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
};

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function searchSnippet(content: string, terms: readonly string[], limit = PREVIEW_EXCERPT_MAX_CHARS): string {
  const flattened = content.replace(/\s+/g, " ").trim();
  const normalized = normalizeSearchText(flattened);
  const matchAt = Math.min(...terms.map(term => normalized.indexOf(term)).filter(index => index >= 0));
  const points = Array.from(flattened);
  if (!Number.isFinite(matchAt))
    return points.length > limit ? `${points.slice(0, Math.max(0, limit - 1)).join("")}…` : flattened;
  const codePointAt = Array.from(normalized.slice(0, matchAt)).length;
  const contentLimit = Math.max(0, limit - 2);
  const start = Math.max(0, codePointAt - Math.floor(contentLimit / 3));
  const end = Math.min(points.length, start + contentLimit);
  return `${start ? "…" : ""}${points.slice(start, end).join("")}${end < points.length ? "…" : ""}`;
}

async function internalEntries(
  tx: Tx,
  inputs: ReadonlyMap<number, string>,
  conversationId: ConversationId,
): Promise<Set<number>> {
  const hidden = new Set<number>();
  for (const [entryId, requestId] of inputs) {
    if (!await internalInput(tx, requestId, conversationId)) continue;
    hidden.add(entryId);
  }
  return hidden;
}

function visibleEntryMessages(entry: EntryRecord, hidden: ReadonlySet<number>, inputs: ReadonlyMap<number, string>): Message[] {
  if (hidden.has(entry.id) || (entry.kind !== "pi.user" && entry.kind !== "pi.assistant" && !SentAttachmentEntry.is(entry) && !WidgetEntry.is(entry))) return [];
  return projectPiHistory([entry], inputs).messages;
}

/** Search the visible transcript projection directly from native entries; no message index or copy is persisted. */
export async function searchPiHistory(
  tx: Tx,
  inputs: ReadonlyMap<number, string>,
  rawQuery: string,
  limit: number,
  conversationId = ROOT_CONVERSATION_ID,
): Promise<{ results: SessionSearchHit[]; truncated: boolean }> {
  const query = normalizeSearchText(rawQuery);
  const terms = [...new Set(query.split(" ").filter(Boolean))];
  if (!terms.length) return { results: [], truncated: false };

  const candidates: { hit: SessionSearchHit; matchedTerms: number }[] = [];
  const hidden = await internalEntries(tx, inputs, conversationId);
  let matches = 0;
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId, order: "descending" }, 100, cursor);
    for (const entry of page.items) {
      const messages = visibleEntryMessages(entry, hidden, inputs).reverse();
      for (const message of messages) {
        const text = normalizeSearchText(message.content);
        if (!text) continue;
        const matchedTerms = terms.filter(term => text.includes(term));
        if (!matchedTerms.length) continue;
        matches++;
        candidates.push({ hit: { messageId: message.id, role: message.role, timestamp: message.createdAt,
          snippet: searchSnippet(message.content, matchedTerms) }, matchedTerms: matchedTerms.length });
        candidates.sort((a, b) => b.matchedTerms - a.matchedTerms || b.hit.timestamp - a.hit.timestamp ||
          Number(b.hit.messageId) - Number(a.hit.messageId));
        if (candidates.length > limit) candidates.pop();
      }
    }
    cursor = page.next;
  } while (cursor);
  return { results: candidates.map(candidate => candidate.hit), truncated: matches > limit };
}

/** Read a bounded window around a visible message anchor from the native transcript. */
export async function historyAroundPiMessage(
  tx: Tx,
  inputs: ReadonlyMap<number, string>,
  messageId: string,
  limit: number,
  conversationId = ROOT_CONVERSATION_ID,
): Promise<SessionHistoryWindow | undefined> {
  const match = /^([1-9]\d*)$/.exec(messageId);
  const entryId = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(entryId)) return undefined;

  const anchorEntry = await tx.entry(entryId as EntryRecord["id"]);
  if (!anchorEntry || anchorEntry.conversationId !== conversationId) return undefined;
  const hidden = await internalEntries(tx, inputs, conversationId);
  const anchorMessages = visibleEntryMessages(anchorEntry, hidden, inputs);
  const anchorIndex = anchorMessages.findIndex(message => message.id === messageId);
  if (anchorIndex < 0) return undefined;
  const windowSize = Math.max(1, limit);
  const targetBefore = Math.floor((windowSize - 1) / 2);
  const targetAfter = windowSize - 1 - targetBefore;
  const before: Message[] = anchorMessages.slice(0, anchorIndex).reverse();
  const after: Message[] = anchorMessages.slice(anchorIndex + 1);
  const collectAdjacent = async (side: "before" | "after") => {
    let cursor: Cursor | undefined;
    let hasMore = false;
    do {
      const page = await tx.scanEntries({
        conversationId,
        ...(side === "before"
          ? { maxEntryId: (entryId - 1) as EntryRecord["id"], order: "descending" as const }
          : { minEntryId: (entryId + 1) as EntryRecord["id"], order: "ascending" as const }),
      }, 100, cursor);
      for (const entry of page.items) {
        const projected = visibleEntryMessages(entry, hidden, inputs);
        const ordered = side === "before" ? projected.reverse() : projected;
        (side === "before" ? before : after).push(...ordered);
        if ((side === "before" ? before : after).length > windowSize) {
          hasMore = true;
          break;
        }
      }
      if (hasMore) break;
      cursor = page.next;
    } while (cursor);
    return hasMore;
  };
  const hasMoreBefore = entryId > 1 ? await collectAdjacent("before") : false;
  const hasMoreAfter = await collectAdjacent("after");

  let countBefore = Math.min(targetBefore, before.length);
  let countAfter = Math.min(targetAfter, after.length);
  let remaining = windowSize - 1 - countBefore - countAfter;
  while (remaining > 0 && (countBefore < before.length || countAfter < after.length)) {
    if (countBefore < before.length) countBefore++;
    else if (countAfter < after.length) countAfter++;
    remaining--;
  }
  const selectedMessages = [
    ...before.slice(0, countBefore).reverse(),
    anchorMessages[anchorIndex]!,
    ...after.slice(0, countAfter),
  ];
  const selected = selectedMessages.map(({ id, role, content, createdAt }) => ({
    id,
    role,
    content,
    createdAt,
  }));
  return { messages: selected, messagesBefore: countBefore, messagesAfter: countAfter,
    hasMoreBefore: hasMoreBefore || before.length > countBefore,
    hasMoreAfter: hasMoreAfter || after.length > countAfter };
}
