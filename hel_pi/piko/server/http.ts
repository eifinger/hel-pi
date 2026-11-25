export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Bound allocation even when Content-Length is missing or false. */
export async function readBody(
  request: Request,
  maxBytes: number,
  tooLarge = "Request is too large.",
): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes)
    throw new HttpError(tooLarge, 413);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new HttpError(tooLarge, 413);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  const bytes = await readBody(request, maxBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError("Send a valid JSON body.", 400);
  }
}

export async function readObjectBody(
  request: Request,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const value = await readJsonBody(request, maxBytes);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError("A JSON object is required.", 422);
  return value as Record<string, unknown>;
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/** Add CORS headers only after the caller has validated the browser Origin. */
export function withCors(request: Request, response: Response): Response {
  const origin = request.headers.get("origin");
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");
  const vary = headers.get("Vary");
  if (!vary) headers.set("Vary", "Origin");
  else if (!vary.toLowerCase().split(/,\s*/).includes("origin"))
    headers.set("Vary", `${vary}, Origin`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
