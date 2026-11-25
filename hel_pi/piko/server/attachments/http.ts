import { AttachmentStore, MAX_ATTACHMENT_BYTES } from "./store";
import { json, readBody } from "../http";
import { audioPreviewResponse } from "./audio-preview";
import { attachmentTextPreview } from "./text-preview";

function contentDisposition(name: string): string {
  const fallback = name.replace(/[\u0000-\u001f\u007f"\\]/g, "_").replace(/[^\x20-\x7e]/g, "_") || "attachment";
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function attachmentRequest(
  request: Request,
  attachments: AttachmentStore,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname === "/api/attachments" && request.method === "POST") {
    const bytes = await readBody(
      request,
      MAX_ATTACHMENT_BYTES,
      "The attachment is too large.",
    );
    try {
      const saved = await attachments.save({
        bytes,
        name: url.searchParams.get("name") ?? undefined,
        mime: request.headers.get("content-type") ?? undefined,
      });
      return json(
        {
          id: saved.id,
          name: saved.id.split("/").at(-1),
          mime: saved.mime,
          bytes: saved.bytes,
          url: `/api/attachments/${encodeURIComponent(saved.id)}`,
        },
        201,
      );
    } catch (error) {
      return json(
        {
          error:
            error instanceof Error
              ? error.message
              : "The attachment was rejected.",
        },
        422,
      );
    }
  }
  if (
    (request.method === "GET" || (request.method === "HEAD" && url.searchParams.get("play") === "1")) &&
    url.pathname.startsWith("/api/attachments/")
  ) {
    let id: string;
    try {
      id = decodeURIComponent(url.pathname.slice("/api/attachments/".length));
    } catch {
      return json({ error: "Invalid attachment." }, 400);
    }
    const stored = await attachments.read(id);
    if (!stored) return json({ error: "Attachment not found." }, 404);
    if (url.searchParams.get("play") === "1") return audioPreviewResponse(request, stored.bytes, stored.attachment.mime);
    const name = id.split("/").at(-1)!;
    if (url.searchParams.get("preview") === "1") return attachmentTextPreview(name, stored.bytes);
    return new Response(stored.bytes.slice().buffer, {
      headers: {
        "Content-Type": stored.attachment.mime,
        "Content-Length": String(stored.attachment.bytes),
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        ...((url.searchParams.get("download") === "1" || !stored.attachment.mime.startsWith("image/")) && {
          "Content-Disposition": contentDisposition(name),
        }),
      },
    });
  }
  return undefined;
}
