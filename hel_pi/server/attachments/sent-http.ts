import { AttachmentStore, detectExtension, safeAttachmentName } from "./store";
import { audioPreviewResponse } from "./audio-preview";
import { attachmentTextPreview } from "./text-preview";
import { json } from "../http";

/** Outgoing snapshot IDs never contain user-provided paths; the name is only a download hint. */
export async function sentAttachmentRequest(request: Request, store: AttachmentStore): Promise<Response | undefined> {
  const url = new URL(request.url);
  if ((request.method !== "GET" && request.method !== "HEAD") || !url.pathname.startsWith("/api/sent-attachments/")) return undefined;
  const id = url.pathname.slice("/api/sent-attachments/".length);
  const bytes = await store.readSnapshot(id);
  if (!bytes) return json({ error: "Attachment not found." }, 404);
  const name = safeAttachmentName(url.searchParams.get("name") ?? undefined) ?? "attachment";
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  if (url.searchParams.get("play") === "1") return audioPreviewResponse(request, bytes, detectExtension(name));
  if (url.searchParams.get("preview") === "1") return attachmentTextPreview(name, bytes);
  return new Response(request.method === "HEAD" ? null : new Uint8Array(bytes).buffer, { headers: {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(bytes.length),
    "Content-Disposition": `attachment; filename="attachment"; filename*=UTF-8''${encoded}`,
    "Cache-Control": "private, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  } });
}
