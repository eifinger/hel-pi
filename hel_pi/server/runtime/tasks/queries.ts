import {
  ROOT_CONVERSATION_ID,
  LiveDoc,
  type ConversationId,
  type Tx,
} from "@earendil-works/pi-durable";
import type { TaskExecution } from "../../../shared/tasks";
import { AssistantTaskError } from "../../domain/tasks";
import { TaskContext, type TaskBinding } from "./context";
import {
  backgroundJobs,
  jobFacts,
  type BackgroundJobs,
  type JobFacts,
} from "../subagents/queries";
import { messageText } from "../pi-history";
import { DETAIL_TEXT_LIMIT, truncateText } from "../text";

function execution(
  child: ConversationId,
  facts: JobFacts,
  binding: TaskBinding,
  preview?: string,
): TaskExecution {
  // Cancellation keeps a slot occupied until the native run/tools actually stop.
  const status = facts.running
    ? "running"
    : binding.interrupted || facts.interrupted
      ? "interrupted"
      : facts.stopped
        ? "stopped"
        : facts.error
          ? "failed"
          : facts.done
            ? "completed"
            : "running";
  return {
    id: String(child),
    startedAt: binding.startedAt,
    scheduledAt: binding.scheduledAt,
    status,
    ...(facts.error && { error: facts.error }),
    ...(preview && { preview }),
  };
}
async function answerText(tx: Tx, facts: JobFacts): Promise<string> {
  const answer =
    facts.answerId === undefined ? undefined : await tx.entry(facts.answerId);
  return (answer?.model ?? [])
    .map((message) =>
      "content" in message ? messageText(message.content) : "",
    )
    .join("");
}
async function summary(tx: Tx, jobs: BackgroundJobs, child: ConversationId) {
  const binding = (await tx.doc(TaskContext, child)).binding;
  if (!binding) throw new AssistantTaskError("Execution not found.", 404);
  const facts = await jobFacts(tx, jobs, child);
  const answer = await answerText(tx, facts);
  const preview = truncateText(
    answer
      .replace(/[#*_`>]/g, "")
      .replace(/\s+/g, " ")
      .trim(),
    DETAIL_TEXT_LIMIT,
  );
  return { execution: execution(child, facts, binding, preview), answer };
}

/** Scheduling and command guards do not read any answer bodies or completed submissions. */
export async function activeTaskExecutions(tx: Tx) {
  const jobs = await backgroundJobs(tx);
  const active = [];
  for (const child of jobs.children) {
    const binding = (await tx.doc(TaskContext, child)).binding;
    if (!binding) continue;
    const live = await tx.doc(LiveDoc, child);
    const reporter = jobs.reporters.get(child)?.at(-1);
    if (!reporter || (!live.run && reporter.state.status === "terminal"))
      continue;
    const value = execution(child, await jobFacts(tx, jobs, child), binding);
    if (value.status === "running")
      active.push({ binding: { ...binding }, execution: value });
  }
  return active;
}

/** Read one latest summary per task, not every historical answer. */
export async function latestTaskExecutions(tx: Tx) {
  const jobs = await backgroundJobs(tx);
  const latest = new Map<string, TaskExecution>();
  for (const child of [...jobs.children].reverse()) {
    const binding = (await tx.doc(TaskContext, child)).binding;
    if (!binding || latest.has(binding.taskId) || !jobs.reporters.has(child))
      continue;
    latest.set(binding.taskId, (await summary(tx, jobs, child)).execution);
  }
  return latest;
}

/** Filter bindings before projection and stop after one page + lookahead. */
export async function taskExecutionPage(
  tx: Tx,
  taskId: string,
  before?: string,
) {
  const jobs = await backgroundJobs(tx);
  const executions: TaskExecution[] = [];
  let latest: TaskExecution | undefined;
  let found = before === undefined;
  for (const child of [...jobs.children].reverse()) {
    const binding = (await tx.doc(TaskContext, child)).binding;
    if (binding?.taskId !== taskId || !jobs.reporters.has(child)) continue;
    const value = !latest
      ? (await summary(tx, jobs, child)).execution
      : undefined;
    latest ??= value;
    if (!found) {
      if (String(child) === before) found = true;
      continue;
    }
    if (executions.length === 50)
      return { latest, executions, nextBefore: executions.at(-1)!.id };
    executions.push(value ?? (await summary(tx, jobs, child)).execution);
  }
  if (!found) throw new AssistantTaskError("Unknown execution cursor.");
  return { latest, executions };
}

/** Check root ownership and task binding before reading a single requested answer. */
export async function taskExecutionResult(
  tx: Tx,
  taskId: string,
  runId: string,
) {
  const jobs = await backgroundJobs(tx, ROOT_CONVERSATION_ID);
  const child = jobs.children.find((id) => String(id) === runId);
  if (
    child === undefined ||
    (await tx.doc(TaskContext, child)).binding?.taskId !== taskId ||
    !jobs.reporters.has(child)
  )
    throw new AssistantTaskError("Execution not found.", 404);
  return summary(tx, jobs, child);
}
