import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { configure, defineDoc, defineExtension, defineTask, ROOT_CONVERSATION_ID,
  type ConversationId, type TaskRuntime } from "@earendil-works/pi-durable";
import { buildWikiCurationPrompt } from "../domain/wiki-curation";
import { backgroundAgent, type BackgroundSelection } from "./background";
import { collectMainChatBatch } from "./chat-batch";
import type { CodingExtension } from "./coding-tools";
import { NO_AGENT_RESOURCES, setAgentResources } from "./agents/resources";
import { type CurationInput, type CurationCheckpoint, type CurationResult, type MemoryCurationState } from "./memory-curation";
import { logWarn } from "../logging";

export const WIKI_CURATION_KIND = "piko.wiki-curation";
export const WikiCurationDoc = defineDoc<MemoryCurationState>({
  kind: WIKI_CURATION_KIND, version: 1, scope: "conversation", history: "latest", fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ initialized: false, cursor: 0, idleSince: null, activeTaskId: null, retryAfter: null }),
});
type Runtime = TaskRuntime<CurationInput, CurationCheckpoint, CurationResult, object>;
const INSTRUCTIONS = "You are Piko's Wiki curator. Organize the assigned conversation into the workspace wiki/. Read existing pages before updates. Only edit wiki/; the workspace is not a security sandbox.";

/** Approximate per-conversation policy; Durable triggers relative to the model window. */
export function wikiCompaction(window: number) {
  const reserve = Math.max(Math.min(8192, Math.floor(window / 4)), window - 90_000);
  return { enabled: true, reserveTokens: reserve, keepRecentTokens: Math.min(20_000, Math.floor(window / 4)),
    backgroundTokens: Math.min(10_000, Math.floor(window / 8)) };
}

export function createWikiCurationExtension(options: { workspace: string; bindings: () => ReadonlyMap<number, string>;
  background: () => Promise<BackgroundSelection | undefined>; coding: CodingExtension }) {
  const stop = async (runtime: Runtime, id: number, status: "failed" | "aborted", ctx: typeof context, uncertain = true) => {
    await runtime.commit(async tx => {
      const state = await tx.doc(WikiCurationDoc, ROOT_CONVERSATION_ID);
      if (state.activeTaskId === id) {
        state.activeTaskId = null;
        if (uncertain) state.blocked = true;
        else state.retryAfter = runtime.now() + 30 * 60_000;
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
          await mkdir(join(options.workspace, "wiki"), { recursive: true });
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
          return { status: "terminal", outcome: { status: "completed", result: { reviewedThrough: record.input.throughEntryId } } } as const;
        }, ctx);
      } catch {
        if (!runtime.signal.aborted) await stop(runtime, Number(record.id), "failed", ctx, uncertain);
      }
    } },
    abort: async (record, runtime, ctx) => stop(runtime, Number(record.id), "aborted", ctx),
  });
  return { task, extension: defineExtension({ name: "piko-wiki-curation", tasks: [task] }) };
}
