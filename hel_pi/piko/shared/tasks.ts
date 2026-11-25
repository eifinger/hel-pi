/** Product contracts; native task/conversation IDs remain opaque strings. */
export type TaskSchedule = null | { type: "once"; at: string } | { type: "cron"; expression: string; timezone: string };
export type AssistantTaskDraft = { title: string; prompt: string; schedule: TaskSchedule; scheduleText: string };
export type AssistantTask = AssistantTaskDraft & {
  id: string;
  status: "active" | "archived";
  createdAt: number;
  updatedAt: number;
  nextDueAt: number | null;
  latest?: TaskExecution;
};
export type TaskExecution = {
  id: string;
  startedAt: number;
  scheduledAt: number | null;
  status: "running" | "completed" | "failed" | "stopped" | "interrupted";
  error?: string;
  preview?: string;
};
export type AssistantTaskDetail = { task: AssistantTask; executions: TaskExecution[]; nextBefore?: string };
export type TaskExecutionDetail = { execution: TaskExecution; answer: string };
export type AssistantTaskCommand = { requestId: string } & (
  | { action: "create"; task: AssistantTaskDraft }
  | { action: "update"; id: string; task: AssistantTaskDraft }
  | { action: "status"; id: string; status: AssistantTask["status"] }
  | { action: "run"; id: string }
  | { action: "stop"; id: string }
  | { action: "delete"; id: string }
);
export type AssistantTaskReceipt = { id: string; executionId?: string; duplicate: boolean };
