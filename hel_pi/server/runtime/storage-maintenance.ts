import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineDoc, defineDocFamily, ROOT_CONVERSATION_ID, type DocumentRecord, type Harness, type Storage, type TaskRecord, type Tx } from "@earendil-works/pi-durable";
import { CURRENT_SQLITE_SCHEMA_VERSION, type SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { PostError } from "../domain/posts";
import { ANCHOR_KIND, REPORTER_KIND } from "./subagents/documents";
import { SideChatError } from "./side-chats";
import { StorageDeletion, StorageDeletionBlocked, type StorageDeletionPlan } from "./storage-deletion";
import { POSTS_GENERATION_KIND, PublishedPost } from "./posts/documents";

const StorageCleanup = defineDoc<{ required: boolean }>({
  kind: "piko.storage-cleanup", version: 1, scope: "session", initial: () => ({ required: false }),
  checkpointWhen: () => true,
});

type ConversationRow = { id: number; owner_conversation_id: number | null; owner_task_id: number | null; parent: number | null; forkAt: number | null };
type NativeTask = TaskRecord<unknown, unknown, unknown>;
type Graph = { conversations: ConversationRow[]; tasks: NativeTask[] };
export type SideChatDeletion = StorageDeletionPlan & { id: number; retired: boolean };
export type TaskStorageDeletion = StorageDeletionPlan & { taskId: string };
export type RetentionTarget = { kind: "delegation" | "memory" | "posts"; taskId: number };

/** Same connection and Harness mutation line as Durable. Product code chooses the
 * roots/extra receipts; ownership traversal, safety, retirement, purge and recovery
 * are shared. No files, attachments, backups or unrelated history are touched. */
export class StorageMaintenance {
  private line: Promise<unknown> = Promise.resolve();
  constructor(private readonly database: SqliteDatabase, private readonly storage: Storage) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.line.then(operation);
    this.line = result.catch(() => {});
    return result;
  }
  private async graph(): Promise<Graph> {
    const schema = await this.database.get<{ version: number }>("SELECT version FROM durable_schema WHERE singleton=1");
    if (schema?.version !== CURRENT_SQLITE_SCHEMA_VERSION) throw new Error("Unsupported Durable schema for permanent deletion.");
    const conversations = await this.database.all<ConversationRow>(
      "SELECT id,owner_conversation_id,owner_task_id,json_extract(record,'$.parent.conversationId') AS parent,json_extract(record,'$.parent.at') AS forkAt FROM conversations");
    const rows = await this.database.all<{ record: string }>("SELECT record FROM tasks");
    return { conversations, tasks: rows.map(row => JSON.parse(row.record) as NativeTask) };
  }

  /** Ownership is directional: deleting a child never includes its parent/history sources. */
  private async owned(graph: Graph, conversationIds: readonly number[], taskIds: readonly number[] = []): Promise<StorageDeletionPlan> {
    const cs = new Set(conversationIds.filter(id => graph.conversations.some(row => row.id === id)));
    const ts = new Set(taskIds.filter(id => graph.tasks.some(row => row.id === id)));
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of graph.tasks) if (!ts.has(task.id) &&
        (cs.has(task.conversationId) || task.owner !== undefined && ts.has(task.owner))) {
        ts.add(task.id); changed = true;
      }
      for (const row of graph.conversations) if (!cs.has(row.id) &&
        (row.owner_conversation_id !== null && cs.has(row.owner_conversation_id) || row.owner_task_id !== null && ts.has(row.owner_task_id))) {
        cs.add(row.id); changed = true;
      }
    }
    if (cs.has(ROOT_CONVERSATION_ID)) throw new StorageDeletionBlocked("Refusing to delete the main conversation.");
    if (graph.conversations.some(row => !cs.has(row.id) && row.parent !== null && cs.has(row.parent)))
      throw new StorageDeletionBlocked("Another conversation inherits this history; deletion requires an explicit fork policy.");
    const documents = await this.documentRecords();
    return { conversations: [...cs], tasks: [...ts], entries: [], documents: documents.filter(record =>
      record.scope.kind === "conversation" && cs.has(record.scope.conversationId) ||
      record.scope.kind === "task" && ts.has(record.scope.taskId)).map(record => Number(record.id)) };
  }
  private async documentRecords(): Promise<DocumentRecord[]> {
    return (await this.database.all<{ record: string }>("SELECT record FROM documents")).map(row => JSON.parse(row.record));
  }
  private async value(record: DocumentRecord) {
    return record.retiredAt === undefined ? (await this.storage.document(record.id, "current", ctx))?.value : undefined;
  }
  /** Anchor and Reporter are siblings in the parent, not native owners of each other. */
  private jobTasks(graph: Graph, children: readonly number[]) {
    return graph.tasks.filter(task =>
      task.kind === ANCHOR_KIND && graph.conversations.some(row => children.includes(row.id) && row.owner_task_id === task.id) ||
      task.kind === REPORTER_KIND && children.includes((task.input as { child?: number } | null)?.child ?? -1)).map(task => Number(task.id));
  }

  async planSideChat(value: string): Promise<SideChatDeletion> {
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) === ROOT_CONVERSATION_ID)
      throw new SideChatError("Side chat not found.");
    const id = Number(value), graph = await this.graph();
    const owner = graph.conversations.find(row => row.id === id);
    if (!owner || owner.owner_conversation_id !== null || owner.owner_task_id !== null) throw new SideChatError("Side chat not found.");
    const documents = await this.documentRecords();
    const markers = documents.filter(record => record.kind === "piko.side-chat" && record.scope.kind === "conversation" && record.scope.conversationId === id);
    const active = markers.find(record => record.retiredAt === undefined);
    const metadata = active && await this.value(active);
    const retired = !metadata?.createdAt && markers.some(record => record.retiredAt !== undefined);
    if (!metadata?.createdAt && !retired) throw new SideChatError("Side chat not found.");
    const plan = await this.owned(graph, [id]);
    for (const record of documents) if (record.scope.kind === "session" && record.kind === "piko.side-chat-creates") {
      const receipt = await this.value(record);
      if (record.retiredAt !== undefined || typeof receipt?.conversationId === "number" && plan.conversations.includes(receipt.conversationId))
        plan.documents.push(Number(record.id));
    }
    return { ...plan, id, retired };
  }

  async planTask(taskId: string, executionConversations: readonly number[], preserveRequestId: string): Promise<TaskStorageDeletion> {
    const graph = await this.graph();
    const plan = await this.owned(graph, executionConversations, this.jobTasks(graph, executionConversations));
    await this.assertIdle(plan);
    for (const record of await this.documentRecords()) {
      if (record.scope.kind !== "conversation" || record.scope.conversationId !== ROOT_CONVERSATION_ID) continue;
      if (record.kind === "piko.tasks" && record.retiredAt !== undefined) plan.documents.push(Number(record.id));
      if (record.kind !== "piko.task-command" || record.key === preserveRequestId) continue;
      const receipt = await this.value(record);
      if (record.retiredAt !== undefined || receipt?.id === taskId || receipt?.hash === "" && receipt.id === "") plan.documents.push(Number(record.id));
    }
    return { ...plan, taskId };
  }

  async planPost(id: number): Promise<StorageDeletionPlan> {
    const row = await this.database.get<{ record: string }>("SELECT record FROM entries WHERE id=?", id);
    if (!row) return { conversations: [], tasks: [], documents: [], entries: [] }; // safe DELETE retry
    const entry = JSON.parse(row.record);
    if (!PublishedPost.is(entry) || entry.conversationId !== ROOT_CONVERSATION_ID || entry.model || entry.head)
      throw new PostError("帖子不存在。", 404);
    const graph = await this.graph();
    // A fork sees parent entries, including app entries. Never silently alter its inherited history.
    if (graph.conversations.some(conversation => conversation.parent === ROOT_CONVERSATION_ID &&
      (conversation.forkAt === null || conversation.forkAt >= id)))
      throw new StorageDeletionBlocked("Another conversation inherits this post; deletion requires an explicit fork policy.");
    const generation = graph.tasks.find(task => task.id === entry.data.generationTaskId);
    if (generation && (generation.kind !== POSTS_GENERATION_KIND || generation.conversationId !== ROOT_CONVERSATION_ID))
      throw new StorageDeletionBlocked("The post generation binding is invalid.");
    const plan = await this.owned(graph, [], generation ? [generation.id] : []);
    plan.entries.push(id);
    await this.postReceipts(plan);
    return plan;
  }
  private async postReceipts(plan: StorageDeletionPlan) {
    for (const record of await this.documentRecords()) if (record.kind === "piko.posts-request" &&
      record.scope.kind === "conversation" && record.scope.conversationId === ROOT_CONVERSATION_ID) {
      const receipt = await this.value(record);
      if (typeof receipt?.taskId === "number" && plan.tasks.includes(receipt.taskId)) plan.documents.push(Number(record.id));
    }
  }

  /** Re-check at retirement AND physical deletion. Unrelated main-chat work can continue. */
  private async assertIdle(plan: StorageDeletionPlan) {
    if (plan.conversations.includes(ROOT_CONVERSATION_ID)) throw new StorageDeletionBlocked("Refusing to delete the main conversation.");
    const selected = new Set(plan.tasks);
    for (const row of await this.database.all<ConversationRow>(
      "SELECT id,owner_conversation_id,owner_task_id,json_extract(record,'$.parent.conversationId') AS parent,json_extract(record,'$.parent.at') AS forkAt FROM conversations")) {
      if (plan.conversations.includes(row.id)) continue;
      if (row.parent !== null && plan.conversations.includes(row.parent) ||
        row.owner_conversation_id !== null && plan.conversations.includes(row.owner_conversation_id) ||
        row.owner_task_id !== null && selected.has(row.owner_task_id) ||
        row.parent === ROOT_CONVERSATION_ID && plan.entries.some(id => row.forkAt === null || row.forkAt >= id))
        throw new StorageDeletionBlocked("The deletion scope has a dependent conversation; re-plan before deleting it.");
    }
    for (const row of await this.database.all<{ record: string }>("SELECT record FROM tasks WHERE status!='terminal'")) {
      const task = JSON.parse(row.record) as NativeTask;
      if (selected.has(task.id) || plan.conversations.includes(task.conversationId) ||
        task.owner !== undefined && selected.has(task.owner) ||
        task.state.status === "waiting" && task.state.on.some(id => selected.has(id)))
        throw new StorageDeletionBlocked("The work is still running or has an active dependency. Stop it and retry deletion.");
    }
    for (const id of plan.conversations) {
      const input = await this.database.get<{ n: number }>("SELECT count(*) AS n FROM submissions WHERE conversation_id=? AND status IN ('queued','placed')", id);
      if (input?.n) throw new StorageDeletionBlocked("The work still has unsettled inputs.");
      // Fail closed even if live metadata and task state disagree.
      for (const row of await this.database.all<{ record: string }>("SELECT record FROM documents WHERE scope_kind='conversation' AND owner_id=? AND retired_at IS NULL AND kind IN (?,?)", id, JSON.stringify("pi.live"), JSON.stringify("pi.inbox"))) {
        const value = await this.value(JSON.parse(row.record));
        if (value?.run || value?.generation || Array.isArray(value?.tools) && value.tools.length ||
          Array.isArray(value?.compactions) && value.compactions.length || Array.isArray(value?.items) && value.items.length)
          throw new StorageDeletionBlocked("The work still has live execution or queued input.");
      }
    }
    // Reporter terminal means admitted, not necessarily consumed by the parent.
    for (const row of await this.database.all<{ record: string }>("SELECT record FROM submissions WHERE status IN ('queued','placed')")) {
      const input = JSON.parse(row.record) as { requestId?: string };
      if (plan.tasks.some(id => input.requestId === `piko:subagent-report:${id}`))
        throw new StorageDeletionBlocked("The parent has not consumed the background report yet.");
    }
  }

  /** Physical deletion always uses one shared implementation. IDs/commit seq never rewind. */
  async purge(plan: StorageDeletionPlan) {
    await this.assertIdle(plan);
    await this.database.transaction(async tx => {
      for (const id of plan.documents) {
        const row = await tx.get<{ retired_at: number | null }>("SELECT retired_at FROM documents WHERE id=?", id);
        if (row?.retired_at === null) throw new Error("Native documents must be retired before purging their storage.");
      }
      for (const id of plan.conversations) {
        await tx.run("DELETE FROM record_ids WHERE id IN (SELECT id FROM entries WHERE conversation_id=? UNION SELECT id FROM submissions WHERE conversation_id=?)", id, id);
        await tx.run("DELETE FROM entries WHERE conversation_id=?", id);
        await tx.run("DELETE FROM submissions WHERE conversation_id=?", id);
        await tx.run("DELETE FROM conversations WHERE id=?", id);
        await tx.run("DELETE FROM record_ids WHERE id=?", id);
      }
      for (const id of plan.tasks) {
        await tx.run("DELETE FROM tasks WHERE id=?", id);
        await tx.run("DELETE FROM record_ids WHERE id=?", id);
      }
      for (const id of plan.documents) {
        await tx.run("DELETE FROM document_revisions WHERE document_id=?", id);
        await tx.run("DELETE FROM documents WHERE id=?", id);
        await tx.run("DELETE FROM record_ids WHERE id=?", id);
      }
      for (const id of plan.entries) {
        await tx.run("DELETE FROM entries WHERE id=?", id);
        await tx.run("DELETE FROM record_ids WHERE id=?", id);
      }
    });
  }

  private async finishPending(harness: Harness) {
    const pending = (await harness.snapshot(StorageDeletion, ctx))?.pending;
    if (!pending) return;
    const plan: StorageDeletionPlan = JSON.parse(JSON.stringify(pending));
    await harness.commit(() => this.purge(plan), ctx);
    await harness.commit(async tx => { (await tx.doc(StorageDeletion)).pending = null; }, ctx);
  }
  private async erasePlan(harness: Harness, planner: () => Promise<StorageDeletionPlan | undefined>, compact: boolean) {
    await this.finishPending(harness);
    let plan: StorageDeletionPlan | undefined;
    await harness.commit(async tx => {
      plan = await planner();
      if (!plan) return;
      await this.assertIdle(plan);
      plan = { conversations: plan.conversations, tasks: plan.tasks, documents: [...new Set(plan.documents)], entries: plan.entries };
      (await tx.doc(StorageDeletion)).pending = plan;
      if (compact) (await tx.doc(StorageCleanup)).required = true;
      const ids = new Set(plan.documents);
      for (const record of await this.documentRecords()) if (ids.has(Number(record.id))) await retireDocument(tx, record);
    }, ctx);
    await this.finishPending(harness);
    return plan;
  }
  erase(harness: Harness, value: string) {
    return this.serial(async () => {
      const resuming = (await harness.snapshot(StorageDeletion, ctx))?.pending?.conversations.includes(Number(value));
      return this.erasePlan(harness, async () => {
        if (resuming && !(await this.database.get("SELECT id FROM conversations WHERE id=?", Number(value)))) return;
        return this.planSideChat(value);
      }, true);
    });
  }
  eraseTask(harness: Harness, taskId: string, executionConversations: readonly number[], preserveRequestId: string) {
    return this.serial(() => this.erasePlan(harness, () => this.planTask(taskId, executionConversations, preserveRequestId), true));
  }
  erasePost(harness: Harness, id: number) {
    return this.serial(async () => {
      await this.erasePlan(harness, () => this.planPost(id), true);
      await this.compactNow(harness);
    });
  }

  /** Only known transient work: root delegations, memory review, and unpublished post generations.
   * Saved-task/side-chat executions and published post research follow their business owner instead. */
  async retentionCandidates(): Promise<RetentionTarget[]> {
    const graph = await this.graph();
    const result: RetentionTarget[] = [];
    for (const task of graph.tasks) {
      const kind = await this.retentionKind(graph, task);
      if (kind) result.push({ kind, taskId: Number(task.id) });
    }
    return result;
  }
  private async retentionKind(graph: Graph, task: NativeTask): Promise<RetentionTarget["kind"] | undefined> {
    if (task.state.status !== "terminal" || !task.background || task.owner !== undefined ||
      task.conversationId !== ROOT_CONVERSATION_ID && graph.conversations.some(row => row.id === task.conversationId)) return;
    if (task.kind === "piko.memory-curation" || task.kind === "piko.wiki-curation") return "memory";
    if (task.kind === POSTS_GENERATION_KIND) {
      const post = await this.database.get<{ id: number }>(
        "SELECT id FROM entries WHERE conversation_id=? AND json_extract(record,'$.kind')=? AND json_extract(record,'$.data.generationTaskId')=? LIMIT 1",
        ROOT_CONVERSATION_ID, PublishedPost.kind, task.id);
      if (!post) return "posts";
    }
    if (task.kind !== ANCHOR_KIND) return;
    const children = graph.conversations.filter(row => row.owner_task_id === task.id);
    if (!children.length) return;
    for (const child of children) {
      const docs = await this.database.all<{ record: string }>(
        "SELECT record FROM documents WHERE scope_kind='conversation' AND owner_id=? AND kind IN (?,?) AND retired_at IS NULL",
        child.id, JSON.stringify("piko.background-job"), JSON.stringify("piko.task-context"));
      let delegation = false;
      for (const row of docs) {
        const record = JSON.parse(row.record) as DocumentRecord;
        const value = await this.value(record);
        if (record.kind === "piko.task-context" && value?.binding) return; // saved execution, never generic TTL
        if (record.kind === "piko.background-job") delegation = (value?.policy as { kind?: string } | undefined)?.kind === "delegation";
      }
      if (!delegation) return; // unknown purpose: fail closed
    }
    return "delegation";
  }
  private async planExpired(target: RetentionTarget, cutoff: number): Promise<StorageDeletionPlan | undefined> {
    const graph = await this.graph();
    const task = graph.tasks.find(row => row.id === target.taskId);
    if (!task || await this.retentionKind(graph, task) !== target.kind) return;
    const children = graph.conversations.filter(row => row.owner_task_id === target.taskId).map(row => row.id);
    const plan = await this.owned(graph, [], [target.taskId, ...(target.kind === "delegation" ? this.jobTasks(graph, children) : [])]);
    const tasks = graph.tasks.filter(task => plan.tasks.includes(task.id));
    // No trustworthy completion timestamp: retain rather than guessing from a numeric ID.
    if (tasks.some(task => task.state.status !== "terminal" || task.endedAt === undefined || task.endedAt > cutoff)) return;
    if (target.kind === "memory") {
      const row = (await this.documentRecords()).find(record => record.kind === task.kind &&
        record.scope.kind === "conversation" && record.scope.conversationId === ROOT_CONVERSATION_ID && record.retiredAt === undefined);
      if ((row && (await this.value(row))?.activeTaskId) === target.taskId) return;
    }
    for (const record of await this.documentRecords()) if (record.kind === "piko.subagent-control" &&
      record.scope.kind === "conversation" && plan.conversations.includes(record.scope.conversationId)) {
      const touched = (await this.value(record))?.lastActivityAt;
      if (typeof touched === "number" && touched > cutoff) return;
    }
    for (const id of plan.conversations) {
      const row = await this.database.get<{ latest: number | null }>(
        "SELECT max(json_extract(message.value,'$.timestamp')) AS latest FROM entries e,json_each(e.record,'$.model') message WHERE e.conversation_id=?", id);
      if (row?.latest !== null && row?.latest !== undefined && row.latest > cutoff) return;
    }
    if (target.kind === "posts") await this.postReceipts(plan);
    await this.assertIdle(plan);
    return plan;
  }
  /** A dry run and real deletion use the same eligibility checks; real runs re-plan on the mutation line. */
  async previewExpired(harness: Harness, target: RetentionTarget, cutoff: number) {
    return harness.commit(() => this.planExpired(target, cutoff), ctx);
  }
  eraseExpired(harness: Harness, target: RetentionTarget, cutoff: number) {
    return this.serial(() => this.erasePlan(harness, () => this.planExpired(target, cutoff), false));
  }

  /** Finish irreversible intents before resuming the scheduler. Legacy business intents remain supported. */
  async recover(harness: Harness) {
    await this.serial(() => this.finishPending(harness));
    const pending = await this.database.all<{ id: number }>(
      "SELECT DISTINCT c.id FROM conversations c JOIN documents d ON d.scope_kind='conversation' AND d.owner_id=c.id WHERE c.id!=1 AND c.owner_conversation_id IS NULL AND c.owner_task_id IS NULL AND d.kind=? AND d.retired_at IS NOT NULL", JSON.stringify("piko.side-chat"));
    for (const row of pending) await this.erase(harness, String(row.id));
    await this.compactIfRequired(harness);
  }
  async compactIfRequired(harness: Harness) {
    if ((await harness.snapshot(StorageCleanup, ctx))?.required) await this.compact(harness);
  }
  /** Explicit permanent deletion retains its checkpoint/VACUUM contract. TTL only frees reusable pages. */
  compact(harness: Harness) {
    return this.serial(async () => {
      await this.finishPending(harness);
      await this.compactNow(harness);
    });
  }
  private async compactNow(harness: Harness) {
    await harness.commit(async tx => {
      const checkpoint = async () => {
        const rows = await this.database.all<{ busy: number }>("PRAGMA wal_checkpoint(TRUNCATE)");
        if (rows.some(row => row.busy)) throw new Error("Database checkpoint is busy; retry deletion to finish storage cleanup.");
      };
      await checkpoint();
      await this.database.exec("VACUUM");
      await checkpoint();
      (await tx.doc(StorageCleanup)).required = false;
    }, ctx);
  }
}

/** Retirement is native: it evicts Session trackers and notifies observers. */
export async function retireDocument(tx: Tx, record: DocumentRecord) {
  if (record.retiredAt !== undefined) return;
  const definition = { kind: record.kind, version: 1, checkpointWhen: () => false };
  const key = record.key;
  if (record.scope.kind === "session") {
    if (key === undefined) await tx.retireDoc(defineDoc({ ...definition, scope: "session", initial: () => ({}) }));
    else await tx.retireDoc(defineDocFamily({ ...definition, scope: "session", family: true, initial: () => ({}) }), key);
  } else if (record.scope.kind === "task") {
    if (key === undefined) await tx.retireDoc(defineDoc({ ...definition, scope: "task", initial: () => ({}) }), record.scope.taskId);
    else await tx.retireDoc(defineDocFamily({ ...definition, scope: "task", family: true, initial: () => ({}) }), record.scope.taskId, key);
  } else if (record.history === "latest") {
    const options = { ...definition, scope: "conversation" as const, history: "latest" as const, fork: record.fork };
    if (key === undefined) await tx.retireDoc(defineDoc({ ...options, initial: () => ({}) }), record.scope.conversationId);
    else await tx.retireDoc(defineDocFamily({ ...options, family: true, initial: () => ({}) }), record.scope.conversationId, key);
  } else {
    const options = { ...definition, scope: "conversation" as const, history: "rewindable" as const, fork: record.fork ?? "initial" };
    if (key === undefined) await tx.retireDoc(defineDoc({ ...options, initial: () => ({}) }), record.scope.conversationId);
    else await tx.retireDoc(defineDocFamily({ ...options, family: true, initial: () => ({}) }), record.scope.conversationId, key);
  }
}
