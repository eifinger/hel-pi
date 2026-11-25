import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type { AssistantTask } from "../../../shared/tasks";
import type { InputSource } from "../types";

export type StoredTask = Omit<AssistantTask, "latest" | "revision"> & {
  revision?: number; // Definitions saved before revision checks start at 1.
  source: InputSource;
};
/** once.at is an ISO 8601 instant. */
export const TaskDefinitions = defineDoc<{ tasks: StoredTask[] }>({
  kind: "piko.tasks",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ tasks: [] }),
});
export type PendingTaskDeletion = {
  taskId: string;
  executionConversations: number[];
  requestId: string;
};
export const TaskDeletionState = defineDoc<{
  pending: PendingTaskDeletion[];
}>({
  kind: "piko.task-deletion",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({ pending: [] }),
});

export const Receipts = defineDocFamily<
  { hash: string; id: string; executionId: string | null },
  null
>({
  kind: "piko.task-command",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  family: true,
  checkpointWhen: () => false,
  initial: () => ({ hash: "", id: "", executionId: null }),
});
