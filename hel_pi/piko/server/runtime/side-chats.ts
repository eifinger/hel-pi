import {
  defineDoc,
  defineDocFamily,
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type Cursor,
  type Tx,
} from "@earendil-works/pi-durable";
import type { SideChat } from "../../shared/side-chats";

export const SIDE_CHAT_INSTRUCTIONS =
  "This is an independent side chat. Share workspace guidance, memory and skills, but not the main chat transcript. Do not curate global memory or manage saved tasks. You may delegate independent background work; its results return only to this side chat, never to the main chat. Shared workspace tools are not a sandbox.";

/** Product metadata only. History, execution and submission identities stay native. */
export const SideChatDoc = defineDoc<{
  title: string;
  createdAt: number;
  archivedAt: number | null;
}>({
  kind: "piko.side-chat",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ title: "", createdAt: 0, archivedAt: null }),
});
export const SideChatCreates = defineDocFamily<
  { conversationId: number | null },
  null
>({
  kind: "piko.side-chat-creates",
  version: 1,
  scope: "session",
  family: true,
  checkpointWhen: () => false,
  initial: () => ({ conversationId: null }),
});
export class SideChatError extends Error {
  constructor(
    message: string,
    readonly status = 404,
  ) {
    super(message);
  }
}
export async function sideChats(tx: Tx): Promise<(SideChat & { archivedAt: number | null })[]> {
  const items: (SideChat & { archivedAt: number | null })[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanConversations({}, 200, cursor);
    for (const record of page.items) {
      if (record.id === ROOT_CONVERSATION_ID) continue;
      const metadata = await tx.doc(SideChatDoc, record.id);
      if (metadata.createdAt)
        items.push({ id: String(record.id), ...metadata });
    }
    cursor = page.next;
  } while (cursor);
  return items.sort(
    (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
  );
}
export async function requireSideChat(tx: Tx, value: string) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new SideChatError("Side chat not found.");
  const id = Number(value) as ConversationId;
  if (id === ROOT_CONVERSATION_ID || !(await tx.conversation(id)))
    throw new SideChatError("Side chat not found.");
  const metadata = await tx.doc(SideChatDoc, id);
  if (!metadata.createdAt) throw new SideChatError("Side chat not found.");
  return { id, metadata };
}
