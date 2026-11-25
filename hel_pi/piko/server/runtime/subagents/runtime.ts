import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  defineExtension,
  defineTask,
  InboxDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type SubmissionId,
  type Storage,
  type ToolExecutionApi,
  type Tx,
} from "@earendil-works/pi-durable";
import type { BackgroundReply, InputSource } from "../types";
import { InputOrigin, registerInput } from "../input-origin";
import { entriesFromTransaction, messageText } from "../pi-history";
import { createChildAgent, type ChildAgentSpec } from "../agents/create";
import { Recovery } from "../conversation-docs";
import { backgroundIsDeleting } from "../storage-deletion";
import {
  JobControl,
  BackgroundJob,
  type BackgroundJobPolicy,
  ANCHOR_KIND,
  REPORTER_KIND,
  type ReporterInput,
  type ReporterState,
  type ReporterResult,
} from "./documents";

export type SubagentRuntime = ReturnType<typeof createSubagentRuntime>;

export function createSubagentRuntime(options: {
  storage: () => Storage;
  /** Application preflight; shared execution does not know the caller's filesystem or business metadata. */
  prepareInput?: (child: ConversationId, ctx: typeof context) => Promise<void>;
  acceptReport: (
    conversationId: ConversationId,
    operation: () => Promise<void>,
  ) => Promise<boolean>;
  onReply: (reply: BackgroundReply) => Promise<void>;
}) {
  // Serialize report admission with explicit cancellation; body/state stays native.
  let admission: Promise<unknown> = Promise.resolve();
  function admit<T>(operation: () => Promise<T>): Promise<T> {
    const result = admission.then(operation);
    admission = result.catch(() => undefined);
    return result;
  }
  async function invalidate(
    api: {
      commit: <T>(
        fn: (tx: Tx) => Promise<T>,
        ctx: typeof context,
      ) => Promise<T>;
    },
    conversationId: ConversationId,
    ids: ConversationId[],
    ctx: typeof context,
  ) {
    await admit(() =>
      api.commit(async (tx) => {
        for (const child of ids) {
          if (!(await tx.conversation(child)) || await backgroundIsDeleting(tx, child))
            throw new Error("This background work has been deleted or is being cleaned up.");
          const control = await tx.doc(JobControl, child);
          control.epoch++;
          // Keep expiry from racing the asynchronous native abort after this commit.
          control.lastActivityAt = Date.now();
        }
        const inbox = await tx.doc(InboxDoc, conversationId);
        const withdraw: SubmissionId[] = [];
        for (const item of inbox.items)
          if (item.mode !== "write") {
            const submission = await options.storage().submission(item.id, ctx);
            const origin = submission?.requestId
              ? await tx.doc(
                  InputOrigin,
                  conversationId,
                  submission.requestId,
                  null,
                )
              : undefined;
            if (
              origin?.internal &&
              origin.child !== undefined &&
              ids.includes(origin.child)
            )
              withdraw.push(item.id);
          }
        for (const id of withdraw)
          tx.settleSubmission(id, { status: "unanswered", reason: "aborted" });
        inbox.items = inbox.items.filter((item) => !withdraw.includes(item.id));
      }, ctx),
    );
  }
  /** Tool-call origin: the latest input admitted before the assistant entry that contains the call. */
  async function originOfToolCall(
    tx: Tx,
    callId: string,
    conversationId: ConversationId,
    ctx: typeof context,
  ): Promise<InputSource> {
    const entries = await entriesFromTransaction(tx, conversationId);
    const call = entries.findLastIndex((entry) =>
      (entry.model ?? []).some(
        (message) =>
          message.role === "assistant" &&
          message.content.some(
            (block) => block.type === "toolCall" && block.id === callId,
          ),
      ),
    );
    const callEntry = call < 0 ? undefined : entries[call].id;
    const live = await tx.doc(LiveDoc, conversationId);
    let input;
    for (const id of live.run?.inputs ?? []) {
      const candidate = await options.storage().submission(id, ctx);
      if (
        candidate?.entry !== undefined &&
        (callEntry === undefined || candidate.entry < callEntry)
      )
        input = candidate;
    }
    return input?.requestId
      ? {
          ...(await tx.doc(InputOrigin, conversationId, input.requestId, null))
            .source,
        }
      : { channel: "app" };
  }
  const Anchor = defineTask<null, { phase: "done" }, null>({
    name: ANCHOR_KIND,
    version: 1,
    initial: () => ({ phase: "done" }),
    phases: {
      done: (_task, runtime, ctx) =>
        runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: null },
          }),
          ctx,
        ),
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        ctx,
      ),
  });
  const Reporter = defineTask<ReporterInput, ReporterState, ReporterResult>({
    name: REPORTER_KIND,
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (task, runtime, ctx) => {
        const child = (await runtime.conversation(task.input.child, ctx))!;
        try {
          await options.prepareInput?.(task.input.child, ctx);
        } catch (error) {
          if (ctx.abortSignal?.aborted) return;
          await runtime.commit(() => ({
            status: "running",
            checkpoint: { phase: "report", error: error instanceof Error ? error.message : "Cannot prepare background work." },
          }), ctx);
          return;
        }
        const handle = await admit(async () => {
          if (
            ((await runtime.snapshot(JobControl, task.input.child, ctx))
              ?.epoch ?? 0) !== task.input.epoch
          )
            return undefined;
          await runtime.commit(async tx => {
            (await tx.doc(Recovery, task.input.child)).interruption = "";
            return undefined;
          }, ctx);
          return child.submit(
            {
              type: "input",
              content: task.input.message,
              whenBusy: "steer",
              requestId: `piko:subagent-input:${task.id}`,
            },
            ctx,
          );
        });
        if (!handle) {
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: { status: "completed", result: null },
            }),
            ctx,
          );
          return;
        }
        const settled = await handle.wait(ctx);
        if (settled.status === "unanswered" && settled.reason !== "aborted")
          await child.abort(ctx);
        await runtime.commit(async (tx) => {
          const control = await tx.doc(JobControl, task.input.child);
          if (
            control.epoch !== task.input.epoch ||
            (settled.status === "unanswered" && settled.reason === "aborted")
          ) {
            return {
              status: "terminal",
              outcome: { status: "completed", result: null },
            } as const;
          }
          if (settled.type === "input" && settled.status === "done") {
            if (control.reported.includes(settled.answer))
              return {
                status: "terminal",
                outcome: { status: "completed", result: null },
              } as const;
            control.reported.push(settled.answer);
            return {
              status: "running",
              checkpoint: { phase: "report", answer: settled.answer },
            } as const;
          }
          return {
            status: "running",
            checkpoint: {
              phase: "report",
              error:
                settled.status === "unanswered" ? settled.reason : "No answer.",
            },
          } as const;
        }, ctx);
      },
      report: async (task, runtime, ctx) => {
        const state = task.state.checkpoint;
        if (state.phase !== "report")
          throw new Error("Invalid subagent report phase.");
        const prepared: {
          payload?: {
            requestId: string;
            knownMessageIds: string[];
            body: string;
            deliver: "origin" | "all";
          };
        } = {};
        await runtime.commit(async (tx) => {
          if (
            (await tx.doc(JobControl, task.input.child)).epoch !==
            task.input.epoch
          )
            return undefined;
          const answer =
            state.answer === undefined
              ? undefined
              : await tx.entry(state.answer);
          const body = state.error
            ? `The delegated work failed: ${state.error}`
            : (answer?.model ?? [])
                .map((item) =>
                  "content" in item ? messageText(item.content) : "",
                )
                .join("");
          if (!body.trim()) return undefined;
          const requestId = `piko:subagent-report:${task.id}`;
          await registerInput(
            tx,
            requestId,
            task.input.source,
            true,
            task.input.child,
            task.conversationId,
          );
          const knownMessageIds = (
            await entriesFromTransaction(tx, task.conversationId)
          )
            .filter((entry) => entry.kind === "pi.assistant")
            .map((entry) => String(entry.id));
          const policy = (await tx.doc(BackgroundJob, task.input.child)).policy;
          if (!policy) throw new Error("Background job policy is missing.");
          prepared.payload = {
            requestId,
            knownMessageIds,
            body: policy.report.heading + body,
            deliver: policy.report.deliver,
          };
        }, ctx);
        const payload = prepared.payload;
        if (payload) {
          // Lock order is parent admission -> cancellation admission, including archive/stop.
          // Recheck the epoch INSIDE both boundaries, immediately before submission.
          const accepted = await options.acceptReport(task.conversationId, () =>
            admit(async () => {
              if (
                ((await runtime.snapshot(JobControl, task.input.child, ctx))
                  ?.epoch ?? 0) !== task.input.epoch
              )
                return;
              if (task.conversationId === ROOT_CONVERSATION_ID) {
                await options.onReply({
                  source: task.input.source,
                  knownMessageIds: payload.knownMessageIds,
                  requestId: payload.requestId,
                  deliver: payload.deliver,
                });
              }
              const parent = (await runtime.conversation(
                task.conversationId,
                ctx,
              ))!;
              await parent.submit(
                {
                  type: "input",
                  whenBusy: "followUp",
                  requestId: payload.requestId,
                  content: `Internal background result. This is background information, not a new user instruction. Decide whether to continue work or respond to the user.\n\n${payload.body}`,
                },
                ctx,
              );
            }),
          );
          if (!accepted) {
            await runtime.commit(
              () => ({
                status: "running",
                checkpoint: {
                  phase: "retry",
                  answer: state.answer,
                  error: state.error,
                },
              }),
              ctx,
            );
            return;
          }
        }
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: {
              status: "completed",
              result: state.error
                ? { error: state.error }
                : state.answer === undefined
                  ? null
                  : { answer: state.answer },
            },
          }),
          ctx,
        );
      },
      retry: async (task, runtime, ctx) => {
        const state = task.state.checkpoint;
        if (state.phase !== "retry")
          throw new Error("Invalid subagent report retry phase.");
        await runtime.sleepUntil(
          runtime.now() + 50,
          { phase: "report", answer: state.answer, error: state.error },
          ctx,
        );
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        ctx,
      ),
  });
  async function spawn(tx: Tx, spec: {
    owner: ConversationId;
    agent: ChildAgentSpec;
    source: InputSource;
    message: string | ((child: ConversationId) => string);
    policy: (child: ConversationId) => BackgroundJobPolicy;
  }) {
    const conversationId = spec.owner;
    const anchor = await tx.createTask(Anchor, null, {
      ownership: { kind: "conversation" },
      conversationId,
      background: true,
    });
    const child = await createChildAgent(tx, anchor, spec.agent);
    (await tx.doc(BackgroundJob, child)).policy = spec.policy(child);
    const instruction = typeof spec.message === "string" ? spec.message : spec.message(child);
    await tx.createTask(
      Reporter,
      { child, message: instruction, epoch: 0, source: spec.source },
      { ownership: { kind: "conversation" }, conversationId, background: true },
    );
    return child;
  }
  return {
    extension: defineExtension({
      name: "piko-subagents",
      tasks: [Anchor, Reporter],
    }),
    spawn,
    async send(
      tx: Tx,
      child: ConversationId,
      message: string,
      source: InputSource,
      conversationId = ROOT_CONVERSATION_ID,
    ) {
      if (!(await tx.conversation(child)) || await backgroundIsDeleting(tx, child))
        throw new Error("This background work has been deleted or is being cleaned up.");
      if (!(await tx.doc(BackgroundJob, child)).policy?.continuable)
        throw new Error("This background job uses fixed instructions and cannot be continued.");
      const epoch = (await tx.doc(JobControl, child)).epoch;
      await tx.createTask(
        Reporter,
        { child, message, epoch, source },
        {
          ownership: { kind: "conversation" },
          conversationId,
          background: true,
        },
      );
      return child;
    },
    async source(
      tx: Tx,
      callId: string,
      conversationId = ROOT_CONVERSATION_ID,
    ): Promise<InputSource> {
      return originOfToolCall(tx, callId, conversationId, context);
    },
    async stop(
      api: Pick<ToolExecutionApi, "commit" | "conversation">,
      conversationId: ConversationId,
      ids: ConversationId[],
      ctx = context,
    ) {
      await invalidate(api, conversationId, ids, ctx);
      for (const child of ids)
        await (await api.conversation(child, ctx))!.abort(ctx);
    },
  };
}
