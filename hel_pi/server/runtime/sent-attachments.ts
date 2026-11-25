import { defineEntry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { Message, MessageAttachment } from "../../shared/chat";
import { AttachmentStore, MAX_ATTACHMENT_BYTES } from "../attachments/store";

export type SentAttachment = { id: string; name: string; mime: string; bytes: number; createdAt: number };
export const SentAttachmentEntry = defineEntry<SentAttachment>("piko.chat-attachment");

export function sentAttachmentMessage(id: number, value: SentAttachment): Message {
  const attachment: MessageAttachment = {
    id: value.id, name: value.name, mime: value.mime,
    url: `/api/sent-attachments/${value.id}?name=${encodeURIComponent(value.name)}`,
  };
  return { id: String(id), role: "assistant", content: "", createdAt: value.createdAt, attachments: [attachment] };
}

/** Store and publish a snapshot in the current user conversation; no channel-specific delivery. */
export function createSentAttachmentTools(store: AttachmentStore) {
  const failure = (message: string) => ({ output: [{ type: "text" as const, text: message }], isError: true });
  const path = Type.String({ minLength: 1, maxLength: 4096, description: "Absolute path to the file." });
  const attachment = defineTool({
    name: "send_attachment", replay: "unsafe",
    description: "Send a local file as an attachment in the current chat.",
    parameters: Type.Object({ path }, { additionalProperties: false }),
    execute: async (args, api, context) => {
      const { path } = args;
      if (!path.startsWith("/")) return failure("An absolute local file path is required.");
      let saved: Awaited<ReturnType<AttachmentStore["saveSnapshot"]>>;
      try { saved = await store.saveSnapshot(path); }
      catch { return failure(`Cannot read or save the file. Ensure it is a regular nonempty file no larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MiB.`); }
      // After a commit is attempted, keep the snapshot on an ambiguous failure: it may already be referenced.
      if (context.abortSignal?.aborted) { await store.discardSnapshot(saved.id); return failure("Attachment publication cancelled."); }
      const data: SentAttachment = { ...saved, createdAt: api.now() };
      await api.commit(tx => tx.appendEntry(SentAttachmentEntry, api.conversationId, { data }), context);
      return { output: [{ type: "text" as const, text: "Attachment sent." }] };
    },
  });
  return defineExtension({ name: "piko-sent-attachments", tools: [attachment] });
}
