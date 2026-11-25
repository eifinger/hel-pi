import { defineExtension, defineTool, ROOT_CONVERSATION_ID, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { postHistoryScope } from "./documents";
import { postPage, readPost, searchPosts } from "./queries";

async function allowed(api: ToolExecutionApi, context: Context) {
  return api.conversationId === ROOT_CONVERSATION_ID || !!await api.commit(tx => postHistoryScope(tx, api.conversationId), context);
}
const output = (value: object, isError = false) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }], isError });

export function createPostTools(options: { includeSearch?: boolean; recentOnlyRead?: boolean } = {}) {
  const tools = [
    ...(options.includeSearch === false ? [] : [defineTool({
      name: "posts_search", replay: "unsafe",
      description: "Search published private posts by literal keywords. Use this to check what has already been published, then posts_read to inspect a result. All whitespace-separated terms must occur in the post title, body or reason.",
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 4096 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })) }, { additionalProperties: false }),
      execute: async (args, api, context) => {
        if (!await allowed(api, context)) return output({ error: "Post search is not available in this conversation." }, true);
        if (!args.query.trim()) return output({ error: "Search terms are required." }, true);
        return output(await api.commit(tx => searchPosts(tx, args.query, args.limit ?? 10), context));
      },
    })]),
    defineTool({
      name: "posts_read", replay: "unsafe",
      description: options.recentOnlyRead
        ? "Read the title, Markdown body and generation reason of a post from the ten recent posts supplied in the initial context."
        : "Read the title, Markdown body and generation reason of one published post returned by posts_search or the initial context.",
      parameters: Type.Object({ postId: Type.String({ pattern: "^[1-9]\\d*$" }) }, { additionalProperties: false }),
      execute: async (args, api, context) => {
        if (!await allowed(api, context)) return output({ error: "Post reading is not available in this conversation." }, true);
        if (options.recentOnlyRead && api.conversationId !== ROOT_CONVERSATION_ID) {
          const recent = await api.commit(tx => postPage(tx, undefined, 10), context);
          if (!recent.posts.some(post => post.id === args.postId))
            return output({ error: "Post is outside the ten recent posts supplied to this researcher." }, true);
        }
        try { return output(await api.commit(tx => readPost(tx, args.postId), context)); }
        catch { return output({ error: "Published post not found." }, true); }
      },
    }),
  ];
  return defineExtension({ name: options.recentOnlyRead ? "piko-posts-research" : "piko-posts", tools });
}
