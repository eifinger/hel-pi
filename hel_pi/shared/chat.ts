import type { ActiveCompaction } from "./runtime";
/** A stored attachment; the model sees its path, the UI only needs the served URL. */
export type MessageAttachment = { id: string; url: string; mime: string; name?: string };
export type MessageWidget = { version: 1; html: string };
export type Message = { id: string; role: "user" | "assistant"; content: string; createdAt: number; requestId?: string; attachments?: MessageAttachment[]; widget?: MessageWidget };
export type SubmissionReceipt = { id: string; requestId?: string; status: "queued" | "placed" | "done" | "unanswered"; error?: string };
export const CHAT_PAGE_SIZE = 20;
/** Images a single message may carry; each one is read by the model as a separate file. */
export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export type HistoryPage = { messages: Message[]; nextBefore?: string };
/** Prompt size of the last model call; a reference point, not a live token count. */
export type ChatUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; contextWindow?: number; ratio?: number };
/** A transient projection of native execution state, not another persisted run record. */
export type ConversationActivity = { kind: "idle" | "thinking" | "replying" } | { kind: "tool"; name: string; summary?: string };
export type MessageEvent = { type: "message"; message: Message; final: boolean; previousId?: string };
/** A snapshot's history window is authoritative; older pages remain client-side. */
export type ConversationResponse = { messages: Message[]; history?: { nextBefore?: string }; busy: boolean; activity: ConversationActivity; latest?: SubmissionReceipt; interruption?: string; previousIds?: Record<string, string>; usage?: ChatUsage; compactions?: ActiveCompaction[] };
export function isHistoryCursor(value: string): boolean { return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)); }
export type StreamEvent =
  | MessageEvent
  | { type: "run-end"; submissions: readonly SubmissionReceipt[] }
  | { type: "activity"; activity: ConversationActivity }
  | { type: "deleted" }
  | { type: "snapshot"; conversation: ConversationResponse }
  | { type: "error"; message: string };
export type HealthResponse = { ok: boolean; app: "Piko"; runtime: "Pi"; modelReady: boolean; activeSessions: number };
export function isRequestId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 250 && !value.startsWith("piko:"); }
