import { isRequestId } from "../../shared/chat";
import type { SideChatsRuntime } from "../runtime/types";
import { json, readObjectBody } from "../http";

export async function sideChatRequest(
  request: Request,
  runtime: SideChatsRuntime,
  forget?: (id: string) => Promise<void>,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const generateTitle = /^\/api\/side-chats\/([^/]+)\/title\/generate$/.exec(url.pathname);
  if (generateTitle) {
    if (request.method !== "POST") return json({ error: "Not found." }, 404);
    const input = await readObjectBody(request, 8000);
    if (
      Object.keys(input).some(key => key !== "requestIds" && key !== "onlyIfEmpty") ||
      input.onlyIfEmpty !== undefined && typeof input.onlyIfEmpty !== "boolean" ||
      input.requestIds !== undefined &&
        (!Array.isArray(input.requestIds) || input.requestIds.length > 50 ||
          !input.requestIds.every(isRequestId))
    )
      return json({ error: "Invalid title generation request." }, 422);
    return json(await runtime.sideChats.generateTitle(
      generateTitle[1]!,
      input.requestIds as string[] | undefined,
      request.signal,
      input.onlyIfEmpty === undefined
        ? Array.isArray(input.requestIds) && input.requestIds.length > 0
        : input.onlyIfEmpty as boolean,
    ));
  }
  if (
    url.pathname === "/api/side-chats" ||
    /^\/api\/side-chats\/[^/]+$/.test(url.pathname)
  ) {
    if (request.method === "GET" && url.pathname === "/api/side-chats")
      return json(await runtime.sideChats.list());
    if (request.method === "DELETE" && url.pathname !== "/api/side-chats") {
      const id = url.pathname.split("/").at(-1)!;
      await runtime.sideChats.remove(id);
      await forget?.(id);
      return new Response(null, { status: 204 });
    }
    if (request.method !== "POST") return json({ error: "Not found." }, 404);
    const input = await readObjectBody(request, 8000);
    if (url.pathname === "/api/side-chats") {
      if (
        !isRequestId(input.requestId) ||
        Object.keys(input).some((key) => key !== "requestId")
      )
        return json({ error: "A requestId is required." }, 422);
      return json(
        await runtime.sideChats.create(input.requestId),
        201,
      );
    }
    return json({ error: "Not found." }, 404);
  }
  return undefined;
}
