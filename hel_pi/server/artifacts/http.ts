import { ArtifactError, ArtifactStore } from "./store";
import { json } from "../http";

function contentDisposition(name: string) {
  const fallback = name.replace(/[\u0000-\u001f\u007f"\\]/g, "_").replace(/[^\x20-\x7e]/g, "_") || "download";
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function artifactRequest(
  request: Request,
  artifacts: ArtifactStore,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.searchParams.get("path") ?? "";
  try {
    if (request.method === "GET" && url.pathname === "/api/artifacts")
      return json(await artifacts.list(path));
    if (request.method === "DELETE" && url.pathname === "/api/artifacts")
      return json(await artifacts.delete(path));
    if (request.method === "GET" && url.pathname === "/api/artifacts/content")
      return json(await artifacts.preview(path));
    if (request.method === "GET" && url.pathname === "/api/artifacts/download") {
      const file = await artifacts.download(path);
      return new Response(file.bytes, {
        headers: {
          "Content-Type": file.mimeType,
          "Content-Length": String(file.size),
          "Content-Disposition": contentDisposition(file.name),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    if (url.pathname === "/api/artifacts" || url.pathname.startsWith("/api/artifacts/"))
      return json({ error: "Not found." }, 404);
    return undefined;
  } catch (error) {
    if (error instanceof ArtifactError) return json({ error: error.message }, error.status);
    throw error;
  }
}
