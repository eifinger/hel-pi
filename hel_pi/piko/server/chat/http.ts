import {
  CHAT_PAGE_SIZE,
  MAX_ATTACHMENTS,
  isHistoryCursor,
  isRequestId,
} from "../../shared/chat";
import type { AttachmentStore } from "../attachments/store";
import type { ConversationStores } from "./stores";
import { chatStream } from "./stream";
import { json, readObjectBody } from "../http";

export async function chatRequest(
  request: Request,
  chats: ConversationStores,
  attachments: AttachmentStore,
  maxBytes: number,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const side =
    /^\/api\/side-chats\/([^/]+)(\/chat(?:\/history|\/events|\/stop)?)$/.exec(
      url.pathname,
    );
  const path = side ? `/api${side[2]}` : url.pathname;
  if (!/^\/api\/chat(?:\/history|\/events|\/stop)?$/.test(path))
    return undefined;
  const conversations = side ? await chats.side(side[1]!) : chats.main;
  if (request.method === "GET" && path === "/api/chat")
    return json(await conversations.snapshot({ limit: CHAT_PAGE_SIZE }));
  if (request.method === "GET" && path === "/api/chat/history") {
    const before = url.searchParams.get("before") ?? undefined;
    if (before !== undefined && !isHistoryCursor(before))
      return json({ error: "Invalid history cursor." }, 422);
    return json(await conversations.history(before));
  }
  if (request.method === "GET" && path === "/api/chat/events")
    return chatStream(conversations, request);
  if (
    request.method === "POST" &&
    (path === "/api/chat" || path === "/api/chat/stop")
  ) {
    const input = await readObjectBody(request, maxBytes);
    if (!isRequestId(input.requestId))
      return json({ error: "A requestId is required." }, 422);
    if (request.signal.aborted) return new Response(null, { status: 499 });
    if (path.endsWith("/stop"))
      return json({
        ok: true,
        stopped: await conversations.stop(input.requestId),
      });
    const ids = input.attachmentIds === undefined ? [] : input.attachmentIds;
    if (
      !Array.isArray(ids) ||
      ids.length > MAX_ATTACHMENTS ||
      !ids.every((id) => typeof id === "string")
    )
      return json({ error: "Invalid attachments." }, 422);
    const paths: string[] = [];
    for (const id of ids as string[]) {
      const stored = await attachments.lookup(id);
      if (!stored) return json({ error: "Attachment not found." }, 422);
      paths.push(stored.path);
    }
    if (
      typeof input.message !== "string" ||
      (!input.message.trim() && !paths.length)
    )
      return json({ error: "Message or attachment is required." }, 422);
    return json(
      await conversations.submit(
        input.message,
        input.requestId,
        undefined,
        paths,
      ),
    );
  }
  return undefined;
}
