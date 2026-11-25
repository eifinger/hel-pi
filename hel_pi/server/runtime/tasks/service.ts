import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type Agent,
  type ConversationId,
  type Harness,
  type Tx,
} from "@earendil-works/pi-durable";
import type {
  AssistantTaskCommand,
  AssistantTaskDetail,
  AssistantTaskDraft,
  AssistantTaskReceipt,
} from "../../../shared/tasks";
import {
  AssistantTaskError,
  executionId,
  taskDraft,
  taskId,
  latestDue,
  nextDue,
} from "../../domain/tasks";
import type { InputSource, AssistantTasksRuntime } from "../types";
import { TaskFiles } from "../../task-files";
import type { SubagentRuntime } from "../subagents/runtime";
import { backgroundJobs, taskRecords } from "../subagents/queries";
import { TaskContext } from "./context";
import { spawnTaskAgent } from "./agent";
import type { BackgroundSelection } from "../background";
import type { StorageMaintenance } from "../storage-maintenance";
import {
  activeTaskExecutions,
  latestTaskExecutions,
  taskExecutionPage,
  taskExecutionResult,
} from "./queries";

import {
  TaskDefinitions,
  TaskDeletionState,
  Receipts,
  type StoredTask,
} from "./documents";
import { logError, logInfo, logWarn } from "../../logging";

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const publicTask = ({ source: _source, ...task }: StoredTask) => plain({...task, revision:task.revision ?? 1});
async function definitions(tx: Tx) {
  return (await tx.doc(TaskDefinitions, ROOT_CONVERSATION_ID)).tasks;
}
function find(values: Awaited<ReturnType<typeof definitions>>, id: string) {
  const task = values.find((value) => value.id === taskId(id));
  if (!task) throw new AssistantTaskError("Task not found.", 404);
  return task;
}
export class DurableAssistantTasks implements AssistantTasksRuntime {
  private timer?: ReturnType<typeof setInterval>;
  private tickPending?: Promise<void>;
  private deletionLine: Promise<void> = Promise.resolve();
  private closing = false;
  readonly files: TaskFiles;
  constructor(
    private readonly harness: Harness,
    workspace: string,
    private readonly children: SubagentRuntime,
    private readonly ready: () => Promise<void>,
    private readonly maintenance: StorageMaintenance,
    private readonly background: () => Promise<BackgroundSelection | undefined>,
    private readonly now = Date.now,
  ) {
    this.files = new TaskFiles(workspace);
  }

  start() {
    if (this.timer) return;
    logInfo("task.scheduler.started");
    const tick = () => {
      void this.tick().catch(() => {
        if (!this.closing)
          logError("task.scheduler.tick_failed");
      });
    };
    this.timer = setInterval(tick, 1000);
    this.timer.unref();
    tick();
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.tickPending?.catch(() => {});
    await this.deletionLine.catch(() => {});
    logInfo("task.scheduler.stopped");
  }

  async list() {
    await this.recoverDeletions();
    return this.harness.commit(async (tx) => {
      const latest = await latestTaskExecutions(tx);
      return (await definitions(tx))
        .map((value) => ({
          ...publicTask(value),
          ...(latest.has(value.id) && { latest: latest.get(value.id) }),
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    }, ctx);
  }
  async detail(id: string, before?: string): Promise<AssistantTaskDetail> {
    return this.harness.commit(async (tx) => {
      const task = publicTask(find(await definitions(tx), id));
      const { latest, ...page } = await taskExecutionPage(tx, id, before);
      return { task: { ...task, ...(latest && { latest }) }, ...page };
    }, ctx);
  }
  async result(id: string, runId: string) {
    executionId(runId);
    return this.harness.commit(async (tx) => {
      find(await definitions(tx), id);
      return taskExecutionResult(tx, id, runId);
    }, ctx);
  }

  async command(
    command: AssistantTaskCommand,
    source: InputSource = { channel: "app" },
    signal?: AbortSignal,
  ): Promise<AssistantTaskReceipt> {
    try {
      const result = await this.executeCommand(command, source, signal);
      logInfo("task.command.completed", {
        action: command.action,
        taskId: result.id,
        ...(result.executionId && { executionId: result.executionId }),
        duplicate: result.duplicate,
        channel: source.channel,
      });
      return result;
    } catch (error) {
      const fields = { action: command.action, channel: source.channel };
      if (error instanceof AssistantTaskError && error.status < 500)
        logWarn("task.command.rejected", { ...fields, status: error.status });
      else logError("task.command.failed", fields);
      throw error;
    }
  }

  private async executeCommand(
    command: AssistantTaskCommand,
    source: InputSource,
    signal?: AbortSignal,
  ): Promise<AssistantTaskReceipt> {
    signal?.throwIfAborted();
    if (this.closing)
      throw new AssistantTaskError("Piko is shutting down.", 503);
    const hash = createHash("sha256")
      .update(JSON.stringify(command))
      .digest("hex");
    // Duplicate checks precede model availability checks: accepted work is always queryable.
    const receipt = async (tx: Tx) => {
      const value = await tx.doc(
        Receipts,
        ROOT_CONVERSATION_ID,
        command.requestId,
        null,
      );
      if (value.hash && value.hash !== hash)
        throw new AssistantTaskError(
          "Request identity was already used for a different command.",
          409,
        );
      return value;
    };
    const prior = (await this.harness.snapshot(
      Receipts,
      ROOT_CONVERSATION_ID,
      command.requestId,
      ctx,
    )) ?? { hash: "", id: "", executionId: null };
    if (prior.hash && prior.hash !== hash)
      throw new AssistantTaskError(
        "Request identity was already used for a different command.",
        409,
      );
    if (prior.hash) {
      if (command.action === "stop" && prior.executionId)
        await this.children.stop(this.harness, ROOT_CONVERSATION_ID, [
          Number(prior.executionId) as ConversationId,
        ]);
      if (command.action === "delete") await this.finishDeletion(command.id);
      return {
        id: prior.id,
        ...(prior.executionId && { executionId: prior.executionId }),
        duplicate: true,
      };
    }
    if (command.action === "delete") return this.delete(command, hash, signal);
    if (command.action === "run") await this.ready();
    const agent =
      command.action === "run"
        ? await (await this.harness.conversation(
            ROOT_CONVERSATION_ID,
            ctx,
          ))!.agent(ctx)
        : undefined;
    const draft: AssistantTaskDraft | undefined =
      command.action === "create" || command.action === "update"
        ? taskDraft(command.task)
        : undefined;
    const id = command.action === "create" ? randomUUID() : taskId(command.id);
    if (command.action === "create") await this.files.prepare(id);
    let stopChildren: ConversationId[] = [];
    const result = await this.harness.commit(async (tx) => {
      signal?.throwIfAborted();
      const saved = await receipt(tx);
      if (saved.hash) {
        if (command.action === "stop" && saved.executionId)
          stopChildren = [Number(saved.executionId) as ConversationId];
        return {
          id: saved.id,
          ...(saved.executionId && { executionId: saved.executionId }),
          duplicate: true,
        };
      }
      const values = await definitions(tx);
      const now = this.now();
      let child: ConversationId | undefined;
      if (command.action === "create") {
        values.push({
          ...draft!,
          id,
          source,
          revision: 1,
          status: "active",
          createdAt: now,
          updatedAt: now,
          nextDueAt: nextDue(draft!.schedule, now),
        });
      } else {
        const task = find(values, id);
        if (command.action === "update") {
          if (command.revision !== (task.revision ?? 1)) throw new AssistantTaskError('Task changed. Read the current definition before merging your edits.', 409);
          const timingChanged =
            JSON.stringify(task.schedule) !== JSON.stringify(draft!.schedule);
          Object.assign(task, draft!, {revision:command.revision + 1});
          if (timingChanged) task.nextDueAt = nextDue(task.schedule, now);
          task.updatedAt = now;
        } else if (command.action === "status") {
          if (!["active", "archived"].includes(command.status))
            throw new AssistantTaskError("Invalid task status.");
          const active = (await activeTaskExecutions(tx)).some(
            (run) =>
              run.binding.taskId === id && run.execution.status === "running",
          );
          if (command.status === "archived" && active)
            throw new AssistantTaskError(
              "Stop this task's execution before archiving it.",
              409,
            );
          if (task.status !== command.status) {
            task.status = command.status;
            task.updatedAt = now;
            if (task.status === "active" && task.schedule?.type === "cron")
              task.nextDueAt = nextDue(task.schedule, now);
          }
        } else if (command.action === "run") {
          if (task.status === "archived")
            throw new AssistantTaskError(
              "Restore the task before running it.",
              409,
            );
          const runs = await activeTaskExecutions(tx);
          if (
            runs.some(
              (run) =>
                run.binding.taskId === id && run.execution.status === "running",
            )
          )
            throw new AssistantTaskError("This task is already running.", 409);
          if (
            runs.filter((run) => run.execution.status === "running").length >= 2
          )
            throw new AssistantTaskError(
              "Two tasks are already running. Try again after one finishes.",
              409,
            );
          child = await this.spawn(tx, agent!, task, source, null, now);
        } else {
          stopChildren = (await activeTaskExecutions(tx))
            .filter(
              (run) =>
                run.binding.taskId === id && run.execution.status === "running",
            )
            .map((run) => Number(run.execution.id) as ConversationId);
          child = stopChildren[0];
        }
      }
      signal?.throwIfAborted();
      Object.assign(saved, {
        hash,
        id,
        executionId: child === undefined ? null : String(child),
      });
      return {
        id,
        ...(child !== undefined && { executionId: String(child) }),
        duplicate: false,
      };
    }, ctx);
    // A stop receipt always targets the original child, so a retry cannot stop a later execution.
    if (command.action === "stop" && stopChildren.length)
      await this.children.stop(
        this.harness,
        ROOT_CONVERSATION_ID,
        stopChildren,
      );
    return result;
  }

  private async delete(
    command: Extract<AssistantTaskCommand, { action: "delete" }>,
    hash: string,
    signal?: AbortSignal,
  ): Promise<AssistantTaskReceipt> {
    const id = taskId(command.id);
    const existing = (await this.harness.snapshot(TaskDeletionState, ctx))
      ?.pending.find((item) => item.taskId === id);
    if (existing) {
      await this.finishDeletion(id);
      return { id, duplicate: true };
    }
    const result = await this.harness.commit(async (tx) => {
      signal?.throwIfAborted();
      const saved = await tx.doc(
        Receipts,
        ROOT_CONVERSATION_ID,
        command.requestId,
        null,
      );
      if (saved.hash) {
        if (saved.hash !== hash)
          throw new AssistantTaskError(
            "Request identity was already used for a different command.",
            409,
          );
        return { id: saved.id, duplicate: true };
      }
      const deletion = await tx.doc(TaskDeletionState);
      if (deletion.pending.some((item) => item.taskId === id))
        return { id, duplicate: true };
      const values = await definitions(tx);
      const task = find(values, id);
      const jobs = await backgroundJobs(tx, ROOT_CONVERSATION_ID);
      const rootTasks = await taskRecords(tx, ROOT_CONVERSATION_ID);
      const executions: number[] = [];
      for (const child of jobs.children) {
        if ((await tx.doc(TaskContext, child)).binding?.taskId !== id) continue;
        const live = await tx.doc(LiveDoc, child);
        const reporters = jobs.reporters.get(child) ?? [];
        const conversation = await tx.conversation(child);
        const anchor = rootTasks.find(
          (record) => record.id === conversation?.owner?.taskId,
        );
        const ownedTasks = await taskRecords(tx, child);
        if (
          live.run ||
          reporters.some((record) => record.state.status !== "terminal") ||
          anchor?.state.status !== "terminal" ||
          ownedTasks.some((record) => record.state.status !== "terminal")
        )
          throw new AssistantTaskError(
            "Stop this task and wait for its report to finish before deleting it.",
            409,
          );
        executions.push(Number(child));
      }
      // Validate the full ownership/fork closure before recording an irreversible intent.
      await this.maintenance.planTask(id, executions, command.requestId);
      const remaining = values.filter((value) => value.id !== task.id).map(plain);
      // Rebase this latest-only document as a new incarnation so historical deltas
      // containing the deleted prompt are retired and physically erased.
      await tx.retireDoc(TaskDefinitions, ROOT_CONVERSATION_ID);
      (await tx.doc(TaskDefinitions, ROOT_CONVERSATION_ID)).tasks = remaining;
      deletion.pending.push({
        taskId: id,
        executionConversations: executions,
        requestId: command.requestId,
      });
      Object.assign(saved, { hash, id, executionId: null });
      return { id, duplicate: false };
    }, ctx);
    await this.finishDeletion(id);
    return result;
  }

  async recoverDeletions() {
    const pending = (await this.harness.snapshot(TaskDeletionState, ctx))
      ?.pending.slice() ?? [];
    for (const item of pending) await this.finishDeletion(item.taskId);
    await this.maintenance.compactIfRequired(this.harness);
  }

  private finishDeletion(id: string) {
    const operation = this.deletionLine.then(async () => {
      const pending = (await this.harness.snapshot(TaskDeletionState, ctx))
        ?.pending.find((item) => item.taskId === id);
      if (!pending) {
        await this.maintenance.compactIfRequired(this.harness);
        return;
      }
      await this.maintenance.eraseTask(
        this.harness,
        pending.taskId,
        pending.executionConversations,
        pending.requestId,
      );
      await this.files.remove(pending.taskId);
      await this.harness.commit(async (tx) => {
        const deletion = await tx.doc(TaskDeletionState);
        const remaining = deletion.pending
          .filter((item) => item.taskId !== id)
          .map(plain);
        await tx.retireDoc(TaskDeletionState);
        (await tx.doc(TaskDeletionState)).pending = remaining;
      }, ctx);
      await this.maintenance.compact(this.harness);
    });
    this.deletionLine = operation.catch(() => {});
    return operation;
  }

  source(tx: Tx, callId: string) {
    return this.children.source(tx, callId);
  }
  private async spawn(
    tx: Tx,
    agent: Agent,
    task: StoredTask,
    source: InputSource,
    scheduledAt: number | null,
    now: number,
  ) {
    return spawnTaskAgent(tx, this.children, this.files, agent, await this.background(), ROOT_CONVERSATION_ID, task.prompt, {
      taskId: task.id,
      title: task.title,
      startedAt: now,
      scheduledAt,
      interrupted: false,
    }, source);
  }
  /** Public for deterministic tests; the native transaction serializes timer/manual admissions. */
  tick(): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.tickPending) return this.tickPending;
    this.tickPending = this.dispatch().finally(() => {
      this.tickPending = undefined;
    });
    return this.tickPending;
  }
  private async dispatch() {
    const due = (
      await this.harness.snapshot(TaskDefinitions, ROOT_CONVERSATION_ID, ctx)
    )?.tasks.some(
      (task) =>
        task.status === "active" &&
        task.nextDueAt !== null &&
        task.nextDueAt <= this.now(),
    );
    if (!due) return;
    await this.ready();
    const agent = await (await this.harness.conversation(
      ROOT_CONVERSATION_ID,
      ctx,
    ))!.agent(ctx);
    const scheduled = await this.harness.commit(async (tx) => {
      const created: { taskId: string; conversationId: string; scheduledAt: number }[] = [];
      const now = this.now();
      const runs = await activeTaskExecutions(tx);
      let running = runs.filter(
        (run) => run.execution.status === "running",
      ).length;
      for (const task of (await definitions(tx))
        .slice()
        .sort(
          (a, b) => (a.nextDueAt ?? Infinity) - (b.nextDueAt ?? Infinity),
        )) {
        if (
          task.status !== "active" ||
          !task.schedule ||
          task.nextDueAt === null ||
          task.nextDueAt > now
        )
          continue;
        if (
          runs.some(
            (run) =>
              run.binding.taskId === task.id &&
              run.execution.status === "running",
          )
        ) {
          if (task.schedule.type === "cron")
            task.nextDueAt = nextDue(task.schedule, now);
          continue;
        }
        if (running >= 2) continue;
        const scheduledAt =
          task.schedule.type === "cron"
            ? Math.max(task.nextDueAt, latestDue(task.schedule, now))
            : task.nextDueAt;
        const conversationId = await this.spawn(tx, agent, task, task.source, scheduledAt, now);
        created.push({ taskId: task.id, conversationId: String(conversationId), scheduledAt });
        task.nextDueAt =
          task.schedule.type === "once" ? null : nextDue(task.schedule, now);
        running++;
      }
      return created;
    }, ctx);
    for (const item of scheduled)
      logInfo("task.execution.scheduled", item);
  }
}
