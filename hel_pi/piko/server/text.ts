/** Count user-facing text in Unicode code points rather than UTF-16 code units. */
export function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** Return a prefix without splitting a surrogate pair. */
export function sliceCodePoints(value: string, limit: number): string {
  return Array.from(value).slice(0, Math.max(0, Math.floor(limit))).join("");
}
