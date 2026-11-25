import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defineDoc, defineExtension, defineTask, InboxDoc, LiveDoc, ROOT_CONVERSATION_ID,
  type ConversationId, type Harness, type TaskId, type TaskRuntime } from "@earendil-works/pi-durable";
import { backgroundAgent, type BackgroundSelection } from "./background";
import { createChildAgent } from "./agents/create";
import { NO_AGENT_RESOURCES } from "./agents/resources";
import { collectMainChatBatch, rootHighWater } from "./chat-batch";
import { buildMemoryCurationPrompt } from "../domain/memory-curation";
import { curatorTools, type CodingExtension } from "./coding-tools";
import { logWarn } from "../logging";
import { codePointLength } from "../text";

export const MEMORY_CURATION_KIND = "piko.memory-curation";
export const MEMORY_CURATION_IDLE_MS = 30 * 60_000;
export const MEMORY_CURATION_MIN_USER_MESSAGES = 3;
export function memoryCurationIsDue(idleSince: number | null, now: number, busy: boolean, retryAfter: number | null): boolean {
  return !busy && idleSince !== null && now - idleSince >= MEMORY_CURATION_IDLE_MS && (retryAfter === null || now >= retryAfter);
}
const MEMORY_CURATION_POLL_MS = 15_000;
const MEMORY_CURATION_RETRY_MS = 30 * 60_000;
const CURATOR_AGENT_INSTRUCTIONS = "You are Piko's memory curator. Read AGENTS.md as read-only guidance for deduplication. Edit only MEMORY.md and the dated memory files identified by your task with the read/write/edit tools; never edit AGENTS.md. Verify tool results before reporting changes. The workspace is not a security sandbox.";
export type MemoryCurationState = {
  initialized: boolean;
  cursor: number;
  idleSince: number | null;
  activeTaskId: number | null;
  retryAfter: number | null;
  /** A separate worker may pause after an uncertain file-writing execution. */
  blocked?: boolean;
  conversationId?: number;
};
export const MemoryCurationDoc = defineDoc<MemoryCurationState>({
  kind: MEMORY_CURATION_KIND, version: 1, scope: "conversation", history: "latest", fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ initialized: false, cursor: 0, idleSince: null, activeTaskId: null, retryAfter: null }),
});

export type CurationInput = { fromEntryId: number; throughEntryId: number; timezone: string; requestedAt: number };
export type CurationCheckpoint = { phase: "curation"; childId?: number };
export type CurationResult = { reviewedThrough: number };
export type CurationTask = ReturnType<typeof createCurationTask>;
type Runtime = TaskRuntime<CurationInput, CurationCheckpoint, CurationResult, object>;
function safeError(): string { return "Memory review failed; it can be retried."; }

function createCurationTask(workspace: string, bindings: () => ReadonlyMap<number, string>,
  background: () => Promise<BackgroundSelection | undefined>, coding: CodingExtension) {
  const fail = async (taskId: TaskId<CurationResult>, runtime: Runtime, ctx: typeof context) => {
    await runtime.commit(async tx => {
      const state = await tx.doc(MemoryCurationDoc, ROOT_CONVERSATION_ID);
      if (state.activeTaskId === Number(taskId)) { state.activeTaskId = null; state.retryAfter = runtime.now() + MEMORY_CURATION_RETRY_MS; }
      return { status: "terminal", outcome: { status: "failed", error: { message: safeError() } } } as const;
    }, ctx);
  };
  const completeWithoutModel = async (task: { id: TaskId<CurationResult>; input: CurationInput }, runtime: Runtime, ctx: typeof context) => {
    await runtime.commit(async tx => {
      const state = await tx.doc(MemoryCurationDoc, ROOT_CONVERSATION_ID);
      if (state.cursor === task.input.fromEntryId) state.cursor = task.input.throughEntryId;
      if (state.activeTaskId === Number(task.id)) state.activeTaskId = null;
      state.retryAfter = null;
      return { status: "terminal", outcome: { status: "completed", result: { reviewedThrough: task.input.throughEntryId } } } as const;
    }, ctx);
  };

  return defineTask<CurationInput, CurationCheckpoint, CurationResult>({
    name: MEMORY_CURATION_KIND, version: 1, initial: () => ({ phase: "curation" }),
    phases: {
      curation: async (taskRecord, runtime, ctx) => {
        try {
          let collected: Awaited<ReturnType<typeof collectMainChatBatch>> | undefined;
          await runtime.commit(async tx => { collected = await collectMainChatBatch(tx, { from: taskRecord.input.fromEntryId,
            through: taskRecord.input.throughEntryId, timezone: taskRecord.input.timezone, bindings: bindings(), now: taskRecord.input.requestedAt }); return undefined; }, ctx);
          if (!collected?.messages.length) { await completeWithoutModel(taskRecord, runtime, ctx); return; }
          const agent = await runtime.agent(ctx);
          const selection = await background();
          if (!agent.model && !selection) throw new Error("No model is configured for memory review.");

          let childId = taskRecord.state.checkpoint.childId as ConversationId | undefined;
          if (childId === undefined) {
            await runtime.commit(async tx => {
              const model = backgroundAgent(selection, agent);
              childId = await createChildAgent(tx, taskRecord.id, {
                agent: { ...model, model: model.model ?? null, extensions: [coding], tools: curatorTools(coding),
                  cwd: workspace, instructions: CURATOR_AGENT_INSTRUCTIONS },
                resources: NO_AGENT_RESOURCES,
              });
              return { status: "running", checkpoint: { phase: "curation", childId: Number(childId) } } as const;
            }, ctx);
          }
          const child = await runtime.conversation(childId!, ctx);
          if (!child) throw new Error("Memory review conversation is unavailable.");
          const memoryCharacters = await readFile(join(workspace, "MEMORY.md"), "utf8").then(codePointLength).catch(() => 0);
          const prompt = buildMemoryCurationPrompt(collected!.messages, { characters: memoryCharacters });
          const submission = await child.submit({ type: "input", content: prompt, requestId: `piko:memory-curation:${taskRecord.id}`, whenBusy: "reject" }, ctx);
          const settled = await submission.wait(ctx);
          if (settled.status !== "done" || settled.type !== "input") throw new Error("Memory review generation did not complete.");
          await runtime.commit(async tx => {
            const state = await tx.doc(MemoryCurationDoc, ROOT_CONVERSATION_ID);
            if (state.cursor !== taskRecord.input.fromEntryId) throw new Error("Memory review cursor changed before commit.");
            state.cursor = taskRecord.input.throughEntryId;
            if (state.activeTaskId === Number(taskRecord.id)) state.activeTaskId = null;
            state.retryAfter = null;
            return { status: "terminal", outcome: { status: "completed", result: { reviewedThrough: taskRecord.input.throughEntryId } } } as const;
          }, ctx);
        } catch {
          if (runtime.signal.aborted) return;
          await fail(taskRecord.id, runtime, ctx);
        }
      },
    },
    abort: async (taskRecord, runtime, ctx) => {
      await runtime.commit(async tx => {
        const state = await tx.doc(MemoryCurationDoc, ROOT_CONVERSATION_ID);
        if (state.activeTaskId === Number(taskRecord.id)) {
          state.activeTaskId = null;
          state.retryAfter = runtime.now() + MEMORY_CURATION_RETRY_MS;
        }
        return { status: "terminal", outcome: { status: "aborted", reason: "Memory review interrupted." } } as const;
      }, ctx);
    },
  });
}

export class MemoryCurationService {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<"started" | "nothing-new">;
  private closing = false;
  private readonly timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  constructor(private readonly harness: Harness, private readonly task: CurationTask, private readonly bindings: () => ReadonlyMap<number, string>,
    private readonly now = Date.now, private readonly document: typeof MemoryCurationDoc = MemoryCurationDoc) {}

  async start(): Promise<void> {
    await this.harness.commit(async tx => {
      const state = await tx.doc(this.document, ROOT_CONVERSATION_ID);
      const highWater = await rootHighWater(tx);
      const live = await tx.doc(LiveDoc, ROOT_CONVERSATION_ID);
      const inbox = await tx.doc(InboxDoc, ROOT_CONVERSATION_ID);
      const busy = !!live.run || inbox.items.some(item => item.mode !== "write");
      if (!state.initialized) {
        state.initialized = true;
        state.cursor = highWater; // Deliberately do not backfill history from before memory review was enabled.
        state.idleSince = null;
      } else if (!busy && state.idleSince === null && highWater > state.cursor) state.idleSince = this.now();
      if (state.activeTaskId !== null) {
        const active = await tx.task(state.activeTaskId as TaskId);
        if (!active || active.state.status === "terminal") {
          // A reusable file-writing worker may have stopped without recording a safe outcome.
          if (this.document !== MemoryCurationDoc) state.blocked = true;
          state.activeTaskId = null;
        }
      }
    }, context);
    if (!this.timer) {
      this.timer = setInterval(() => { void this.tick().catch(() => this.log()); }, MEMORY_CURATION_POLL_MS);
      this.timer.unref();
    }
  }

  close(): void { this.closing = true; clearInterval(this.timer); this.timer = undefined; }

  async onRunStart(): Promise<void> {
    await this.harness.commit(async tx => { (await tx.doc(this.document, ROOT_CONVERSATION_ID)).idleSince = null; }, context);
  }
  async onRunEnd(): Promise<void> {
    await this.harness.commit(async tx => {
      const state = await tx.doc(this.document, ROOT_CONVERSATION_ID);
      state.idleSince = this.now(); state.retryAfter = null;
    }, context);
  }

  private log(): void {
    logWarn("memory.curation.failed");
  }

  tick(): Promise<"started" | "nothing-new"> { return this.drive(); }

  private drive(): Promise<"started" | "nothing-new"> {
    if (this.closing) return Promise.resolve("nothing-new");
    if (this.pending) return this.pending;
    this.pending = this.schedule().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async schedule(): Promise<"started" | "nothing-new"> {
    const snapshot = await this.harness.commit(async tx => {
      const state = await tx.doc(this.document, ROOT_CONVERSATION_ID);
      if (!state.initialized || state.blocked) return undefined;
      if (state.activeTaskId !== null) {
        const active = await tx.task(state.activeTaskId as TaskId);
        if (active && active.state.status !== "terminal") return { kind: "active" as const };
        if (this.document !== MemoryCurationDoc) { state.blocked = true; return undefined; }
        state.activeTaskId = null;
      }
      const live = await tx.doc(LiveDoc, ROOT_CONVERSATION_ID);
      const inbox = await tx.doc(InboxDoc, ROOT_CONVERSATION_ID);
      const busy = !!live.run || inbox.items.some(item => item.mode !== "write");
      if (!memoryCurationIsDue(state.idleSince, this.now(), busy, state.retryAfter)) {
        if (busy) state.idleSince = null;
        return undefined;
      }
      const highWater = await rootHighWater(tx) || state.cursor;
      if (highWater <= state.cursor) { state.retryAfter = null; return undefined; }
      const batch = await collectMainChatBatch(tx, { from: state.cursor, through: highWater, timezone: this.timezone, bindings: this.bindings(), now: this.now() });
      if (!batch.messages.length) {
        state.cursor = highWater;
        state.retryAfter = null;
        return { kind: "empty" as const };
      }
      if (batch.userMessageCount < MEMORY_CURATION_MIN_USER_MESSAGES && !batch.budgetReached) {
        // Accumulate short exchanges until the threshold or batch boundary; keep the cursor while below threshold.
        state.idleSince = null;
        state.retryAfter = null;
        return { kind: "below-threshold" as const };
      }
      return { kind: "batch" as const, fromEntryId: state.cursor, throughEntryId: batch.throughEntryId, highWater };
    }, context);
    if (!snapshot || snapshot.kind === "active" || snapshot.kind === "empty" || snapshot.kind === "below-threshold") return "nothing-new";

    let result: number | undefined;
    await this.harness.commit(async tx => {
      const state = await tx.doc(this.document, ROOT_CONVERSATION_ID);
      if (state.blocked || state.activeTaskId !== null || state.cursor !== snapshot.fromEntryId) return;
      const live = await tx.doc(LiveDoc, ROOT_CONVERSATION_ID);
      const inbox = await tx.doc(InboxDoc, ROOT_CONVERSATION_ID);
      const busy = !!live.run || inbox.items.some(item => item.mode !== "write");
      if (!memoryCurationIsDue(state.idleSince, this.now(), busy, state.retryAfter)) return;
      if ((await rootHighWater(tx)) > snapshot.highWater) return;
      const id = await tx.createTask(this.task, { fromEntryId: snapshot.fromEntryId, throughEntryId: snapshot.throughEntryId,
        timezone: this.timezone, requestedAt: this.now() },
      { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID, background: true });
      result = Number(id); state.activeTaskId = Number(id); state.retryAfter = null;
    }, context);
    return result === undefined ? "nothing-new" : "started";
  }
}

export function createMemoryCurationExtension(options: { workspace: string; bindings: () => ReadonlyMap<number, string>;
  background: () => Promise<BackgroundSelection | undefined>; coding: CodingExtension }) {
  const task = createCurationTask(options.workspace, options.bindings, options.background, options.coding);
  return { task, extension: defineExtension({ name: "piko-memory-curation", tasks: [task] }) };
}
