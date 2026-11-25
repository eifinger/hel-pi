import { Cron } from "croner";
import type { TaskSchedule, AssistantTaskDraft } from "../../shared/tasks";

export class AssistantTaskError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
  }
}
export function taskId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(value))
    throw new AssistantTaskError("Invalid task identity.");
  return value;
}
export function executionId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value))
    throw new AssistantTaskError("Invalid execution identity.");
  return value;
}
/** once.at is an ISO 8601 instant with an explicit offset, normalized to UTC. */
function onceAt(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(
      text,
    )
  )
    throw new AssistantTaskError(
      "Use an ISO 8601 time with an offset, such as 2026-10-22T09:00:00+08:00.",
    );
  const at = Date.parse(text);
  if (!Number.isSafeInteger(at) || at <= 0 || at >= 8.64e15)
    throw new AssistantTaskError("Invalid time.");
  return new Date(at).toISOString();
}
export function taskDraft(value: unknown): AssistantTaskDraft {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AssistantTaskError("A task is required.");
  const input = value as Record<string, unknown>;
  if (
    typeof input.title !== "string" ||
    !input.title.trim() ||
    input.title.length > 160
  )
    throw new AssistantTaskError("Title must contain 1–160 characters.");
  if (
    typeof input.prompt !== "string" ||
    !input.prompt.trim() ||
    input.prompt.length > 12000
  )
    throw new AssistantTaskError("Prompt must contain 1–12,000 characters.");
  let schedule: TaskSchedule = null;
  if (input.schedule !== null) {
    if (
      !input.schedule ||
      typeof input.schedule !== "object" ||
      Array.isArray(input.schedule)
    )
      throw new AssistantTaskError("Choose manual, once, or cron scheduling.");
    const rule = input.schedule as Record<string, unknown>;
    if (rule.type === "once") schedule = { type: "once", at: onceAt(rule.at) };
    else if (
      rule.type === "cron" &&
      typeof rule.expression === "string" &&
      typeof rule.timezone === "string"
    ) {
      const expression = rule.expression.trim().replace(/\s+/g, " ");
      if (
        expression.length > 120 ||
        expression.split(" ").length !== 5 ||
        rule.timezone.length > 100
      )
        throw new AssistantTaskError(
          "Use a five-field cron expression and an IANA time zone.",
        );
      try {
        new Intl.DateTimeFormat("en", { timeZone: rule.timezone });
        if (!new Cron(expression, { timezone: rule.timezone }).nextRun())
          throw new Error("No future occurrence");
      } catch {
        throw new AssistantTaskError("Invalid cron expression or time zone.");
      }
      schedule = { type: "cron", expression, timezone: rule.timezone };
    } else throw new AssistantTaskError("Invalid schedule.");
  }
  const scheduleText =
    typeof input.scheduleText === "string" ? input.scheduleText.trim() : "";
  if (!scheduleText || scheduleText.length > 120)
    throw new AssistantTaskError(
      "Add a display label under 120 characters, including for manual tasks.",
    );
  return {
    title: input.title.trim(),
    prompt: input.prompt.trim(),
    schedule,
    scheduleText,
  };
}
/** Croner evaluates calendar/DST rules only; no library timer or second scheduler. */
export function nextDue(schedule: TaskSchedule, after: number): number | null {
  if (!schedule) return null;
  if (schedule.type === "once") return Date.parse(schedule.at);
  return (
    new Cron(schedule.expression, { timezone: schedule.timezone })
      .nextRun(new Date(after))
      ?.getTime() ?? null
  );
}
export function latestDue(
  schedule: Extract<TaskSchedule, { type: "cron" }>,
  now: number,
): number {
  return (
    new Cron(schedule.expression, { timezone: schedule.timezone })
      .previousRuns(1, new Date(now + 1))[0]
      ?.getTime() ?? now
  );
}
