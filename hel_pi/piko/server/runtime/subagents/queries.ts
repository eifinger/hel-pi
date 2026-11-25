import {
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type Cursor,
  type TaskRecord,
  type Tx,
} from "@earendil-works/pi-durable";
import { Recovery } from "../conversation-docs";
import { backgroundIsDeleting } from "../storage-deletion";
import {
  JobControl,
  ANCHOR_KIND,
  REPORTER_KIND,
  type ReporterInput,
  type ReporterState,
  type ReporterResult,
} from "./documents";
import { summarizeToolArgs, toolIcon } from "../tool-activity";
import { DETAIL_TEXT_LIMIT, singleLine } from "../text";

export async function taskRecords(
  tx: Tx,
  conversationId = ROOT_CONVERSATION_ID,
) {
  const records: TaskRecord<unknown, unknown, unknown>[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks({ conversationId }, 500, cursor);
    records.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return records;
}
export async function subagentIds(
  tx: Tx,
  conversationId = ROOT_CONVERSATION_ID,
  records?: TaskRecord<unknown, unknown, unknown>[],
): Promise<ConversationId[]> {
  const anchors = (records ?? (await taskRecords(tx, conversationId))).filter(
    (task) => task.kind === ANCHOR_KIND,
  );
  const result: ConversationId[] = [];
  for (const anchor of anchors) {
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanConversations(
        { ownerTaskId: anchor.id },
        500,
        cursor,
      );
      for (const item of page.items)
        if (!(await backgroundIsDeleting(tx, item.id))) result.push(item.id);
      cursor = page.next;
    } while (cursor);
  }
  return result;
}

const ACTIVITY_TEXT_LIMIT = DETAIL_TEXT_LIMIT;

/** Last assistant text and tool calls of a child, oldest first; bounds both per-step text and step count. */
export async function recentActivity(
  tx: Tx,
  child: ConversationId,
  limit: number,
): Promise<string[]> {
  const groups: string[][] = [];
  let count = 0;
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries(
      { conversationId: child, order: "descending" },
      50,
      cursor,
    );
    for (const entry of page.items) {
      if (entry.kind !== "pi.assistant") continue;
      const steps: string[] = [];
      for (const message of entry.model ?? []) {
        if (
          message.role !== "assistant" ||
          !("content" in message) ||
          !Array.isArray(message.content)
        )
          continue;
        for (const block of message.content) {
          if (block.type === "text") {
            const text = singleLine(block.text, ACTIVITY_TEXT_LIMIT);
            if (text) steps.push(text);
          } else if (block.type === "toolCall") {
            const summary = summarizeToolArgs(block.name, block.arguments);
            steps.push(singleLine(
              `${toolIcon(block.name)} ${block.name}${summary ? `: ${summary}` : ""}`,
              ACTIVITY_TEXT_LIMIT,
            )!);
          }
        }
      }
      if (steps.length) {
        groups.push(steps);
        count += steps.length;
      }
      if (count >= limit) break;
    }
    cursor = page.next;
  } while (cursor && count < limit);
  const chrono = groups.reverse().flat();
  // The committed transcript can lag the in-flight answer; show the partial last.
  const live = await tx.doc(LiveDoc, child);
  const partial = live.generation?.message;
  if (partial?.content) {
    const text = partial.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(" ");
    const line = singleLine(text, ACTIVITY_TEXT_LIMIT);
    if (line) chrono.push(`(replying) ${line}`);
  }
  return chrono.slice(-limit);
}

/** A transaction-local index; no persisted execution state or cross-transaction cache. */
export async function backgroundJobs(tx: Tx, owner = ROOT_CONVERSATION_ID) {
  const records = await taskRecords(tx, owner);
  const children = await subagentIds(tx, owner, records);
  const reporters = new Map<
    ConversationId,
    TaskRecord<unknown, unknown, unknown>[]
  >();
  for (const record of records) {
    if (record.kind !== REPORTER_KIND) continue;
    const child = (record.input as ReporterInput).child;
    const group = reporters.get(child) ?? [];
    group.push(record);
    reporters.set(child, group);
  }
  return { children, reporters };
}
export type BackgroundJobs = Awaited<ReturnType<typeof backgroundJobs>>;

/** Shared native facts; consumers project their own product states. */
export async function jobFacts(
  tx: Tx,
  jobs: BackgroundJobs,
  child: ConversationId,
) {
  const interrupted = !!(await tx.doc(Recovery, child)).interruption;
  const live = await tx.doc(LiveDoc, child);
  const epoch = (await tx.doc(JobControl, child)).epoch;
  const reporters = jobs.reporters.get(child) ?? [];
  const reporter = reporters.at(-1);
  const submission =
    reporter &&
    (await tx.submissionByRequest(child, `piko:subagent-input:${reporter.id}`));
  const outcome =
    reporter &&
    (reporter.state.status === "terminal" ||
      reporter.state.status === "completing")
      ? reporter.state.outcome
      : undefined;
  const checkpoint =
    reporter && (reporter.state.checkpoint as ReporterState | undefined);
  const result =
    outcome?.status === "completed"
      ? (outcome.result as ReporterResult)
      : undefined;
  const reportCheckpoint =
    checkpoint?.phase === "report" || checkpoint?.phase === "retry"
      ? checkpoint
      : undefined;
  const error =
    reportCheckpoint?.error ??
    result?.error ??
    (submission?.status === "unanswered" && submission.reason !== "aborted"
      ? typeof submission.detail === "string"
        ? submission.detail
        : submission.reason
      : undefined) ??
    (outcome?.status === "failed" || outcome?.status === "faulted"
      ? outcome.error.message
      : undefined);
  const stopped =
    !!reporter &&
    (epoch !== (reporter.input as ReporterInput).epoch ||
      (submission?.status === "unanswered" &&
        submission.reason === "aborted") ||
      outcome?.status === "aborted");
  const delivering = reporters.some(
    (record) =>
      record.state.status !== "terminal" &&
      (record.input as ReporterInput).epoch === epoch &&
      (record.state.status === "pending" ||
        record.state.status === "running") &&
      (record.state.checkpoint as ReporterState).phase === "deliver",
  );
  const answerId =
    submission?.type === "input" && submission.status === "done"
      ? submission.answer
      : reportCheckpoint
        ? reportCheckpoint.answer
        : result?.answer;
  return {
    interrupted,
    running: !!live.run,
    delivering,
    stopped,
    error,
    answerId,
    done: submission?.status === "done",
    hasReporter: !!reporter,
    task:
      singleLine(
        reporters[0] && (reporters[0].input as ReporterInput).message,
        DETAIL_TEXT_LIMIT,
      ) ?? "",
  };
}
export type JobFacts = Awaited<ReturnType<typeof jobFacts>>;
