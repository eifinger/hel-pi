export const SUMMARY_TEXT_LIMIT = 100;
export const DETAIL_TEXT_LIMIT = 160;

/** Truncate by Unicode code point, keeping the suffix inside the requested limit. */
export function truncateText(value: string, limit: number, suffix = "..."): string {
  const boundedLimit = Math.max(0, Math.floor(limit));
  const prefix: string[] = [];
  for (const char of value) {
    if (prefix.length === boundedLimit) {
      const ending = Array.from(suffix).slice(0, boundedLimit);
      const contentLimit = Math.max(0, boundedLimit - ending.length);
      return `${prefix.slice(0, contentLimit).join("")}${ending.join("")}`;
    }
    prefix.push(char);
  }
  return value;
}

/** Bound UTF-16 code units for Telegram messages without splitting surrogate pairs. */
export function truncateUtf16Text(value: string, limit: number, suffix = "..."): string {
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (value.length <= boundedLimit) return value;

  const safePrefix = (text: string, maxUnits: number) => {
    let end = Math.min(text.length, maxUnits);
    if (end > 0) {
      const last = text.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end--;
    }
    return text.slice(0, end);
  };
  const ending = safePrefix(suffix, boundedLimit);
  const contentLimit = Math.max(0, boundedLimit - ending.length);
  return `${safePrefix(value, contentLimit)}${ending}`;
}

/** Collapse whitespace for compact UI lines, then apply a Unicode-safe limit. */
export function singleLine(value: string | undefined, limit = SUMMARY_TEXT_LIMIT): string | undefined {
  if (!value) return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? truncateText(text, limit) : undefined;
}
