import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { configure, defineDoc, defineExtension, defineTask, InboxDoc, LiveDoc, ROOT_CONVERSATION_ID,
  type ConversationId, type Extension, type Harness, type TaskId, type TaskRuntime, type Tx } from "@earendil-works/pi-durable";
import { buildWikiCurationPrompt } from "../domain/wiki-curation";
import { backgroundAgent, type BackgroundSelection } from "./background";
import { collectMainChatBatch, rootHighWater } from "./chat-batch";
import { NO_AGENT_RESOURCES, setAgentResources } from "./agents/resources";
import { type CurationInput, type CurationCheckpoint, type CurationResult, type MemoryCurationState } from "./memory-curation";
import { HttpError } from "../http";
import { logWarn } from "../logging";

export const WIKI_CURATION_KIND = "piko.wiki-curation";
export const WikiCurationDoc = defineDoc<MemoryCurationState>({
  kind: WIKI_CURATION_KIND, version: 1, scope: "conversation", history: "latest", fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ initialized: false, cursor: 0, idleSince: null, activeTaskId: null, retryAfter: null }),
});

// Older paused documents dropped the task ID. The scheduler ran just one wiki task at a time
// and could not admit another once blocked. Use its immutable input, never today's high water.
async function recoverWikiBatch(tx: Tx) {
  const state = await tx.doc(WikiCurationDoc, ROOT_CONVERSATION_ID);
  if (state.blocked && !state.wikiBatch) {
    const task = state.activeTaskId !== null ? await tx.task(state.activeTaskId as TaskId) :
      (await tx.scanTasks({ kind: WIKI_CURATION_KIND, conversationId: ROOT_CONVERSATION_ID, order: "descending" }, 1)).items[0];
    const input = task?.input as CurationInput | undefined;
    if (task?.kind === WIKI_CURATION_KIND && task.conversationId === ROOT_CONVERSATION_ID && task.state.status === "terminal" &&
        task.state.outcome.status !== "completed" && input?.fromEntryId === state.cursor &&
        Number.isSafeInteger(input.throughEntryId) && input.throughEntryId > state.cursor && Number.isSafeInteger(input.requestedAt) && typeof input.timezone === "string") {
      // A pre-admission failure was retryable. Don't mistake it for a later, expired task.
      if (state.activeTaskId === task.id || task.state.outcome.status === "aborted" || (state.conversationId !== undefined &&
          await tx.submissionByRequest(state.conversationId as ConversationId, `piko:wiki-curation:${task.id}`)))
        state.wikiBatch = { ...input, taskId: Number(task.id) };
    }
  }
  return state;
}

export function wikiReviewRecovery(harness: Harness, bindings: () => ReadonlyMap<number, string>) {
  return {
    // Save any recoverable legacy range before the first retention sweep.
    initialize: () => harness.commit(async tx => { await recoverWikiBatch(tx); }, context),
    status: () => harness.commit(async tx => {
      const state = await recoverWikiBatch(tx);
      if (!state.blocked) return { blocked: false };
      const batch = state.wikiBatch;
      if (!batch || batch.fromEntryId !== state.cursor) {
        // Pin a separate, explicitly broader recovery choice. Never recompute its end on POST.
        if (!state.wikiBoundary || state.wikiBoundary.fromEntryId !== state.cursor) state.wikiBoundary = {
          fromEntryId: state.cursor, throughEntryId: Math.max(state.cursor, await rootHighWater(tx)), pinnedAt: Date.now(), token: crypto.randomUUID(),
        };
        return { blocked: true, batch: null, boundary: { ...state.wikiBoundary } };
      }
      const { messages } = await collectMainChatBatch(tx, { from: batch.fromEntryId, through: batch.throughEntryId,
        timezone: batch.timezone, now: batch.requestedAt, bindings: bindings() });
      return { blocked: true, batch: { ...batch }, messages };
    }, context),
    skip: ({ action, taskId, token, throughEntryId }: Record<string, unknown>) => harness.commit(async tx => {
      if (action !== 'skip' && action !== 'skip-through') throw new HttpError("Expected a skip acknowledgement.", 422);
      const state = await recoverWikiBatch(tx), batch = state.wikiBatch, boundary = state.wikiBoundary;
      const changed = () => new HttpError("The paused review changed. Refresh the wiki before continuing.", 409);
      if (!state.blocked) throw changed();
      let end: number;
      if (action === 'skip') {
        if (!batch || taskId !== batch.taskId || state.cursor !== batch.fromEntryId ||
            (state.activeTaskId !== null && state.activeTaskId !== taskId)) throw changed();
        end = batch.throughEntryId;
      } else {
        if (batch?.fromEntryId === state.cursor || !boundary || boundary.fromEntryId !== state.cursor ||
            token !== boundary.token || throughEntryId !== boundary.throughEntryId) throw changed();
        end = boundary.throughEntryId;
      }
      const id = state.activeTaskId ?? batch?.taskId;
      const task = id === undefined ? undefined : await tx.task(id as TaskId);
      if (task && task.state.status !== "terminal") throw new HttpError("The review is still stopping. Refresh before continuing.", 409);
      if (state.conversationId !== undefined) {
        const id = state.conversationId as ConversationId;
        if ((await tx.doc(LiveDoc, id)).run || (await tx.doc(InboxDoc, id)).items.some(item => item.mode !== "write"))
          throw new HttpError("The wiki writer is still active. Refresh after it stops.", 409);
      }
      state.cursor = end;
      state.blocked = false; state.activeTaskId = null; state.retryAfter = null; state.idleSince ??= Date.now();
      delete state.wikiBatch;
      delete state.wikiBoundary;
      // Don't put the unfinished instructions/tool history back in the next writer's context.
      delete state.conversationId;
      return { blocked: false };
    }, context),
  };
}

type Runtime = TaskRuntime<CurationInput, CurationCheckpoint, CurationResult, object>;
const INSTRUCTIONS = "Curate Hel-Pi's wiki from the assigned conversation. Use wiki_read for pages and memory references. Use wiki_write with the current revision to preserve human edits; if it reports a conflict, reread and merge.";

/** Approximate per-conversation policy; Durable triggers relative to the model window. */
export function wikiCompaction(window: number) {
  const reserve = Math.max(Math.min(8192, Math.floor(window / 4)), window - 90_000);
  return { enabled: true, reserveTokens: reserve, keepRecentTokens: Math.min(20_000, Math.floor(window / 4)),
    backgroundTokens: Math.min(10_000, Math.floor(window / 8)) };
}

export function createWikiCurationExtension(options: { workspace: string; bindings: () => ReadonlyMap<number, string>;
  background: () => Promise<BackgroundSelection | undefined>; coding: Extension }) {
  const stop = async (runtime: Runtime, record: { id: TaskId; input: CurationInput }, status: "failed" | "aborted", ctx: typeof context, uncertain = true) => {
    await runtime.commit(async tx => {
      const state = await tx.doc(WikiCurationDoc, ROOT_CONVERSATION_ID);
      if (state.activeTaskId === Number(record.id)) {
        state.activeTaskId = null;
        if (uncertain) {
          state.blocked = true; state.wikiBatch = { ...record.input, taskId: Number(record.id) };
        } else {
          delete state.wikiBatch; state.retryAfter = runtime.now() + 30 * 60_000;
        }
      }
      return status === "failed"
        ? { status: "terminal", outcome: { status: "failed", error: { message: "Wiki review stopped; its file writes may be incomplete." } } } as const
        : { status: "terminal", outcome: { status: "aborted", reason: "Wiki review interrupted; its file writes may be incomplete." } } as const;
    }, ctx);
    logWarn("wiki.curation.stopped");
  };
  const task = defineTask<CurationInput, CurationCheckpoint, CurationResult>({
    name: WIKI_CURATION_KIND, version: 1, initial: () => ({ phase: "curation" }),
    phases: { curation: async (record, runtime, ctx) => {
      let uncertain = false;
      try {
        let batch: Awaited<ReturnType<typeof collectMainChatBatch>> | undefined;
        await runtime.commit(async tx => { batch = await collectMainChatBatch(tx, { from: record.input.fromEntryId,
          through: record.input.throughEntryId, timezone: record.input.timezone, bindings: options.bindings(), now: record.input.requestedAt }); return undefined; }, ctx);
        if (batch?.messages.length) {
          const parent = await runtime.agent(ctx);
          const selection = await options.background();
          const model = backgroundAgent(selection, parent);
          if (!model.model) throw new Error("No model configured for Wiki review.");
          const resolved = runtime.models.getModel(model.model.provider, model.model.modelId);
          if (!resolved) throw new Error("Wiki review model is unavailable.");
          let childId: ConversationId | undefined;
          await runtime.commit(async tx => {
            const state = await tx.doc(WikiCurationDoc, ROOT_CONVERSATION_ID);
            let id = state.conversationId as ConversationId | undefined;
            if (id === undefined) {
              const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
              id = child.id;
              state.conversationId = Number(id);
              await setAgentResources(tx, id, NO_AGENT_RESOURCES);
            }
            await configure(tx, id, { ...model, model: model.model!, extensions: [options.coding],
              tools: options.coding.tools ?? [], modelTools: null, cwd: options.workspace, instructions: INSTRUCTIONS,
              compaction: wikiCompaction(resolved.contextWindow) });
            childId = id;
            return { status: "running", checkpoint: { phase: "curation", childId: Number(id) } } as const;
          }, ctx);
          const child = await runtime.conversation(childId!, ctx);
          if (!child) throw new Error("Wiki conversation unavailable.");
          uncertain = true; // Admission or any later file write may succeed even if its reply is lost.
          const submission = await child.submit({ type: "input", content: buildWikiCurationPrompt(batch.messages),
            requestId: `piko:wiki-curation:${record.id}`, whenBusy: "reject" }, ctx);
          const settled = await submission.wait(ctx);
          if (settled.status !== "done" || settled.type !== "input") throw new Error("Wiki review did not complete.");
        }
        await runtime.commit(async tx => {
          const state = await tx.doc(WikiCurationDoc, ROOT_CONVERSATION_ID);
          if (state.cursor !== record.input.fromEntryId) throw new Error("Wiki cursor changed.");
          state.cursor = record.input.throughEntryId;
          if (state.activeTaskId === Number(record.id)) state.activeTaskId = null;
          delete state.wikiBatch;
          return { status: "terminal", outcome: { status: "completed", result: { reviewedThrough: record.input.throughEntryId } } } as const;
        }, ctx);
      } catch {
        if (!runtime.signal.aborted) await stop(runtime, record, "failed", ctx, uncertain);
      }
    } },
    abort: async (record, runtime, ctx) => stop(runtime, record, "aborted", ctx),
  });
  return { task, extension: defineExtension({ name: "piko-wiki-curation", tasks: [task] }) };
}
