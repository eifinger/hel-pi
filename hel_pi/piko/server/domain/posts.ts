import type { PostContent } from "../../shared/posts";
import { PREVIEW_EXCERPT_MAX_CHARS } from "./text-limits";

export class PostError extends Error {
  constructor(message: string, readonly status = 422, readonly code = "post_request_failed") { super(message); }
}

export function postId(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new PostError("帖子或生成记录不存在。", 404);
  return Number(value);
}

export function postExcerpt(body: string, limit = PREVIEW_EXCERPT_MAX_CHARS): string {
  const text = body.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#*_`>~]/g, "").replace(/\s+/g, " ").trim();
  const points = Array.from(text);
  const boundedLimit = Math.max(0, Math.floor(limit));
  return points.length > boundedLimit
    ? boundedLimit > 0 ? `${points.slice(0, boundedLimit - 1).join("")}…` : ""
    : text;
}

type PostDecision = ({ action: "publish" } & PostContent) | { action: "skip"; reason: string };

/** Only check the output contract. Research quality and repetition remain the agent's judgment. */
export function postDecision(text: string): PostDecision {
  let value: unknown;
  try { value = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1")); }
  catch { throw new PostError("帖子生成结果不是有效的 JSON。"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PostError("帖子生成结果格式不正确。");
  const input = value as Record<string, unknown>;
  if (typeof input.reason !== "string" || !input.reason.trim()) throw new PostError("帖子生成结果缺少理由。");
  if (input.action === "skip" && Object.keys(input).every(key => ["action", "reason"].includes(key)))
    return { action: "skip", reason: input.reason.trim() };
  if (input.action === "publish" && typeof input.title === "string" && input.title.trim() &&
    typeof input.body === "string" && input.body.trim() &&
    Object.keys(input).every(key => ["action", "title", "body", "reason"].includes(key)))
    return { action: "publish", title: input.title.trim(), body: input.body.trim(), reason: input.reason.trim() };
  throw new PostError("帖子生成结果需要标题、正文和生成理由。");
}
