export type FilePreviewKind = "markdown" | "text";

/** Keep in-app text previews bounded; larger files remain downloadable. */
export const MAX_FILE_PREVIEW_BYTES = 1024 * 1024;

const markdownExtensions = new Set(["md", "markdown"]);
const textExtensions = new Set([
  "txt", "text", "log", "json", "jsonl", "ndjson", "csv", "tsv",
  "yaml", "yml", "toml", "xml", "ini", "conf", "properties",
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "sh", "bash", "zsh",
  "css", "html", "sql", "go", "rs", "java", "c", "h", "cc", "cpp",
  "hpp", "cs", "php", "rb", "swift", "kt", "vue", "svelte", "svg",
]);
const wellKnownTextNames = new Set(["readme", "license", "notice", "changelog"]);

export function decodePreviewText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
}

export function filePreviewKind(name: string): FilePreviewKind | null {
  const lower = name.toLowerCase();
  if (wellKnownTextNames.has(lower)) return "text";
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return null;
  const extension = lower.slice(dot + 1);
  if (markdownExtensions.has(extension)) return "markdown";
  return textExtensions.has(extension) ? "text" : null;
}
