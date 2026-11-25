import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  type Conversation,
  type Storage,
  type Harness,
  InboxDoc,
  configure as configureAgent,
} from "@earendil-works/pi-durable";
import type {
  CompactionResult,
  RuntimeDescription,
} from "../../shared/runtime";
import type { WorkspacePaths } from "../workspace";
import type {
  BackgroundReply,
  InputSource,
  ChatSession,
  SessionEvent,
} from "./types";
import { attachmentPrompt } from "../chat/input";
import { CompactionExecutionError, ModelConfigurationError } from "./types";
import { compactionResult } from "./compactions";
import { registerInput } from "./input-origin";
import { loadWorkspaceResources } from "./resources";
import {
  requireAvailableModel,
  type WorkspaceModelConfig,
} from "./model-config";
import type { MemoryCurationService } from "./memory-curation";
import type { BackgroundReplies } from "./background-replies";
import { ConversationControl } from "./conversation-control";
import { ConversationView, submissionReceipt } from "./conversation-view";
import { Recovery } from "./conversation-docs";
import { logInfo, logWarn } from "../logging";

/** One conversation's facade; Runtime owns its lifetime and the shared Harness. */
export class DurableChatSession implements ChatSession {
  private readonly memoryCurationServices: MemoryCurationService[] = [];
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private readonly control: ConversationControl;
  private readonly view: ConversationView;
  private closing?: Promise<void>;

  constructor(
    readonly paths: WorkspacePaths,
    private readonly harness: Harness,
    storage: Storage,
    private readonly conversation: Conversation,
    private readonly config: WorkspaceModelConfig,
    private readonly searchConfigured: boolean,
    private readonly assertWritable: () => Promise<void> = async () => {},
    private readonly replies?: BackgroundReplies,
  ) {
    this.control = new ConversationControl(
      harness,
      conversation,
      () => this.emit({ type: "invalidated" }),
      assertWritable,
      () => this.view.observationError,
    );
    this.view = new ConversationView(
      harness,
      storage,
      conversation,
      config,
      (event) => this.emit(event),
      (running, boundary) => {
        this.control.running = running;
        if (boundary)
          for (const service of this.memoryCurationServices)
            void (running ? service.onRunStart() : service.onRunEnd()).catch(() =>
              logWarn("memory.review.activity_failed"),
            );
      },
      () => this.control.isBusy,
      () => this.control.closed,
    );
  }

  get native() {
    return this.conversation;
  }
  get nativeHarness() {
    return this.harness;
  }
  get isStreaming() {
    return this.control.isBusy;
  }
  get closed() { return this.control.closed; }
  get messages() {
    return this.view.messages;
  }
  get bindings() {
    return this.view.bindings;
  }
  get canReport() {
    return this.control.canReport;
  }
  init() {
    return this.view.init();
  }
  refreshObservation() {
    return this.control.serial(() => this.view.refreshObservation());
  }
  attachMemory(service: MemoryCurationService) {
    this.memoryCurationServices.push(service);
  }
  receiveReport(operation: () => Promise<void>) {
    return this.control.receiveReport(operation);
  }
  async remove(operation: () => Promise<void>) {
    try {
      await this.control.remove(operation);
      this.emit({ type: "deleted" });
    } finally {
      if (this.control.closed) {
        await this.view.close();
        this.listeners.clear();
      }
    }
  }
  async ensureReady() {
    if (this.control.isBusy) {
      await this.requireCurrentAgent();
      return;
    }
    await this.syncConfiguredMain();
  }
  syncConfiguredMain() {
    return this.control.maintain(() => this.applyMainModel());
  }
  snapshot(options?: { limit: number }) {
    return this.view.snapshot(options);
  }
  history(before?: string, limit?: number) {
    return this.view.history(before, limit);
  }
  searchHistory(query: string, limit: number) {
    return this.view.search(query, limit);
  }
  historyAround(messageId: string, limit: number) {
    return this.view.historyAround(messageId, limit);
  }
  submission(requestId: string) {
    return this.view.submission(requestId);
  }
  subscribe(listener: (event: SessionEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  subscribeBackgroundReplies(
    listener: (reply: BackgroundReply) => Promise<void>,
  ) {
    return this.replies?.subscribe(listener) ?? (() => {});
  }
  private emit(event: SessionEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        logWarn("conversation.output_observer.failed", {
          conversationId: String(this.conversation.id),
        });
      }
    }
  }
  async submit(
    text: string,
    requestId: string,
    source: InputSource = { channel: "app" },
    attachments: readonly string[] = [],
  ) {
    if (requestId.startsWith("piko:"))
      throw new Error("Reserved input identity.");
    const prompt = attachmentPrompt(text, attachments);
    return this.control.serial(async () => {
      this.control.assertInput();
      const existing = await this.submission(requestId);
      if (existing) {
        logInfo("conversation.input.duplicate", {
          conversationId: String(this.conversation.id),
          channel: source.channel,
        });
        return { submission: existing, duplicate: true };
      }
      await this.assertWritable();
      await this.requireCurrentAgent();
      await this.conversation.commit(async (tx) => {
        (await tx.doc(Recovery, this.conversation.id)).interruption = "";
        await registerInput(
          tx,
          requestId,
          source,
          false,
          undefined,
          this.conversation.id,
        );
      }, ctx);
      const handle = await this.conversation.submit(
        { type: "input", content: prompt, requestId, whenBusy: "steer" },
        ctx,
      );
      this.control.running = true;
      const acceptedAt = Date.now();
      logInfo("conversation.input.accepted", {
        conversationId: String(this.conversation.id),
        channel: source.channel,
        attachmentCount: attachments.length,
      });
      void handle
        .wait(ctx)
        .then(async (settled) => {
          logInfo("conversation.input.settled", {
            conversationId: String(this.conversation.id),
            status: settled.status,
            durationMs: Date.now() - acceptedAt,
          });
          if (
            settled.status === "unanswered" &&
            settled.reason !== "aborted" &&
            settled.reason !== "withdrawn_after_failure"
          ) {
            const cleanup = this.control.serial(async () => {
              await this.conversation.commit(async (tx) => {
                const inbox = await tx.doc(InboxDoc, this.conversation.id);
                for (const item of inbox.items)
                  if (item.mode !== "write")
                    tx.settleSubmission(item.id, {
                      status: "unanswered",
                      reason: "withdrawn_after_failure",
                      detail:
                        typeof settled.detail === "string"
                          ? settled.detail
                          : settled.reason,
                    });
                inbox.items = inbox.items.filter(
                  (item) => item.mode === "write",
                );
              }, ctx);
              await this.control.abortCurrent();
            });
            this.emit({
              type: "error",
              message:
                typeof settled.detail === "string"
                  ? settled.detail
                  : settled.reason,
            });
            await cleanup;
          }
          this.emit({ type: "invalidated" });
        })
        .catch((error) => {
          logWarn("conversation.input.settlement_failed", {
            conversationId: String(this.conversation.id),
          });
          if (!this.control.closed)
            this.emit({
              type: "error",
              message: error instanceof Error ? error.message : "Reply failed.",
            });
        });
      return {
        submission: submissionReceipt(await handle.status(ctx)),
        duplicate: false,
      };
    });
  }
  abort(commandId?: string) {
    return this.control.abort(commandId);
  }
  dispose(): Promise<void> {
    return (this.closing ??= (async () => {
      await this.control.close();
      await this.view.close();
      this.listeners.clear();
    })());
  }

  private async applyMainModel() {
    const profile = this.config.main;
    if (!profile)
      throw new ModelConfigurationError("尚未选择主模型，请先在设置中选择一个模型。");
    const model = await requireAvailableModel(this.config.models, profile).catch(() => {
      throw new ModelConfigurationError("主模型当前不可用，请检查部署中的模型目录和凭据。");
    });
    const current = await this.conversation.agent(ctx);
    const thinking = profile.thinking ?? "off";
    if (current.model?.provider !== model.provider || current.model.modelId !== model.id || current.thinkingLevel !== thinking) {
      await this.harness.commit(
        (tx) => configureAgent(tx, this.conversation.id, {
          model: { provider: model.provider, modelId: model.id },
          thinkingLevel: thinking,
        }),
        ctx,
      );
      this.view.selected = { provider: model.provider, modelId: model.id };
    }
    return this.conversation.agent(ctx);
  }
  async describe(): Promise<RuntimeDescription> {
    const agent = await this.conversation.agent(ctx);
    const resources = await loadWorkspaceResources(this.paths);
    const tools = agent.tools.map((tool) => ({
      name: tool.name,
      status:
        tool.name === "web_search" && !this.searchConfigured
          ? ("unconfigured" as const)
          : ("available" as const),
    }));
    return {
      runtime: "pi-durable",
      tools,
      ...(agent.model && {
        selection: {
          provider: agent.model.provider,
          model: agent.model.modelId,
          thinking: agent.thinkingLevel,
        },
      }),
      models: (await this.config.models.getAvailable()).map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        imageInput: model.input.includes("image"),
        contextWindow: model.contextWindow,
        thinkingLevels: getSupportedThinkingLevels(
          model,
        ) as ModelThinkingLevel[],
      })),
      skills: resources.skills,
    };
  }
  async modelReady() {
    if (!this.config.main) return false;
    return (await this.config.models.getAvailable(this.config.main.provider))
      .some(model => model.id === this.config.main!.model);
  }

  private async requireCurrentAgent() {
    if (!this.config.main)
      throw new ModelConfigurationError("尚未选择主模型，请先在设置中选择一个模型。");
    if (!this.control.isBusy) return this.applyMainModel();
    const agent = await this.conversation.agent(ctx);
    if (!agent.model)
      throw new Error("当前会话尚未配置模型；本轮结束后将应用主模型设置。");
    await requireAvailableModel(this.config.models, {
      provider: agent.model.provider,
      model: agent.model.modelId,
    });
    return agent;
  }

  compact(): Promise<CompactionResult> {
    return this.control.maintain(async () => {
      const task = await this.conversation.compact(undefined, ctx);
      try {
        return await compactionResult(this.harness, task);
      } catch (error) {
        throw new CompactionExecutionError(
          error instanceof Error ? error.message : "Compaction failed.",
        );
      }
    });
  }
}
