import { isRequestId } from "../../shared/chat";
import { PostError, postId } from "../domain/posts";
import { json, readObjectBody } from "../http";
import type { PostsRuntimeAccess } from "../runtime/types";

export async function postRequest(request: Request, runtime: PostsRuntimeAccess, maxBytes: number): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/posts" && !url.pathname.startsWith("/api/posts/")) return undefined;
  const parts = url.pathname.split("/").slice(3);
  if (request.method === "POST" && parts.length === 1 && parts[0] === "generations") {
    const input = await readObjectBody(request, maxBytes);
    if (!isRequestId(input.requestId) || Object.keys(input).some(key => key !== "requestId"))
      throw new PostError("需要 requestId，且不接受其他字段。");
    return json(await (await runtime.posts()).generate({ requestId: input.requestId }), 202);
  }
  if (parts[0] === "generations" && parts[1]) {
    const id = parts[1]; postId(id);
    if (request.method === "GET" && parts.length === 2) return json(await (await runtime.posts()).generation(id));
    if (request.method === "POST" && parts.length === 3 && parts[2] === "stop") return json(await (await runtime.posts()).stop(id));
  }
  if (request.method === "GET" && !parts.length) {
    const before = url.searchParams.get("before") ?? undefined;
    if (before) postId(before);
    const limit = Number(url.searchParams.get("limit") ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new PostError("limit 应为 1–50。");
    return json(await (await runtime.posts()).list(before, limit));
  }
  if (request.method === "GET" && parts.length === 1) return json(await (await runtime.posts()).read(parts[0]!));
  if (request.method === "DELETE" && parts.length === 1 && parts[0] !== "generations") {
    postId(parts[0]!);
    await (await runtime.posts()).remove(parts[0]!);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
  return json({ error: "Not found." }, 404);
}
