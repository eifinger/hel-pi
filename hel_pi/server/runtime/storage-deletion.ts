import { defineDoc, type Tx } from "@earendil-works/pi-durable";

/** IDs only: a recoverable physical deletion, not a second copy of execution state/content. */
export type StorageDeletionPlan = {
  conversations: number[];
  tasks: number[];
  documents: number[];
  entries: number[];
};
export const StorageDeletion = defineDoc<{ pending: StorageDeletionPlan | null }>({
  kind: "piko.storage-deletion", version: 1, scope: "session",
  checkpointWhen: () => true, initial: () => ({ pending: null }),
});

/** Check on the same native commit line as continuation/cancellation, not before it. */
export async function backgroundIsDeleting(tx: Tx, child: number): Promise<boolean> {
  return (await tx.doc(StorageDeletion)).pending?.conversations.includes(child) ?? false;
}

export { StorageDeletionBlocked } from "./types";
