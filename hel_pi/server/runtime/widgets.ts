import { deflateSync } from "node:zlib";
import { defineEntry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { Message } from "../../shared/chat";

/** Self-contained Telegram Widget source is the durable message content. */
export type PublishedWidget = { version: 1; html: string; createdAt: number };
export const WidgetEntry = defineEntry<PublishedWidget>("piko.widget");

export function widgetMessage(id: number, value: PublishedWidget): Message {
  return { id: String(id), role: "assistant", content: "", createdAt: value.createdAt,
    widget: { version: value.version, html: value.html } };
}

/** Telegram counts UTF-8 bytes and zlib level 9, not characters or gzip bytes. */
export function validateWidgetHtml(html: string): string | undefined {
  if (!html.trim()) return "Widget HTML must not be empty.";
  if (html.includes("\0") || !html.isWellFormed()) return "Widget HTML must be valid Unicode without NUL characters.";
  const bytes = Buffer.from(html, "utf8");
  if (bytes.byteLength > 32768) return "Widget HTML exceeds the 32768-byte UTF-8 limit.";
  if (deflateSync(bytes, { level: 9 }).byteLength > 4096) return "Widget HTML exceeds the 4096-byte compressed limit; simplify it.";
}

/** Deliberately not installed in the runtime while Telegram restricts widget delivery. */
export function createWidgetTools() {
  return defineExtension({ name: "piko-widgets", tools: [defineTool({
    name: "show_widget", replay: "unsafe",
    description: "Publish a self-contained HTML widget as a message in the current conversation. Follow Telegram Widget profile 1: inline HTML, CSS, SVG and JavaScript only; no network, external resources, keyboard, or scrolling. Content must fit a phone-sized bubble (height at most 600px). No Piko actions or bot requests. HTML must fit 32768 UTF-8 bytes and 4096 bytes compressed with zlib level 9. Keep it compact and readable; use chat theme CSS variables. The widget is sent to Telegram when this is the main conversation. App rendering is not available yet.",
    parameters: Type.Object({ html: Type.String({ minLength: 1, maxLength: 32768, description: "Self-contained Telegram Widget HTML. Include any styles or scripts inline." }) }, { additionalProperties: false }),
    execute: async ({ html }, api, context) => {
      const error = validateWidgetHtml(html);
      if (error) return { output: [{ type: "text" as const, text: error }], isError: true };
      if (context.abortSignal?.aborted) return { output: [{ type: "text" as const, text: "Widget publication cancelled." }], isError: true };
      await api.commit(tx => tx.appendEntry(WidgetEntry, api.conversationId, { data: { version: 1, html, createdAt: api.now() } }), context);
      return { output: [{ type: "text" as const, text: "Widget published to the conversation. Delivery to a channel is not guaranteed." }] };
    },
  })] });
}
