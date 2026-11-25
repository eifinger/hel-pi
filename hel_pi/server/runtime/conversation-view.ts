import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { WatchCall } from "@earendil-works/chord/watch";
import {
  InboxDoc,
  LiveDoc,
  type Conversation,
  type ConversationView as DurableConversationView,
  type EntryRecord,
  type Harness,
  type InboxState,
  type LiveState,
  type Observation,
  type NestedToolSlot,
  type SubmissionId,
  type SubmissionRecord,
  type Storage,
  type Cursor,
  type ToolSlot,
} from "@earendil-works/pi-durable";
import type { ChatUsage } from "../../shared/chat";
import type { SessionEvent } from "./types";
import { summarizeToolArgs } from "./tool-activity";
import { CompactionObserver } from "./compactions";
import { ConversationActivityProjection } from "./conversation-activity";
import {
  entriesFromTransaction,
  historyPageFromTransaction,
  inputsFromStorage,
  messageText,
  projectPiHistory,
  historyAroundPiMessage,
  searchPiHistory,
  splitAttachments,
  readPiEntries,
  readPiInputs,
} from "./pi-history";
import { PiMessageEvents } from "./pi-events";
import { internalInput } from "./input-origin";
import type { WorkspaceModelConfig } from "./model-config";
import { Recovery } from "./conversation-docs";
import { logError, logInfo, logWarn } from "../logging";

export function submissionReceipt(
  record: SubmissionRecord,
): import("../../shared/chat").SubmissionReceipt {
  return {
    id: String(record.id),
    ...(record.requestId && { requestId: record.requestId }),
    status: record.status,
    ...(record.status === "unanswered" && {
      error: typeof record.detail === "string" ? record.detail : record.reason,
    }),
  };
}

/** Read/display projection. Never starts or stops work and never closes the Harness. */
export class ConversationView {
  private compactions!: CompactionObserver;
  private entries: EntryRecord[] = [];
  private inputEntries = new Map<number, string>();
  private readonly pendingBindings = new Map<number, string>();
  private loadingBindings = false;
  private entryIds = new Set<number>();
  private projectedEntryIds = new Set<number>();
  private hiddenEntries = new Set<number>();
  private unsubscribeBindings?: () => void;
  private viewObservation?: Observation<DurableConversationView>;
  private delivery?: Promise<void>;
  private readonly pendingViews: DurableConversationView[] = [];
  private viewReady = false;
  private observationClosed = false;
  private drainScheduled = false;
  private lastLive?: LiveState;
  private lastInbox?: InboxState;
  private runActive?: boolean;
  private activeInputs = new Set<SubmissionId>();
  private output = new PiMessageEvents((event) => this.emit(event));
  private previousIds = new Map<string, string>();
  private readonly contextWindows = new Map<string, number>();
  selected?: { provider: string; modelId: string };
  private readonly toolCalls = new Map<string, {
    name: string;
    summary: string;
    startedAt: number;
    finished: boolean;
  }>();
  private runStartedAt?: number;
  private readonly liveActivity = new ConversationActivityProjection(
    activity => this.emit({ type: "activity", activity }),
    callId => this.toolArguments(callId),
  );
  observationError?: Error;

  constructor(
    private readonly harness: Harness,
    private readonly storage: Storage,
    private readonly conversation: Conversation,
    private readonly config: WorkspaceModelConfig,
    private readonly publish: (event: SessionEvent) => void,
    private readonly activity: (running: boolean, boundary: boolean) => void,
    private readonly isBusy: () => boolean,
    private readonly isClosed: () => boolean,
  ) {}
  get messages() {
    const messages = projectPiHistory(
      this.entries,
      this.inputEntries,
      this.hiddenEntries,
    ).messages;
    const partial = this.output.partial(this.entries);
    return partial?.content.trim() ? [...messages, partial] : messages;
  }
  async init(): Promise<void> {
    const { harness, conversation } = this;
    this.compactions = new CompactionObserver(
      harness,
      (event) => this.emit(event),
      () => this.emit({ type: "invalidated" }),
    );
    const agent = await conversation.agent(ctx);
    this.selected = agent.model && {
      provider: agent.model.provider,
      modelId: agent.model.modelId,
    };
    for (const model of await this.config.models.getAvailable())
      this.contextWindows.set(
        `${model.provider}/${model.id}`,
        model.contextWindow,
      );
    const observation = harness.observeCommits({
      advance: (publication) => {
        let invalidated = false;
        for (const change of publication.changes) {
          if (change.type !== "submission") continue;
          const input = change.value;
          if (input.conversationId !== conversation.id) continue;
          if (
            input.type === "input" &&
            input.requestId &&
            input.entry !== undefined
          ) {
            this.inputEntries.set(input.entry, input.requestId);
            if (this.loadingBindings)
              this.pendingBindings.set(input.entry, input.requestId);
          }
          invalidated = true;
        }
        if (invalidated)
          queueMicrotask(() => {
            if (!this.isClosed()) this.emit({ type: "invalidated" });
          });
      },
      end: () => {},
    });
    this.unsubscribeBindings = () => observation.detach();
    this.entries = await readPiEntries(harness, conversation.id);
    this.entryIds = new Set(this.entries.map(entry => entry.id));
    await this.reloadInputBindings();
    this.hiddenEntries = await harness.commit(async (tx) => {
      const hidden = new Set<number>();
      for (const [entry, requestId] of this.inputEntries)
        if (await internalInput(tx, requestId, conversation.id))
          hidden.add(entry);
      return hidden;
    }, ctx);
    await this.attachObservation(true);
    logInfo("conversation.observation.started", {
      conversationId: String(conversation.id),
      historyCount: this.entries.length,
      recoveredRunActive: !!this.runActive,
    });
  }

  private async attachObservation(initial = false) {
    this.viewReady = false;
    this.observationClosed = false;
    this.pendingViews.length = 0;
    // Synchronous observers run on the Session line; queue immutable views and
    // project them off-line.
    const observation = await this.harness.observeConversation(this.conversation.id, {
      advance: (call: WatchCall<DurableConversationView>) => {
        if (call.kind === "value") {
          this.pendingViews.push(call.value);
          if (this.viewReady) this.scheduleViewDrain();
        } else {
          this.observationError = call.error instanceof Error
            ? call.error
            : new Error("Durable conversation view is temporarily unavailable.");
        }
      },
      end: (end) => {
        this.observationClosed = true;
        const detail = "error" in end ? end.error : undefined;
        this.observationError = detail instanceof Error
          ? detail
          : new Error(end.kind === "failed"
            ? "The durable session failed; restart Piko."
            : `Durable conversation view closed: ${end.kind}`);
        if (!this.isClosed())
          queueMicrotask(() => logError("conversation.observation.closed", {
            conversationId: String(this.conversation.id),
            reason: end.kind,
          }));
      },
    }, ctx);
    this.viewObservation = observation;
    await this.observeView(observation.value, initial);
    while (this.pendingViews.length) {
      const pending = this.pendingViews.splice(0);
      for (const view of pending) await this.observeView(view);
    }
    if (!this.observationClosed) this.observationError = undefined;
    this.viewReady = true;
    if (this.pendingViews.length) this.scheduleViewDrain();
  }

  private scheduleViewDrain() {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.delivery = this.drainViews();
      void this.delivery.catch(error => {
        this.observationError = error instanceof Error ? error : new Error(String(error));
        logError("conversation.observation.update_failed", {
          conversationId: String(this.conversation.id),
        });
      });
    });
  }

  private async drainViews() {
    while (this.viewReady && this.pendingViews.length) {
      const pending = this.pendingViews.shift()!;
      try {
        await this.observeView(pending);
      } catch (error) {
        this.observationError = error instanceof Error ? error : new Error(String(error));
        logError("conversation.observation.update_failed", {
          conversationId: String(this.conversation.id),
        });
      }
    }
  }

  /** Rebuild the raw-entry projection after deletion without stopping the conversation. */
  async refreshObservation(): Promise<void> {
    this.viewReady = false;
    this.viewObservation?.detach();
    this.pendingViews.length = 0;
    await this.delivery?.catch(() => {});
    this.entries = await readPiEntries(this.harness, this.conversation.id);
    this.entryIds = new Set(this.entries.map(entry => entry.id));
    this.projectedEntryIds.clear();
    await this.reloadInputBindings();
    this.hiddenEntries = await this.harness.commit(async (tx) => {
      const hidden = new Set<number>();
      for (const [entry, requestId] of this.inputEntries)
        if (await internalInput(tx, requestId, this.conversation.id)) hidden.add(entry);
      return hidden;
    }, ctx);
    this.lastLive = undefined;
    this.lastInbox = undefined;
    this.runActive = undefined;
    this.activeInputs.clear();
    this.toolCalls.clear();
    await this.attachObservation(true);
    this.emit({ type: "invalidated" });
  }

  get bindings(): ReadonlyMap<number, string> {
    return this.inputEntries;
  }

  private async reloadInputBindings() {
    this.pendingBindings.clear();
    this.loadingBindings = true;
    try {
      const bindings = await readPiInputs(this.harness, this.storage, this.conversation.id);
      for (const [entry, requestId] of this.pendingBindings) bindings.set(entry, requestId);
      this.inputEntries = bindings;
    } finally {
      this.loadingBindings = false;
      this.pendingBindings.clear();
    }
  }

  private async mergeViewEntries(view: DurableConversationView) {
    const tail = this.entries.at(-1)?.id;
    const missedWindow =
      view.before !== undefined && (tail === undefined || view.before > tail);
    if (missedWindow) {
      this.entries = await readPiEntries(this.harness, this.conversation.id);
      this.entryIds = new Set(this.entries.map(entry => entry.id));
    }
    const additions = view.entries.filter(entry => !this.entryIds.has(entry.id));
    for (const entry of additions) this.entryIds.add(entry.id);
    if (additions.length) {
      const currentTail = this.entries.at(-1)?.id;
      this.entries.push(...additions);
      if (currentTail !== undefined && additions.some(entry => entry.id <= currentTail))
        this.entries.sort((a, b) => a.id - b.id);
    }
    const through = view.entries.reduce((latest, entry) => Math.max(latest, entry.id), 0);
    const candidates = missedWindow
      ? this.entries.filter(entry => entry.id <= through)
      : view.entries;
    return candidates
      .filter(entry => !this.projectedEntryIds.has(entry.id))
      .sort((a, b) => a.id - b.id);
  }

  private async observeView(view: DurableConversationView, initial = false) {
    const live = (view.docs[LiveDoc.definition.kind] ?? {}) as LiveState;
    const inbox = (view.docs[InboxDoc.definition.kind] ?? { items: [] }) as InboxState;
    const liveMessage = live.run ? live.generation?.message : undefined;
    const added = await this.mergeViewEntries(view);
    const runActive = !!live.run;
    const queued = inbox.items.some(item => item.mode !== "write");
    const busy = runActive || queued;
    const runStarted = !initial && this.runActive === false && runActive;
    const runEnded = !initial && this.runActive === true && !runActive;
    const inboxChanged =
      !initial && JSON.stringify(this.lastInbox) !== JSON.stringify(inbox);

    if (runStarted) {
      this.toolCalls.clear();
      this.activeInputs.clear();
      this.runStartedAt = Date.now();
      logInfo("conversation.run.started", {
        conversationId: String(this.conversation.id),
      });
      this.activity(true, true);
      this.liveActivity.runStarted();
      this.emit({ type: "run-start" });
    }
    if (live.run) for (const id of live.run.inputs) this.activeInputs.add(id);

    this.syncToolCalls(live, initial);
    if (!initial)
      for (const entry of added)
        if (entry.kind === "pi.user") this.emit({ type: "input-applied" });
    if (initial) {
      const through = view.entries.reduce((latest, entry) => Math.max(latest, entry.id), 0);
      const seed = this.entries.filter(entry => entry.id <= through);
      for (const entry of seed) this.projectedEntryIds.add(entry.id);
      this.output.sync(seed, liveMessage, true);
    } else {
      for (const entry of added) this.projectedEntryIds.add(entry.id);
      this.output.sync(added, liveMessage);
    }
    this.liveActivity.restore(live, busy);

    const previousCompactions = new Map(
      (this.lastLive?.compactions ?? []).map(item => [item.taskId, item]),
    );
    const nativeCompactions = (live.compactions ?? []).map(item => ({
      taskId: item.taskId,
      reason: item.trigger,
    }));
    for (const item of live.compactions ?? [])
      if (!previousCompactions.has(item.taskId) && !initial)
        logInfo("conversation.compaction.started", {
          conversationId: String(this.conversation.id),
          reason: item.trigger,
        });
    for (const [taskId] of previousCompactions)
      if (!live.compactions?.some(item => item.taskId === taskId) && !initial)
        logInfo("conversation.compaction.finished", {
          conversationId: String(this.conversation.id),
        });
    this.compactions.sync(nativeCompactions, initial);
    this.lastLive = live;
    this.lastInbox = inbox;
    this.runActive = runActive;

    if (runEnded) {
      this.activity(false, true);
      const inputs = [...this.activeInputs];
      const submissions = await this.harness.commit(async () => {
        const records = await Promise.all(
          inputs.map(id => this.storage.submission(id, ctx)),
        );
        return records
          .filter((record): record is SubmissionRecord => !!record)
          .map(submissionReceipt);
      }, ctx);
      const durationMs = this.runStartedAt === undefined
        ? undefined
        : Date.now() - this.runStartedAt;
      this.runStartedAt = undefined;
      this.activeInputs.clear();
      this.toolCalls.clear();
      logInfo("conversation.run.completed", {
        conversationId: String(this.conversation.id),
        ...(durationMs !== undefined && { durationMs }),
        submissionCount: submissions.length,
        unansweredCount: submissions.filter(
          item => item.status === "unanswered",
        ).length,
      });
      this.emit({ type: "run-end", submissions });
      if (!queued) this.liveActivity.runEnded();
      else this.liveActivity.restore(live, busy);
    } else if (!runStarted || initial) {
      this.activity(runActive, false);
    }

    if (!initial && (added.length || inboxChanged || runStarted || runEnded))
      this.emit({ type: "invalidated" });
    if (!this.observationClosed) this.observationError = undefined;
  }

  private syncToolCalls(live: LiveState, initial: boolean) {
    const slots = new Map<string, ToolSlot | NestedToolSlot>();
    for (const slot of [...(live.tools ?? []), ...(live.nestedTools ?? [])])
      slots.set(slot.callId, slot);

    for (const [callId, current] of this.toolCalls) {
      const slot = slots.get(callId);
      if (!slot) {
        if (!current.finished) this.finishTool(callId, current);
        this.toolCalls.delete(callId);
      } else {
        if (slot.status === "done" && !current.finished)
          this.finishTool(callId, current, slot);
      }
    }

    for (const slot of slots.values()) {
      if (slot.status === "pending" || this.toolCalls.has(slot.callId)) continue;
      const current = this.startTool(slot, !initial);
      if (slot.status === "done") this.finishTool(slot.callId, current, slot, !initial);
    }
  }

  private startTool(slot: ToolSlot | NestedToolSlot, notify = true) {
    const args = "arguments" in slot ? slot.arguments : this.toolArguments(slot.callId);
    const current = {
      name: slot.name,
      summary: summarizeToolArgs(slot.name, args),
      startedAt: Date.now(),
      finished: false,
    };
    this.toolCalls.set(slot.callId, current);
    if (notify) {
      logInfo("tool.execution.started", {
        conversationId: String(this.conversation.id),
        tool: slot.name,
      });
      this.liveActivity.toolStarted(slot.name, current.summary);
      this.emit({
        type: "tool",
        activity: {
          callId: slot.callId,
          name: slot.name,
          summary: current.summary,
          status: "running",
        },
      });
    }
    return current;
  }

  private finishTool(
    callId: string,
    current: { name: string; summary: string; startedAt: number; finished: boolean },
    slot?: ToolSlot | NestedToolSlot,
    notify = true,
  ) {
    if (current.finished) return;
    current.finished = true;
    const nested = slot && "summary" in slot ? slot.summary : undefined;
    const entryId = slot && "entry" in slot ? slot.entry : undefined;
    const entryResult = entryId === undefined
      ? undefined
      : this.entries.find(entry => entry.id === entryId)?.model?.[0];
    const result = nested ? undefined : entryResult ?? this.toolResult(callId);
    const resultDuration = result &&
      "durationMs" in result &&
      typeof result.durationMs === "number"
        ? result.durationMs
        : undefined;
    const durationMs = nested?.durationMs ?? resultDuration;
    const resultFailed = result && "isError" in result && result.isError === true;
    const failed = nested?.isError ?? resultFailed ?? false;
    if (!notify) return;
    const fields = {
      conversationId: String(this.conversation.id),
      tool: current.name,
      durationMs: durationMs ?? Date.now() - current.startedAt,
    };
    if (failed) logWarn("tool.execution.failed", fields);
    else logInfo("tool.execution.completed", fields);
    this.emit({
      type: "tool",
      activity: {
        callId,
        name: current.name,
        summary: current.summary,
        status: failed ? "error" : "done",
        ...(durationMs !== undefined && { durationMs }),
      },
    });
  }

  private toolArguments(callId: string): unknown {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry.kind !== "pi.assistant") continue;
      for (const message of entry.model ?? []) {
        if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
        const toolCall = message.content.find(
          block => block.type === "toolCall" && block.id === callId,
        );
        if (toolCall?.type === "toolCall") return toolCall.arguments;
      }
    }
    return undefined;
  }

  private toolResult(callId: string) {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry.kind !== "pi.tool-result") continue;
      const result = entry.model?.[0];
      if (result?.role === "toolResult" && result.toolCallId === callId) return result;
    }
    return undefined;
  }
  private emit(event: SessionEvent) {
    if (
      event.type === "message" &&
      !event.final &&
      !this.output.partial(this.entries)
    )
      return;
    if (event.type === "message" && event.previousId) {
      this.previousIds.set(event.message.id, event.previousId);
      if (this.previousIds.size > 128)
        this.previousIds.delete(this.previousIds.keys().next().value!);
    }
    this.publish(event);
  }
  async submission(requestId: string) {
    const record = await this.harness.commit(
      (tx) => tx.submissionByRequest(this.conversation.id, requestId),
      ctx,
    );
    return record && submissionReceipt(record);
  }
  /** Prompt size reported by the last model call, paired with the configured context window. */
  private usage(): ChatUsage | undefined {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry.kind !== "pi.assistant") continue;
      const messages = entry.model ?? [];
      for (let part = messages.length - 1; part >= 0; part -= 1) {
        const message = messages[part];
        if (message.role !== "assistant" || !message.usage) continue;
        const value = message.usage;
        const contextWindow =
          this.selected &&
          this.contextWindows.get(
            `${this.selected.provider}/${this.selected.modelId}`,
          );
        return {
          input: value.input,
          output: value.output,
          cacheRead: value.cacheRead,
          cacheWrite: value.cacheWrite,
          totalTokens: value.totalTokens,
          ...(contextWindow && {
            contextWindow,
            ratio:
              (value.input + value.cacheRead + value.cacheWrite) /
              contextWindow,
          }),
        };
      }
    }
    return undefined;
  }
  async history(before?: string, limit?: number) {
    return this.harness.commit(async (tx) => {
      const { entries: _entries, ...page } = await historyPageFromTransaction(
        tx,
        this.inputEntries,
        before,
        limit,
        this.conversation.id,
      );
      return page;
    }, ctx);
  }
  search(query: string, limit: number) {
    return this.harness.commit(
      tx => searchPiHistory(tx, this.inputEntries, query, limit, this.conversation.id),
      ctx,
    );
  }
  historyAround(messageId: string, limit: number) {
    return this.harness.commit(
      tx => historyAroundPiMessage(tx, this.inputEntries, messageId, limit, this.conversation.id),
      ctx,
    );
  }
  async snapshot(options?: { limit: number }) {
    const state = await this.harness.commit(async (tx) => {
      const page =
        options &&
        (await historyPageFromTransaction(
          tx,
          this.inputEntries,
          undefined,
          options.limit,
          this.conversation.id,
        ));
      const entries = page
        ? page.entries
        : await entriesFromTransaction(tx, this.conversation.id);
      const inputs = page
        ? this.inputEntries
        : await inputsFromStorage(this.storage, this.conversation.id);
      const hidden = new Set<number>();
      if (!page)
        for (const [entry, requestId] of inputs)
          if (await internalInput(tx, requestId, this.conversation.id))
            hidden.add(entry);
      const live = await tx.doc(LiveDoc, this.conversation.id);
      let latest: SubmissionRecord | undefined;
      let cursor: Cursor | undefined;
      do {
        const page = await this.storage.scanSubmissions(
          { conversationId: this.conversation.id, order: "descending" },
          100,
          cursor,
          ctx,
        );
        for (const input of page.items)
          if (
            !(await internalInput(tx, input.requestId, this.conversation.id))
          ) {
            latest = input;
            break;
          }
        cursor = page.next;
      } while (!latest && cursor);
      const inbox = await tx.doc(InboxDoc, this.conversation.id);
      const queued: import("../../shared/chat").Message[] = [];
      for (const item of inbox.items)
        if (item.mode !== "write") {
          const input = await this.storage.submission(item.id, ctx);
          if (await internalInput(tx, input?.requestId, this.conversation.id))
            continue;
          const projected = splitAttachments(messageText(item.content));
          queued.push({
            id: `input-${item.id}`,
            role: "user",
            content: projected.text,
            createdAt: 0,
            ...(projected.attachments && { attachments: projected.attachments }),
            ...(input?.requestId && { requestId: input.requestId }),
          });
        }
      const recovery = await tx.doc(Recovery, this.conversation.id);
      return {
        entries,
        inputs,
        hidden,
        page,
        running:
          !!live.run || inbox.items.some((item) => item.mode !== "write"),
        activity: this.liveActivity.snapshot(
          live,
          !!live.run || inbox.items.some(item => item.mode !== "write"),
        ),
        queued,
        latest,
        interruption: recovery.interruption,
        nativeCompactions: (live.compactions ?? []).map((item) => ({
          taskId: item.taskId,
          reason: item.trigger,
        })),
      };
    }, ctx);
    this.activity(state.running, false);
    let messages;
    if (state.page) {
      messages = state.page.messages;
      const partial = this.output.partial(state.entries);
      if (partial?.content.trim()) messages = [...messages, partial];
    } else {
      this.entries = state.entries;
      this.entryIds = new Set(this.entries.map(entry => entry.id));
      for (const [entry, requestId] of state.inputs)
        this.inputEntries.set(entry, requestId);
      this.hiddenEntries = state.hidden;
      messages = this.messages;
    }
    const usage = this.usage();
    return {
      messages: [...messages, ...state.queued],
      ...(state.page && { history: { nextBefore: state.page.nextBefore } }),
      busy: this.isBusy(),
      activity: this.isBusy() && state.activity.kind === "idle"
        ? { kind: "thinking" as const }
        : state.activity,
      compactions: this.compactions.snapshot(state.nativeCompactions),
      previousIds: Object.fromEntries(this.previousIds),
      ...(state.latest && { latest: submissionReceipt(state.latest) }),
      ...(state.interruption && { interruption: state.interruption }),
      ...(usage && { usage }),
    };
  }
  async close(): Promise<void> {
    this.compactions?.close();
    this.viewReady = false;
    this.viewObservation?.detach();
    this.pendingViews.length = 0;
    await this.delivery?.catch(() => {});
    this.unsubscribeBindings?.();
  }
}
