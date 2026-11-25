import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type LogLevel = "info" | "warn" | "error";
export type LogFields = Record<string, string | number | boolean | null | undefined>;
const RETENTION_DAYS = 14;
let directory: string | undefined;
let fileFailureReported = false;

/** Initialize a private, operational log directory outside the workspace. */
export function configureLogging(home: string): void {
  try {
    if (!isAbsolute(home)) throw new Error("Piko home must be absolute.");
    const homePath = resolve(home);
    mkdirSync(homePath, { recursive: true, mode: 0o700 });
    const root = realpathSync(homePath);
    const path = join(root, "logs");
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Invalid log directory.");
    const actual = realpathSync(path);
    const rel = relative(root, actual);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error("Log directory escapes Piko home.");
    directory = actual;
    pruneLogs();
    logInfo("logging.ready", { retentionDays: RETENTION_DAYS });
  } catch {
    directory = undefined;
    writeRecord("warn", "logging.file.disabled", { reason: "unavailable" });
  }
}

export function logInfo(event: string, fields: LogFields = {}): void {
  writeRecord("info", event, fields);
}

export function logWarn(event: string, fields: LogFields = {}): void {
  writeRecord("warn", event, fields);
}

export function logError(event: string, fields: LogFields = {}): void {
  writeRecord("error", event, fields);
}

function writeRecord(level: LogLevel, event: string, fields: LogFields): void {
  const record = {
    ...fields,
    timestamp: new Date().toISOString(),
    level,
    event,
  };
  const line = JSON.stringify(record) + "\n";
  if (level === "error") console.error(line.trimEnd());
  else if (level === "warn") console.warn(line.trimEnd());
  else console.log(line.trimEnd());

  if (!directory) return;
  const path = join(directory, `piko-${record.timestamp.slice(0, 10)}.jsonl`);
  try {
    try {
      const file = lstatSync(path);
      if (!file.isFile() || file.isSymbolicLink()) throw new Error("Invalid log file.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
  } catch {
    directory = undefined;
    if (!fileFailureReported) {
      fileFailureReported = true;
      console.warn(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "warn",
        event: "logging.file.write_failed",
      }));
    }
  }
}

function pruneLogs(): void {
  if (!directory) return;
  const cutoff = new Date(Date.now() - (RETENTION_DAYS - 1) * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  for (const name of readdirSync(directory)) {
    const match = /^piko-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (!match || match[1]! >= cutoff) continue;
    const path = join(directory, name);
    try {
      const info = lstatSync(path);
      if (info.isFile() && !info.isSymbolicLink()) unlinkSync(path);
    } catch {
      // Log cleanup is best-effort and must not prevent startup.
    }
  }
}
