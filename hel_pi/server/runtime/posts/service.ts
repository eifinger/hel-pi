import { createHash, randomUUID } from "node:crypto";
import { Cron } from "croner";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type Harness, type TaskId, type Tx } from "@earendil-works/pi-durable";
import type { GeneratePost, PostGeneration } from "../../../shared/posts";
import { PostError, postId } from "../../domain/posts";
import { logInfo, logWarn } from "../../logging";
import { POSTS_GENERATION_KIND, PostRequests } from "./documents";
import type { PostGenerationTask, PostGenerationResult } from "./generation";
import { postPage, readPost } from "./queries";
import type { StorageMaintenance } from "../storage-maintenance";

async function activeGeneration(tx: Tx): Promise<PostGeneration | null> {
  // Admission is serialized: a new generation cannot exist until the preceding one is terminal.
  const {items:[task]} = await tx.scanTasks({conversationId:ROOT_CONVERSATION_ID, kind:POSTS_GENERATION_KIND, order:'descending'}, 1);
  return !task || task.state.status === 'terminal' ? null : {id:String(task.id), status:task.abortRequested ? 'stopping' : 'running'};
}

export class PostsService {
  private deletionLine: Promise<void> = Promise.resolve();
  private schedule?: Cron;
  private scheduledStart?: Promise<void>;
  private closing = false;
  constructor(private readonly harness: Harness, private readonly task: PostGenerationTask, private readonly ensureModel: () => Promise<unknown>,
    private readonly maintenance: StorageMaintenance, private readonly refreshObservation: () => Promise<void>) {}

  /** One automatic attempt at 07:00 server-local time; missed runs are not replayed. */
  start() {
    if (this.schedule || this.closing) return;
    this.schedule = new Cron("0 7 * * *", { unref: true }, () => {
      if (this.closing || this.scheduledStart) return;
      const pending = this.generate({ requestId: randomUUID() }).then(result => {
        logInfo("posts.schedule.accepted", { taskId: Number(result.id) });
      }).catch(error => {
        if (error instanceof PostError && error.code === "post_generation_busy")
          logInfo("posts.schedule.busy");
        else if (!this.closing) logWarn("posts.schedule.failed");
      }).finally(() => { this.scheduledStart = undefined; });
      this.scheduledStart = pending;
    });
    logInfo("posts.schedule.started", { nextAt: this.schedule.nextRun()?.getTime() });
  }

  remove(id: string): Promise<void> {
    const nativeId = postId(id);
    if (this.closing) return Promise.reject(new Error("Piko is shutting down."));
    const deletion = this.deletionLine.catch(() => {}).then(async () => {
      await this.maintenance.erasePost(this.harness, nativeId);
      await this.refreshObservation();
      logInfo("posts.delete.completed", { postId: id });
    });
    this.deletionLine = deletion;
    return deletion;
  }
  async close() {
    this.closing = true;
    this.schedule?.stop();
    this.schedule = undefined;
    await this.scheduledStart;
    await this.deletionLine.catch(() => {});
  }
  list(before?: string, limit = 20) {
    return this.harness.commit(async tx => ({...await postPage(tx, before, limit), activeGeneration:await activeGeneration(tx)}), ctx);
  }
  read(id: string) { return this.harness.commit(tx => readPost(tx, id), ctx); }

  async generate(command: GeneratePost): Promise<PostGeneration> {
    const topic = null;
    const hash = createHash("sha256").update(JSON.stringify({ topic })).digest("hex");
    const existing = await this.harness.commit(async tx => {
      const receipt = await tx.doc(PostRequests, ROOT_CONVERSATION_ID, command.requestId, null);
      if (receipt.taskId !== null && receipt.hash !== hash) throw new PostError("This request ID was used for another post.", 409);
      return receipt.taskId;
    }, ctx);
    if (existing !== null) return this.generation(String(existing));
    try { await this.ensureModel(); }
    catch { throw new PostError("Select an available conversation or background model before generating a post.", 409); }
    const id = await this.harness.commit(async tx => {
      const receipt = await tx.doc(PostRequests, ROOT_CONVERSATION_ID, command.requestId, null);
      if (receipt.taskId !== null) {
        if (receipt.hash !== hash) throw new PostError("This request ID was used for another post.", 409);
        return receipt.taskId;
      }
      if (await activeGeneration(tx)) throw new PostError("A post is already being generated. Try again after it finishes.", 409, "post_generation_busy");
      const taskId = await tx.createTask(this.task, { topic },
        { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true });
      receipt.hash = hash;
      receipt.taskId = Number(taskId);
      return Number(taskId);
    }, ctx);
    logInfo("posts.generation.accepted", { taskId: id });
    return this.generation(String(id));
  }

  async generation(id: string): Promise<PostGeneration> {
    return this.harness.commit(async tx => {
      const task = await tx.task(postId(id) as TaskId);
      if (!task || task.kind !== POSTS_GENERATION_KIND || task.conversationId !== ROOT_CONVERSATION_ID)
        throw new PostError("Post generation not found.", 404);
      if (task.state.status !== "terminal") return { id, status: task.abortRequested ? "stopping" : "running" };
      const outcome = task.state.outcome;
      if (outcome.status === "completed") {
        const result = outcome.result as PostGenerationResult;
        return "postId" in result ? { id, status: "completed", postId: result.postId }
          : { id, status: "skipped", reason: result.reason };
      }
      return { id, status: outcome.status === "aborted" ? "stopped" : "failed",
        reason: outcome.status === "aborted" ? "Generation was stopped or interrupted by a restart." : "Could not generate the post. Try again." };
    }, ctx);
  }

  async stop(id: string) {
    const current = await this.generation(id);
    if (current.status === "running") await this.harness.abortTask(postId(id) as TaskId, ctx);
    return this.generation(id);
  }
}
