import { filePreviewKind, decodePreviewText, MAX_FILE_PREVIEW_BYTES } from "../../shared/file-preview";
import { json } from "../http";

/** Use the shared text-preview policy; binary and large files remain downloadable. */
export function attachmentTextPreview(name: string, bytes: Uint8Array): Response {
  const preview = filePreviewKind(name);
  if (!preview) return json({ error: "This file type cannot be previewed." }, 415);
  if (bytes.byteLength > MAX_FILE_PREVIEW_BYTES) return json({ error: "File too large to preview." }, 413);
  return json({ content: decodePreviewText(bytes), preview });
}
