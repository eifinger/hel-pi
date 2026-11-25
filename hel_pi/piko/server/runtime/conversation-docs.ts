import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";

export const Recovery = defineDoc<{ interruption: string }>({
  kind: "piko.recovery",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ interruption: "" }),
});
export const StopReceipts = defineDocFamily<
  { processed: boolean; stopped: boolean; tasks: number[] },
  null
>({
  kind: "piko.stop",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  family: true,
  checkpointWhen: () => false,
  initial: () => ({ processed: false, stopped: false, tasks: [] }),
});
