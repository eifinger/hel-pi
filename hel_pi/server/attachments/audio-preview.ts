import { json } from "../http";

/** Only expose recognized audio bytes inline; ordinary attachments keep their download behavior. */
function audioMime(bytes: Uint8Array): string | undefined {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.subarray(0, 3).toString("ascii") === "ID3" || (data.length > 1 && data[0] === 0xff && (data[1]! & 0xe0) === 0xe0)) return "audio/mpeg";
  if (data.length >= 12 && data.subarray(4, 8).toString("ascii") === "ftyp") return "audio/mp4";
  if (data.subarray(0, 4).toString("ascii") === "OggS") return "audio/ogg";
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WAVE") return "audio/wav";
  return undefined;
}

export function audioPreviewResponse(request: Request, bytes: Uint8Array, declaredMime: string): Response {
  const mime = audioMime(bytes);
  if (!mime || mime !== declaredMime) return json({ error: "Unsupported audio." }, 415);
  const headers = new Headers({
    "Content-Type": mime,
    "Content-Disposition": "inline",
    "Cache-Control": "private, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
  });
  const match = request.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (match && (match[1] || match[2])) {
    const first = match[1] ? Number(match[1]) : Math.max(0, bytes.length - Number(match[2]));
    const last = match[1] && match[2] ? Math.min(bytes.length - 1, Number(match[2])) : bytes.length - 1;
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first >= bytes.length || first > last || (!match[1] && Number(match[2]) === 0)) {
      headers.set("Content-Range", `bytes */${bytes.length}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set("Content-Range", `bytes ${first}-${last}/${bytes.length}`);
    headers.set("Content-Length", String(last - first + 1));
    return new Response(request.method === "HEAD" ? null : new Uint8Array(bytes.subarray(first, last + 1)).buffer, { status: 206, headers });
  }
  headers.set("Content-Length", String(bytes.length));
  return new Response(request.method === "HEAD" ? null : new Uint8Array(bytes).buffer, { headers });
}
