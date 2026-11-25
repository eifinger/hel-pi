import { Type } from "typebox";
import { Compile } from "typebox/compile";
import type { SettingsRuntime } from "../runtime/types";
import { HttpError, json, readBody } from "../http";
import { SettingsRevisionConflictError, SettingsValidationError } from "./configuration";

const thinking = Type.Union([
  Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"),
  Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max"),
]);
const modelSelection = Type.Object({
  provider: Type.String({ minLength: 1, maxLength: 120 }),
  model: Type.String({ minLength: 1, maxLength: 300 }),
  thinking: Type.Optional(thinking),
}, { additionalProperties: false });
const selection = Type.Union([Type.Null(), modelSelection]);
const saveSchema = Type.Object({
  baseRevision: Type.String({ minLength: 1, maxLength: 128 }),
  mainModel: selection,
  /** Null means follow main's model identity. */
  backgroundModel: selection,
  /** Null means also follow main's thinking strength. */
  backgroundThinking: Type.Union([Type.Null(), thinking]),
}, { additionalProperties: false });
const saveValidator = Compile(saveSchema);
const maxBodyBytes = 32_000;

function errorResponse(error: unknown) {
  if (error instanceof SettingsRevisionConflictError || error instanceof SettingsValidationError)
    return json({ error: error.message }, error.status);
  if (error instanceof HttpError) return json({ error: error.message }, error.status);
  return json({ error: "无法读取或保存模型设置，请重试。" }, 503);
}

/** Only model role selections are user-editable; provider/tool configuration remains deployment-managed. */
export async function settingsRequest(
  request: Request,
  runtime: SettingsRuntime,
): Promise<Response | undefined> {
  if (new URL(request.url).pathname !== "/api/settings") return undefined;
  if (request.method === "GET") {
    try { return json(await runtime.settings()); }
    catch (error) { return errorResponse(error); }
  }
  if (request.method !== "PUT") {
    const response = json({ error: "Settings supports GET and PUT." }, 405);
    response.headers.set("Allow", "GET, PUT");
    return response;
  }
  try {
    const bytes = await readBody(request, maxBodyBytes, "模型设置请求过大。");
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { return json({ error: "模型设置请求不是有效 JSON。" }, 400); }
    if (!saveValidator.Check(body)) return json({ error: "模型设置请求字段或结构无效。" }, 400);
    return json(await runtime.saveModelSettings(body as Parameters<SettingsRuntime["saveModelSettings"]>[0]));
  } catch (error) { return errorResponse(error); }
}
