import type { Context } from "@earendil-works/chord/context";
import {
  defineExtension,
  defineTool,
  type ConversationId,
  type ToolExecutionApi,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { SessionHistoryWindow, SessionSearchHit } from "./pi-history";
import { isUserConversation } from "./subagents/delegations";

const SEARCH_DEFAULT_LIMIT = 10;
const SEARCH_MAX_LIMIT = 25;
const HISTORY_DEFAULT_LIMIT = 10;
const HISTORY_MAX_LIMIT = 20;

type HistoryScope = { conversationId: ConversationId };
type SessionHistoryAccess = {
  backgroundScope?: (api: ToolExecutionApi, ctx: Context) => Promise<HistoryScope | undefined>;
  search: (conversationId: ConversationId, query: string, limit: number) => Promise<{
    results: SessionSearchHit[];
    truncated: boolean;
  }>;
  history: (conversationId: ConversationId, messageId: string, limit: number) => Promise<SessionHistoryWindow | undefined>;
};

function output(value: object): ToolExecutionResult {
  return { output: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(message: string): ToolExecutionResult {
  return { ...output({ status: "error", error: message }), isError: true };
}

async function userSession(api: ToolExecutionApi, ctx: Context): Promise<boolean> {
  return api.commit(tx => isUserConversation(tx, api.conversationId), ctx);
}

/** Current-session transcript search and anchored history reads for the main chat and active side chats. */
export function createSessionSearchTools(access: SessionHistoryAccess) {
  const scopeFor = async (api: ToolExecutionApi, ctx: Context): Promise<HistoryScope | undefined> =>
    await userSession(api, ctx) ? { conversationId: api.conversationId } : access.backgroundScope?.(api, ctx);
  const sessionsSearch = defineTool({
    name: "sessions_search",
    replay: "unsafe",
    description:
      "Search visible user and assistant messages in the current conversation or authorized main-chat history. Tool output and attachment contents are not searched. Space-separated keywords match literally (any keyword); more distinct matches rank first, then newer messages. Chinese is not automatically segmented. Use sessions_history to read context around a result.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 4096, description: "Space-separated keywords to search for." }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: SEARCH_MAX_LIMIT,
        description: `Maximum results to return (default ${SEARCH_DEFAULT_LIMIT}, max ${SEARCH_MAX_LIMIT}).` })),
    }, { additionalProperties: false }),
    execute: async (args, api, ctx) => {
      const query = args.query.trim();
      if (!query) return failure("query must not be empty.");
      const scope = await scopeFor(api, ctx);
      if (!scope) return failure("Session search is not available in this conversation.");
      try {
        const result = await access.search(scope.conversationId, query, args.limit ?? SEARCH_DEFAULT_LIMIT);
        return output({ sessionId: String(scope.conversationId), ...result });
      } catch {
        return failure("Could not search this conversation's history.");
      }
    },
  });

  const sessionsHistory = defineTool({
    name: "sessions_history",
    replay: "unsafe",
    description:
      "Read visible messages around a sessions_search result. Pass its sessionId and messageId; use an ID from the returned messages to continue reading.",
    parameters: Type.Object({
      sessionId: Type.String({ minLength: 1, description: "Session ID returned by sessions_search." }),
      messageId: Type.String({ pattern: "^[1-9]\\d*$", description: "Message ID returned by sessions_search or sessions_history, without a prefix." }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: HISTORY_MAX_LIMIT,
        description: `Maximum total messages including the anchor (default ${HISTORY_DEFAULT_LIMIT}, max ${HISTORY_MAX_LIMIT}).` })),
    }, { additionalProperties: false }),
    execute: async (args, api, ctx) => {
      const scope = await scopeFor(api, ctx);
      if (!scope || args.sessionId !== String(scope.conversationId))
        return failure("sessions_history can only read the host-authorized conversation.");
      try {
        const history = await access.history(scope.conversationId, args.messageId, args.limit ?? HISTORY_DEFAULT_LIMIT);
        return history
          ? output({ sessionId: String(scope.conversationId), messageId: args.messageId, ...history })
          : failure("Message not found in visible history for this conversation.");
      } catch {
        return failure("Could not read this conversation's history.");
      }
    },
  });

  return defineExtension({ name: "piko-session-search", tools: [sessionsSearch, sessionsHistory] });
}
