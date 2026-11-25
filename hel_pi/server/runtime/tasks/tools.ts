import { Type } from "typebox";
import type { Context } from "@earendil-works/chord/context";
import {
  defineExtension,
  defineTool,
  ROOT_CONVERSATION_ID,
  type ToolExecutionApi,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type {
  AssistantTaskCommand,
  AssistantTaskDraft,
} from "../../../shared/tasks";
import { AssistantTaskError, taskDraft, taskId } from "../../domain/tasks";
import type { DurableAssistantTasks } from "./service";

/** UI and main assistant share the same service. Children cannot create schedules or delegate. */
export function createTaskTools(service: () => DurableAssistantTasks) {
  const schedule = Type.Union(
    [
      Type.Null(),
      Type.Object({
        type: Type.Literal("once"),
        at: Type.String({
          description:
            "ISO 8601 instant with an explicit offset, such as 2026-10-22T09:00:00+08:00.",
        }),
      }),
      Type.Object({
        type: Type.Literal("cron"),
        expression: Type.String({ description: "Five-field cron expression." }),
        timezone: Type.String({
          description: "IANA time zone, such as Asia/Shanghai.",
        }),
      }),
    ],
    {
      description:
        "null=manual; once=run once at the given instant; cron=recurring.",
    },
  );
  type Command =
    | { action: "list"; includeArchived?: boolean }
    | { action: "get" | "run" | "archive" | "restore" | "stop"; id: string }
    | ({ action: "create"; id?: never } & AssistantTaskDraft)
    | ({ action: "update"; id: string; revision: number } & AssistantTaskDraft);
  const execute = async (
    args: Command,
    api: ToolExecutionApi,
    context: Context,
  ): Promise<ToolExecutionResult> => {
    if (api.conversationId !== ROOT_CONVERSATION_ID)
      throw new AssistantTaskError(
        "Only the main assistant can manage tasks.",
        403,
      );
    if (args.action === "list") {
      const tasks = await service().list();
      // Prompt bodies stay out of list output; the tool only needs identity, timing and the last result.
      const summary = tasks
        .filter((task) => args.includeArchived || task.status === "active")
        .map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          schedule: task.schedule,
          scheduleText: task.scheduleText,
          nextDueAt: task.nextDueAt,
          ...(task.latest && {
            latest: {
              status: task.latest.status,
              startedAt: task.latest.startedAt,
              ...(task.latest.preview && { preview: task.latest.preview }),
              ...(task.latest.error && { error: task.latest.error }),
            },
          }),
        }));
      return { output: [{ type: "text", text: JSON.stringify(summary) }] };
    }
    if (args.action === "get") {
      const detail = await service().detail(taskId(args.id));
      // Latest executions are enough to report status; full history stays in the app.
      return {
        output: [
          {
            type: "text",
            text: JSON.stringify({
              task: detail.task,
              executions: detail.executions.slice(0, 5),
            }),
          },
        ],
      };
    }
    const source = await api.commit(
      (tx) => service().source(tx, api.callId),
      context,
    );
    const requestId = `piko:task-tool:${api.taskId}`;
    let command: AssistantTaskCommand;
    if (args.action === "create" || args.action === "update") {
      const task = taskDraft({
        title: args.title,
        prompt: args.prompt,
        schedule: args.schedule,
        scheduleText: args.scheduleText,
      });
      command =
        args.action === "create"
          ? { action: "create", requestId, task }
          : { action: "update", requestId, id: taskId(args.id), revision:args.revision, task };
    } else if (args.action === "run")
      command = { action: "run", requestId, id: taskId(args.id) };
    else if (args.action === "stop")
      command = { action: "stop", requestId, id: taskId(args.id) };
    else
      command = {
        action: "status",
        requestId,
        id: taskId(args.id),
        status: args.action === "archive" ? "archived" : "active",
      };
    const result = await service().command(
      command,
      source,
      context.abortSignal,
    );
    return { output: [{ type: "text", text: JSON.stringify(result) }] };
  };
  const id = Type.String({
    minLength: 1,
    description: "Task id from task_list or task_create; pass it without '#'.",
  });
  const definition = {
    title: Type.String({
      minLength: 1,
      maxLength: 160,
      description: "Short task title.",
    }),
    prompt: Type.String({
      minLength: 1,
      maxLength: 12000,
      description:
        "Full self-contained instructions for each fresh background execution.",
    }),
    schedule,
    scheduleText: Type.String({
      minLength: 1,
      maxLength: 120,
      pattern: "\\S",
      description:
        "Display label, e.g. 'Manual run' or 'Daily at 9:00'; no time zone or cron syntax.",
    }),
  };
  // Extension identity is persisted; changing tool names does not require a new native identity.
  return defineExtension({
    name: "piko-tasks",
    tools: [
      defineTool({
        name: "task_list",
        replay: "unsafe",
        description:
          "List active tasks with timing and latest results, without prompt bodies. Optionally include archived tasks. Use returned ids; never guess.",
        parameters: Type.Object({
          includeArchived: Type.Optional(
            Type.Boolean({ description: "Also include archived tasks." }),
          ),
        }),
        execute: (args, api, ctx) =>
          execute({ ...args, action: "list" }, api, ctx),
      }),
      defineTool({
        name: "task_get",
        replay: "unsafe",
        description:
          "Read a task's full definition and latest five executions. A saved schedule is not proof of execution.",
        parameters: Type.Object({ id }),
        execute: (args, api, ctx) =>
          execute({ ...args, action: "get" }, api, ctx),
      }),
      defineTool({
        name: "task_create",
        replay: "unsafe",
        description:
          "Save a persistent task with its own directory and optional scheduling. Does not immediately run it. Update existing tasks rather than creating duplicates.",
        parameters: Type.Object(definition),
        execute: (args, api, ctx) =>
          execute({ ...args, action: "create" }, api, ctx),
      }),
      defineTool({
        name: "task_update",
        replay: "unsafe",
        description:
          "Replace the complete task definition. Call task_get first and preserve unchanged fields. Does not change an already running execution.",
        parameters: Type.Object({ id, revision:Type.Integer({minimum:1, description:'The definition revision from task_get.'}), ...definition }),
        execute: (args, api, ctx) =>
          execute({ ...args, action: "update" }, api, ctx),
      }),
      defineTool({
        name: "task_run",
        replay: "unsafe",
        description:
          "Run once now without changing the schedule. Returns immediately; results arrive privately. Summarize for the user; replies may reach all channels. Do not poll.",
        parameters: Type.Object({ id }),
        execute: (args, api, ctx) =>
          execute({ ...args, action: "run" }, api, ctx),
      }),
      defineTool({
        name: "task_stop",
        replay: "unsafe",
        description:
          "Cancel current execution and pending private reports. Does not change future scheduling; archive the task to stop future triggers.",
        parameters: Type.Object({ id }),
        execute: (args, api, ctx) =>
          execute({ ...args, action: "stop" }, api, ctx),
      }),
      defineTool({
        name: "task_archive",
        replay: "unsafe",
        description:
          "Archive the task and stop future triggers, without deleting. If running, call task_stop first.",
        parameters: Type.Object({ id }),
        execute: (args, api, ctx) =>
          execute({ ...args, action: "archive" }, api, ctx),
      }),
      defineTool({
        name: "task_restore",
        replay: "unsafe",
        description:
          "Restore an archived task to active and re-enable future triggers. Does not immediately run it.",
        parameters: Type.Object({ id }),
        execute: (args, api, ctx) =>
          execute({ ...args, action: "restore" }, api, ctx),
      }),
    ],
  });
}
