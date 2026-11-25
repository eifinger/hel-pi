import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { Message, MessageEvent } from "../../shared/chat";
import { messageText } from "./pi-history";
import { SentAttachmentEntry, sentAttachmentMessage } from "./sent-attachments";
import { WidgetEntry, widgetMessage } from "./widgets";

type LiveAssistantMessage = Pick<
  AssistantMessage,
  "role" | "timestamp" | "content"
>;

/** Projects persisted entries and the current live message into Piko's stable message protocol. */
export class PiMessageEvents {
  private current?: Message;
  private currentTimestamp?: number;
  private seen = new Set<number>();
  private completed = new Set<string>();

  constructor(private readonly emit: (event: MessageEvent) => void) {}

  partial(entries: readonly EntryRecord[]): Message | undefined {
    // A history read may run ahead of view delivery and already contain this
    // generation's final entry.
    if (entries.some(
      entry => entry.kind === "pi.assistant" && !this.seen.has(entry.id),
    )) return undefined;
    return this.current && { ...this.current };
  }

  /** `initial` seeds historical entries without replaying them to current observers. */
  sync(entries: readonly EntryRecord[], live?: LiveAssistantMessage, initial = false) {
    for (const entry of entries) {
      if (entry.kind !== "pi.assistant" && !SentAttachmentEntry.is(entry) && !WidgetEntry.is(entry)) continue;
      if (initial) this.remember(entry);
      else this.complete(entry);
    }

    if (live?.role === "assistant") {
      const content = messageText(live.content);
      const signature = this.signature(live.timestamp, content);
      if (this.completed.has(signature)) {
        if (this.currentTimestamp === live.timestamp) this.clearCurrent();
        return;
      }
      if (this.currentTimestamp !== live.timestamp) {
        this.current = {
          id: `live-${crypto.randomUUID()}`,
          role: "assistant",
          content: "",
          createdAt: live.timestamp,
        };
        this.currentTimestamp = live.timestamp;
      }
      if (this.current && content !== this.current.content) {
        this.current = { ...this.current, content };
        this.emit({
          type: "message",
          message: { ...this.current },
          final: false,
        });
      }
    } else if (this.current) {
      // A stream can be interrupted before a persisted assistant entry is visible.
      this.emit({
        type: "message",
        message: { ...this.current, content: "" },
        final: true,
      });
      this.clearCurrent();
    }
  }

  private complete(entry: EntryRecord) {
    if (this.seen.has(entry.id)) return;
    if (WidgetEntry.is(entry)) {
      this.seen.add(entry.id);
      this.emit({ type: "message", message: widgetMessage(entry.id, entry.data), final: true });
      return;
    }
    if (SentAttachmentEntry.is(entry)) {
      this.seen.add(entry.id);
      this.emit({ type: "message", message: sentAttachmentMessage(entry.id, entry.data), final: true });
      return;
    }
    const message = entry.model?.[0];
    if (message?.role !== "assistant") return;
    this.remember(entry);
    const content = messageText(message.content);
    const previousId = this.currentTimestamp === message.timestamp
      ? this.current?.id
      : undefined;
    this.emit({
      type: "message",
      message: {
        id: String(entry.id),
        role: "assistant",
        content,
        createdAt: message.timestamp,
      },
      final: true,
      ...(previousId && { previousId }),
    });
    if (previousId) this.clearCurrent();
  }

  private remember(entry: EntryRecord) {
    this.seen.add(entry.id);
    const message = entry.model?.[0];
    if (message?.role === "assistant")
      this.completed.add(this.signature(message.timestamp, messageText(message.content)));
  }

  private signature(timestamp: number, content: string) {
    return `${timestamp}\u0000${content}`;
  }

  private clearCurrent() {
    this.current = undefined;
    this.currentTimestamp = undefined;
  }
}
