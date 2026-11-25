import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Compile } from "typebox/compile";
import type { Static, TSchema } from "typebox";

export function optionalText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read ${path}`, { cause: error });
  }
}

/** Parse without validating so JSON application defaults can be filled first. */
export function readJsonValue(path: string, fallback: unknown): unknown {
  const text = optionalText(path);
  if (text === undefined) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    // Parser errors can contain credential values; report only the file.
    throw new Error(`Invalid JSON in ${path}`);
  }
}

export function readJson<T extends TSchema>(
  path: string,
  schema: T,
  fallback: Static<T>,
): Static<T> {
  const value = readJsonValue(path, fallback);
  const validator = Compile(schema);
  if (!validator.Check(value)) {
    const error = [...validator.Errors(value)][0];
    throw new Error(
      `Invalid configuration in ${path} at ${error?.instancePath || "/"}: ${error?.message ?? "invalid value"}`,
    );
  }
  return value as Static<T>;
}

/** Shared application/model environment; never mutates process.env. */
export function readConfigEnvironment(
  home: string,
  ambient: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const path = join(home, "config", ".env");
  const local: Record<string, string> = {};
  const text = optionalText(path);
  for (const [index, line] of (text?.split(/\r?\n/) ?? []).entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!match)
      throw new Error(
        `Invalid environment entry in ${path} at line ${index + 1}`,
      );
    const name = match[1]!;
    let value = match[2]!.trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0]!;
      const end = value.lastIndexOf(quote);
      if (end === 0 || !/^\s*(?:#.*)?$/.test(value.slice(end + 1)))
        throw new Error(
          `Invalid quoted environment entry in ${path} at line ${index + 1}`,
        );
      value = value.slice(1, end);
      if (quote === '"')
        value = value.replace(/\\([\\nr"])/g, (_match, escaped: string) =>
          escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped);
    } else {
      value = value.replace(/\s+#.*$/, "").trimEnd();
    }
    local[name] = value;
  }
  for (const [name, value] of Object.entries(ambient))
    if (value !== undefined) local[name] = value;
  return local;
}
