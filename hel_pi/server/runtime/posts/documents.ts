import { defineDoc, defineDocFamily, defineEntry, ROOT_CONVERSATION_ID, type ConversationId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import type { PostContent } from "../../../shared/posts";

export const POSTS_GENERATION_KIND = "piko.posts-generation";
export type PostPayload = PostContent & { createdAt: number; generationTaskId: number };
export const PublishedPost = defineEntry<PostPayload>("piko.post");
export const PostRequests = defineDocFamily<{ hash: string; taskId: number | null }, null>({
  kind: "piko.posts-request", version: 1, scope: "conversation", history: "latest", fork: "initial", family: true,
  checkpointWhen: () => false, initial: () => ({ hash: "", taskId: null }),
});
export const PostWorker = defineDoc<{ taskId: number | null }>({
  kind: "piko.posts-context", version: 1, scope: "conversation", history: "latest", fork: "initial",
  checkpointWhen: () => false, initial: () => ({ taskId: null }),
});

/** Host-assigned binding, not an agent-supplied session ID or prompt permission. */
export async function postHistoryScope(tx: Tx, conversationId: ConversationId) {
  const worker = await tx.doc(PostWorker, conversationId);
  if (worker.taskId === null) return undefined;
  const owner = await tx.task(worker.taskId as TaskId);
  const child = await tx.conversation(conversationId);
  if (!owner || owner.kind !== POSTS_GENERATION_KIND || owner.conversationId !== ROOT_CONVERSATION_ID ||
    owner.state.status === "terminal" || owner.abortRequested || child?.owner?.taskId !== owner.id) return undefined;
  return { conversationId: ROOT_CONVERSATION_ID };
}
