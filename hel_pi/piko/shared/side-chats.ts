/** IDs are native conversation IDs, opaque outside the runtime adapter. */
export type SideChat = { id: string; title: string; createdAt: number };
export const DEFAULT_SIDE_CHAT_TITLE = "新旁聊";
export type CreateSideChat = { requestId: string };
export type GenerateSideChatTitle = { requestIds?: string[]; onlyIfEmpty?: boolean };
export const SIDE_CHAT_TITLE_LIMIT = 100;
export function chatPath(conversationId?: string): string {
  return conversationId ? `/api/side-chats/${encodeURIComponent(conversationId)}/chat` : "/api/chat";
}
