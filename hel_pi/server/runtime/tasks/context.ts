import { defineDoc } from "@earendil-works/pi-durable";

/** Association and cancellation provenance only; execution state remains native. */
export type TaskBinding = {
  taskId: string;
  title: string;
  startedAt: number;
  scheduledAt: number | null;
  interrupted: boolean;
};
export const TaskContext = defineDoc<{ binding: TaskBinding | null }>({
  kind: "piko.task-context",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ binding: null }),
});
