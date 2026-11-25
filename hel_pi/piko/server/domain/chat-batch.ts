export type ChatBatchMessage = { role: "user" | "assistant"; date: string; content: string };
/** Target Unicode-codepoint budget per curation batch; an atomic entry may exceed it rather than lose text. */
export const CHAT_BATCH_MAX_INPUT_CHARS = 64_000;

export function localDate(timestamp: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(timestamp);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}
