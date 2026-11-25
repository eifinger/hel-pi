import { ROOT_CONVERSATION_ID, type Cursor, type EntryId, type Tx } from "@earendil-works/pi-durable";
import type { Post, PostPage, PostSummary } from "../../../shared/posts";
import { PostError, postExcerpt, postId } from "../../domain/posts";
import { PublishedPost } from "./documents";

export async function readPost(tx: Tx, id: string): Promise<Post> {
  const entry = await tx.entry(PublishedPost, postId(id) as EntryId);
  if (!entry || entry.conversationId !== ROOT_CONVERSATION_ID) throw new PostError("帖子不存在。", 404);
  return { id: String(entry.id), title: entry.data.title, body: entry.data.body, reason: entry.data.reason, createdAt: entry.data.createdAt };
}

export async function postPage(tx: Tx, before?: string, limit = 20): Promise<PostPage> {
  const posts: PostSummary[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "descending",
      ...(before && { maxEntryId: (postId(before) - 1) as EntryId }) }, 100, cursor);
    for (const entry of page.items) {
      if (!PublishedPost.is(entry)) continue;
      if (posts.length === limit) return { posts, nextBefore: posts.at(-1)!.id };
      posts.push({ id: String(entry.id), title: entry.data.title, excerpt: postExcerpt(entry.data.body), reason: entry.data.reason, createdAt: entry.data.createdAt });
    }
    cursor = page.next;
  } while (cursor);
  return { posts };
}

/** Literal keyword search over original published entries, not a semantic duplicate gate. */
export async function searchPosts(tx: Tx, query: string, limit: number) {
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase();
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return { posts: [], truncated: false };
  const posts: PostSummary[] = [];
  let cursor: Cursor | undefined;
  let matches = 0;
  do {
    const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "descending" }, 100, cursor);
    for (const entry of page.items) {
      if (!PublishedPost.is(entry)) continue;
      const text = normalize(`${entry.data.title}\n${entry.data.body}\n${entry.data.reason}`);
      if (!terms.every(term => text.includes(term))) continue;
      matches++;
      if (posts.length < limit) posts.push({ id: String(entry.id), title: entry.data.title, excerpt: postExcerpt(entry.data.body), reason: entry.data.reason, createdAt: entry.data.createdAt });
    }
    cursor = page.next;
  } while (cursor);
  return { posts, truncated: matches > limit };
}
