import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import type { ActiveCompaction, CompactionResult, CompactionEvent } from "../../shared/runtime";

/** Report the native task's completion; summary creation and placement stay inside Durable. */
export async function compactionResult(harness: Harness, task: TaskId): Promise<CompactionResult> {
  const settled = await harness.waitForTask(task, context);
  const outcome = settled.state.outcome;
  if (outcome.status === "aborted") return { status: "cancelled" };
  if (outcome.status === "failed" || outcome.status === "faulted") throw new Error(outcome.error.message);
  if (outcome.status !== "completed") throw new Error("Compaction did not complete.");
  return { status: "compacted" };
}

type NativeCompaction = { taskId: TaskId; reason: ActiveCompaction["reason"] };
/** Live presentation only. Task and submission records remain the authority; no persisted notification ledger. */
export class CompactionObserver {
  private readonly active = new Map<TaskId, { value: ActiveCompaction; finishing: boolean }>();
  private closed = false;
  constructor(private readonly harness: Harness, private readonly emit: (event: CompactionEvent) => void, private readonly refresh: () => void) {}
  start(item: NativeCompaction, notify = true) {
    if (this.closed || this.active.has(item.taskId)) return;
    const value = { id: String(item.taskId), reason: item.reason };
    this.active.set(item.taskId, { value, finishing: false });
    if (notify) this.emit({ type: "compaction", phase: "start", ...value });
    this.refresh();
  }
  sync(items: readonly NativeCompaction[], initial = false) {
    for (const item of items) this.start(item, !initial);
    for (const [id] of this.active) if (!items.some(item => item.taskId === id)) this.end(id);
  }
  end(id: TaskId) {
    const current = this.active.get(id);
    if (this.closed || !current || current.finishing) return;
    current.finishing = true;
    // Settle the task without blocking the conversation observer or inspecting its summary/submission.
    void compactionResult(this.harness, id).then(result => this.finish(id, result), () => this.finish(id, { status: "failed" }));
  }
  private finish(id: TaskId, result: CompactionResult | { status: "failed" }) {
    const current = this.active.get(id);
    if (!current) return;
    this.active.delete(id);
    if (!this.closed) { this.emit({ type: "compaction", phase: "end", ...current.value, result }); this.refresh(); }
  }
  snapshot(native: readonly NativeCompaction[]): ActiveCompaction[] {
    const values = new Map([...this.active.values()].map(item => [item.value.id, item.value]));
    for (const item of native) values.set(String(item.taskId), { id: String(item.taskId), reason: item.reason });
    return [...values.values()];
  }
  close() { this.closed = true; this.active.clear(); }
}
