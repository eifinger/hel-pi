import { encodeSse } from "../../shared/sse";
import type { ConversationStore } from "./conversations";
/** Closing an observer never cancels the conversation. */
export function chatStream(store: ConversationStore, request: Request): Response {
  let cleanup = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder(); let closed = false; let unsubscribe: (() => void) | undefined;
      const close = () => { if (closed) return; closed = true; unsubscribe?.(); clearInterval(heartbeat); request.signal.removeEventListener("abort", close); try { controller.close(); } catch {} };
      const heartbeat = setInterval(() => { if ((controller.desiredSize ?? 0) <= 0) { close(); return; } try { controller.enqueue(encoder.encode(": heartbeat\n\n")); } catch { close(); } }, 15000);
      cleanup = close; request.signal.addEventListener("abort", close, { once: true });
      if (request.signal.aborted) { close(); return; }
      void store.observe(event => {
        if (closed) return;
        if ((controller.desiredSize ?? 0) <= 0) { close(); return; }
        try { controller.enqueue(encoder.encode(encodeSse(event))); if (event.type === "deleted") close(); } catch { close(); }
      }).then(stop => { unsubscribe = stop; if (closed) stop(); }).catch(() => close());
    },
    cancel() { cleanup(); },
  }, { highWaterMark: 256 * 1024, size: chunk => chunk?.byteLength ?? 0 });
  return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}
