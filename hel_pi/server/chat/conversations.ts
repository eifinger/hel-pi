import {
  CHAT_PAGE_SIZE,
  type ConversationResponse,
  type StreamEvent,
} from "../../shared/chat";
import type {
  BackgroundReply,
  InputSource,
  ConversationRuntime,
  ChatSession,
  SessionEvent,
} from "../runtime/types";
import { normalizeMessage } from "./input";
/** Conversation-wide observation. The runtime owns input ordering and maintenance. */
export class ConversationStore {
  private listeners = new Set<(event: StreamEvent) => void>();
  private opening?: Promise<ChatSession>;
  private session?: ChatSession;
  private unsubscribe?: () => void;
  private closing = false;
  private pump?: Promise<void>;
  private dirty = false;
  private messages = new Map<
    string,
    Extract<StreamEvent, { type: "message" }>
  >();
  private runEnds: Extract<StreamEvent, { type: "run-end" }>[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    readonly runtime: Pick<ConversationRuntime, "createSession">,
    readonly conversationId?: string,
  ) {}
  get size() {
    return this.session ? 1 : 0;
  }
  isStreaming() {
    return this.session?.isStreaming ?? false;
  }
  async get(): Promise<ChatSession> {
    if (this.closing) throw new Error("Piko is shutting down.");
    return (this.opening ??= this.runtime
      .createSession(this.conversationId)
      .then((session) => {
        if (this.closing) throw new Error("Conversation is closed.");
        this.session = session;
        this.unsubscribe = session.subscribe(event => this.receive(event));
        return session;
      })
      .catch((error) => {
        this.opening = undefined;
        throw error;
      }));
  }
  /** Exhaustive projection: runtime facts never accidentally become wire events. */
  private receive(event: SessionEvent) {
    switch (event.type) {
      case "tool":
      case "input-applied":
      case "compaction": return;
      case "activity":
      case "error": this.publish(event); return;
      case "deleted": this.publish(event); void this.close(); return;
      case "message":
        if (event.previousId) this.messages.delete(event.previousId);
        this.messages.set(event.message.id, event);
        break;
      case "run-end":
        this.runEnds.push(event);
        this.dirty = true;
        break;
      case "run-start":
      case "invalidated": this.dirty = true; break;
      default: { const exhaustive: never = event; return exhaustive; }
    }
    if (!this.timer) this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, 50);
  }
  private publish(event: StreamEvent) {
    if (this.closing) return;
    for (const listener of this.listeners) listener(event);
  }
  /** Coalesce output into consistent conversation snapshots, never per-input replies. */
  async flush() {
    if (this.pump) return this.pump;
    this.pump = (async () => {
      while ((this.dirty || this.messages.size || this.runEnds.length) && !this.closing) {
        const messages = [...this.messages.values()];
        this.messages.clear();
        for (const message of messages) this.publish(message);
        if (this.dirty) {
          this.dirty = false;
          const conversation = await (
            await this.get()
          ).snapshot({ limit: CHAT_PAGE_SIZE });
          this.publish({ type: "snapshot", conversation });
        }
        const runEnds = this.runEnds.splice(0);
        for (const event of runEnds) this.publish(event);
      }
    })()
      .catch((error) =>
        this.publish({
          type: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not read conversation.",
        }),
      )
      .finally(() => {
        this.pump = undefined;
      });
    return this.pump;
  }
  async snapshot(options?: { limit: number }): Promise<ConversationResponse> {
    return (await this.get()).snapshot(options);
  }
  async history(before?: string) {
    return (await this.get()).history(before, CHAT_PAGE_SIZE);
  }
  async submit(
    message: string,
    requestId: string,
    source?: InputSource,
    attachments?: readonly string[],
  ) {
    message = normalizeMessage(message, !!attachments?.length);
    const result = await (
      await this.get()
    ).submit(message, requestId, source, attachments);
    this.dirty = true;
    await this.flush();
    return result;
  }
  async subscribeBackgroundReplies(
    listener: (reply: BackgroundReply) => Promise<void>,
  ) {
    return (await this.get()).subscribeBackgroundReplies(listener);
  }
  /** Telegram gets one ordered runtime feed, seeded without replaying historical output. */
  async observeRuntime(listener: (event: SessionEvent | { type: "snapshot"; conversation: ConversationResponse }) => void): Promise<() => void> {
    const session = await this.get();
    let buffering = true;
    const pending: SessionEvent[] = [];
    const unsubscribe = session.subscribe(event => {
      if (buffering) pending.push(event);
      else listener(event);
    });
    try {
      listener({ type: "snapshot", conversation: await session.snapshot({ limit: CHAT_PAGE_SIZE }) });
      for (const event of pending) listener(event);
      buffering = false;
      return unsubscribe;
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }
  async stop(commandId?: string) {
    const result = await (await this.get()).abort(commandId);
    this.dirty = true;
    await this.flush();
    return result;
  }
  async changeRuntime<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      this.dirty = true;
      await this.flush();
    }
  }
  /** Initial state joins the same publication line as live updates, avoiding snapshot/live-update races. */
  async observe(listener: (event: StreamEvent) => void): Promise<() => void> {
    await this.get();
    let buffering = true;
    const pending: StreamEvent[] = [];
    const receive = (event: StreamEvent) => {
      if (buffering) pending.push(event);
      else listener(event);
    };
    this.listeners.add(receive);
    try {
      this.dirty = true;
      await this.flush();
      // A finished pump may still be clearing its promise when observation is attached.
      if (!pending.some((event) => event.type === "snapshot"))
        await this.flush();
      const index = pending.findLastIndex((event) => event.type === "snapshot");
      if (index < 0) throw new Error("Could not read conversation snapshot.");
      for (const event of pending.slice(index)) listener(event);
      buffering = false;
      return () => {
        this.listeners.delete(receive);
      };
    } catch (error) {
      this.listeners.delete(receive);
      throw error;
    }
  }
  async close() {
    if (this.closing) return;
    this.closing = true;
    // Runtime owns controllers and execution. Closing an observer only detaches output.
    await this.opening?.catch(() => {});
    clearTimeout(this.timer);
    this.unsubscribe?.();
    await this.pump;
    this.messages.clear();
    this.listeners.clear();
    this.session = undefined;
    this.opening = undefined;
    this.unsubscribe = undefined;
  }
}
