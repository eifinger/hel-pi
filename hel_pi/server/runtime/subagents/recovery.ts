import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  InboxDoc,
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type Harness,
} from "@earendil-works/pi-durable";
import {
  REPORTER_KIND,
  type ReporterInput,
  type ReporterState,
} from "./documents";
import { subagentIds } from "./queries";
import { Recovery } from "../conversation-docs";
import { POSTS_GENERATION_KIND } from "../posts/documents";

/** Mark inherited uncertain work before enabling the scheduler; report and retry phases may resume. */
export async function prepareRestart(
  harness: Harness,
  userConversations: ConversationId[] = [ROOT_CONVERSATION_ID],
) {
  const inspection = await harness.inspect(context);
  const preserved = inspection.tasks
    .filter(
      (item) =>
        item.record.kind === REPORTER_KIND &&
        !item.record.abortRequested &&
        (item.record.state.status === "pending" ||
          item.record.state.status === "running" ||
          item.record.state.status === "sleeping") &&
        ((item.record.state.checkpoint as ReporterState).phase === "report" ||
          (item.record.state.checkpoint as ReporterState).phase === "retry"),
    )
    .map((item) => item.record.id);
  const interruptedChildren: ConversationId[] = [];
  const conversations = await harness.commit(async (tx) => {
    const children = (
      await Promise.all(userConversations.map((id) => subagentIds(tx, id)))
    ).flat();
    const postChildren = inspection.tasks.flatMap(item => {
      const state = item.record.state;
      const childId = "checkpoint" in state ? (state.checkpoint as { childId?: number } | undefined)?.childId : undefined;
      return item.record.kind === POSTS_GENERATION_KIND && state.status !== "terminal" && typeof childId === "number"
        ? [childId as ConversationId] : [];
    });
    const ids = [...new Set([...userConversations, ...children, ...postChildren])];
    for (const item of inspection.tasks) {
      if (
        item.record.kind === REPORTER_KIND &&
        !preserved.includes(item.record.id) &&
        item.record.state.status !== "terminal" &&
        (item.record.state.checkpoint as ReporterState).phase === "deliver"
      ) {
        const child = (item.record.input as ReporterInput).child;
        interruptedChildren.push(child);
        (await tx.doc(Recovery, child)).interruption = "The previous work was interrupted by a server restart. Please resend if needed.";
      }
    }
    for (const id of ids) {
      const inbox = await tx.doc(InboxDoc, id);
      for (const item of inbox.items)
        if (item.mode !== "write")
          tx.settleSubmission(item.id, {
            status: "unanswered",
            reason: "aborted",
          });
      inbox.items = inbox.items.filter((item) => item.mode === "write");
    }
    return ids;
  }, context);
  for (const item of inspection.tasks)
    if (!preserved.includes(item.record.id))
      await harness.abortTask(item.record.id, context);
  return {
    interrupted: inspection.tasks.some(
      (item) => !preserved.includes(item.record.id),
    ),
    conversations,
    interruptedChildren,
    interruptedIds: [
      ...new Set(
        inspection.tasks
          .filter((item) => !preserved.includes(item.record.id) && item.record.kind !== POSTS_GENERATION_KIND)
          .map((item) => item.record.conversationId),
      ),
    ],
  };
}
