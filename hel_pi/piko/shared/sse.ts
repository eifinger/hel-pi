import type { StreamEvent } from "./chat";
import { decodeConversationEvent } from "./conversation-events";

export function encodeSse(event: StreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** SSE framing only; the public event contract is validated in conversation-events.ts. */
export function consumeSse(buffer: string, flush = false): { events: StreamEvent[]; remainder: string } {
  const blocks = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const remainder = flush ? "" : (blocks.pop() ?? "");
  const events: StreamEvent[] = [];
  for (const block of blocks) {
    const data = block.split("\n").filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data) continue;
    const event = decodeConversationEvent(JSON.parse(data));
    if (event) events.push(event);
  }
  return { events, remainder };
}
