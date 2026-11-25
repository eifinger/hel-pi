export function normalizeMessage(message: string, allowEmpty = false): string {
  const text = message.trim();
  if (!text && !allowEmpty) {
    throw new Error("Message or attachment is required.");
  }
  return text;
}

/** One channel-agnostic representation for the model: attachment paths first, then the user's text. */
export function attachmentPrompt(text: string, paths: readonly string[]): string {
  if (!paths.length) return text;
  return ["<attached>", ...paths, "</attached>", ...(text ? [text] : [])].join("\n");
}
