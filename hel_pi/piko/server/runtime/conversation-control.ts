import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type {
  Conversation,
  Harness,
  TaskId,
  Cursor,
} from "@earendil-works/pi-durable";
import { InboxDoc } from "@earendil-works/pi-durable";
import { RuntimeBusyError } from "./types";
import { StopReceipts } from "./conversation-docs";

/** One admission line per conversation. Reservations never hold the line while models run. */
export class ConversationControl {
  private admission: Promise<unknown> = Promise.resolve();
  private maintenance?: Promise<unknown>;
  private stopping = false;
  private deleting = false;
  private disposed = false;
  private closing?: Promise<void>;
  running = false;

  constructor(
    private readonly harness: Harness,
    private readonly conversation: Conversation,
    private readonly changed: () => void,
    private readonly assertWritable: () => Promise<void>,
    private readonly observationError: () => Error | undefined,
  ) {}

  get closed() {
    return this.disposed;
  }
  get isBusy() {
    return (
      !!this.maintenance || this.stopping || this.deleting || this.running
    );
  }
  get canReport() {
    return (
      !this.maintenance && !this.stopping && !this.deleting && !this.disposed
    );
  }
  assertInput() {
    if (this.disposed) throw new Error("Piko is shutting down.");
    if (!this.canReport) throw new RuntimeBusyError();
    const error = this.observationError();
    if (error) throw error;
  }
  /** Reserve internal admission on the same line as user input, maintenance and deletion. */
  async receiveReport(operation: () => Promise<void>): Promise<boolean> {
    return this.serial(async () => {
      if (!this.canReport) return false;
      const error = this.observationError();
      if (error) throw error;
      await this.assertWritable();
      await operation();
      return true;
    });
  }
  async remove(operation: () => Promise<void>) {
    await this.serial(async () => {
      if (this.disposed || this.maintenance || this.deleting || this.stopping) throw new RuntimeBusyError();
      this.deleting = true;
      this.changed();
    });
    // Reserve admission, but release the serial line before waiting: a reporter
    // already waiting on this owner must be able to observe the closed gate.
    try {
      await this.conversation.abort(ctx, { background: true });
      await this.conversation.waitForIdle(ctx);
      this.disposed = true;
      await operation();
    } finally {
      this.deleting = false;
      this.changed();
    }
  }

  serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.admission.catch(() => {}).then(operation);
    this.admission = task;
    return task;
  }
  abort(commandId?: string): Promise<boolean> {
    return this.serial(() => {
      if (this.disposed || this.deleting) throw new RuntimeBusyError();
      return this.abortCurrent(commandId);
    });
  }
  async abortCurrent(commandId?: string): Promise<boolean> {
    const wasActive = this.isBusy;
    this.stopping = true;
    this.changed();
    try {
      if (!commandId) {
        await this.conversation.abort(ctx);
        this.running = false;
        return wasActive;
      }
      // Capture original task IDs and withdraw original queued inputs atomically with the receipt.
      const target = await this.conversation.commit(async (tx) => {
        const saved = await tx.doc(
          StopReceipts,
          this.conversation.id,
          commandId,
          null,
        );
        if (saved.processed)
          return { stopped: saved.stopped, tasks: [...saved.tasks] };
        let cursor: Cursor | undefined;
        const tasks: number[] = [];
        do {
          const page = await tx.scanTasks(
            { conversationId: this.conversation.id },
            500,
            cursor,
          );
          for (const task of page.items)
            if (task.state.status !== "terminal" && !task.background)
              tasks.push(task.id);
          cursor = page.next;
        } while (cursor);
        const inbox = await tx.doc(InboxDoc, this.conversation.id);
        const stopped =
          tasks.length > 0 || inbox.items.some((item) => item.mode !== "write");
        for (const item of inbox.items)
          if (item.mode !== "write")
            tx.settleSubmission(item.id, {
              status: "unanswered",
              reason: "aborted",
            });
        inbox.items = inbox.items.filter((item) => item.mode === "write");
        saved.processed = true;
        saved.stopped = stopped;
        saved.tasks = tasks;
        return { stopped, tasks };
      }, ctx);
      for (const id of target.tasks)
        await this.harness.abortTask(id as TaskId, ctx);
      return target.stopped;
    } finally {
      this.stopping = false;
      this.changed();
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    return (this.closing = (async () => {
      await this.admission.catch(() => {});
      await this.conversation.abort(ctx);
      await this.maintenance?.catch(() => {});
    })());
  }
  /** Reserve maintenance on the same input line; do not hold it while work runs, so stop remains available. */
  async maintain<T>(operation: () => Promise<T>): Promise<T> {
    const reserved = await this.serial(async () => {
      if (this.disposed || this.isBusy) throw new RuntimeBusyError();
      const error = this.observationError();
      if (error) throw error;
      await this.assertWritable();
      const task = Promise.resolve().then(operation);
      this.maintenance = task;
      this.changed();
      return { task };
    });
    try {
      return await reserved.task;
    } finally {
      this.maintenance = undefined;
      this.changed();
    }
  }
}
