export type PostContent = { title: string; body: string; reason: string };
export type Post = PostContent & { id: string; createdAt: number };
export type PostSummary = { id: string; title: string; excerpt: string; reason: string; createdAt: number };
export type PostPage = { posts: PostSummary[]; nextBefore?: string };
export type PostGeneration = {
  id: string;
  status: "running" | "stopping" | "completed" | "skipped" | "failed" | "stopped";
  postId?: string;
  reason?: string;
};
export type GeneratePost = { requestId: string };
