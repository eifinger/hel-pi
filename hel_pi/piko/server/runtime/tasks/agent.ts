import { join } from "node:path";
import type { Agent, ConversationId, Harness, Tx } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { TaskFiles } from "../../task-files";
import { MEMORY_FILE_LIMIT_CHARS } from "../../domain/memory-curation";
import { BACKGROUND_AGENT_INSTRUCTIONS, backgroundAgent, childScope, type BackgroundSelection } from "../background";
import { initializeAgentResources, type AgentResourcePolicy } from "../agents/resources";
import type { SubagentRuntime } from "../subagents/runtime";
import { BackgroundJob, type BackgroundJobPolicy } from "../subagents/documents";
import type { InputSource } from "../types";
import { TaskContext, type TaskBinding } from "./context";

function resources(files: TaskFiles, taskId: string): AgentResourcePolicy {
  return { core: false, guidance: false, memory: [join(files.directory(taskId), "MEMORY.md")], skills: "workspace" };
}
function policy(binding: TaskBinding, child: ConversationId): BackgroundJobPolicy {
  return {
    kind: "task", continuable: false,
    report: {
      heading: `Saved task ${JSON.stringify(binding.title)} (${binding.taskId}), execution ${child}. This is the task's persistent directory under tasks/${binding.taskId}/ in the main workspace.\n\n`,
      deliver: "all",
    },
  };
}
function prompt(message: string, binding: TaskBinding, child: ConversationId, directory: string, memoryCharacters?: number) {
  const memory = `Task MEMORY.md: current size ${memoryCharacters ?? "unavailable"} Unicode code points (characters); soft limit ${MEMORY_FILE_LIMIT_CHARS} characters. If it is near or over the limit, update it using the existing memory-maintenance policy: merge or condense entries, remove content that is superseded, duplicated, or no longer useful, and preserve meaningful reusable outcomes; do not truncate blindly.`;
  return `${message}\n\nThis is task ${JSON.stringify(binding.title)} (${binding.taskId}), execution ${child}. ${binding.scheduledAt === null ? "Manually started." : `Scheduled at ${new Date(binding.scheduledAt).toISOString()}.`} Started at ${new Date(binding.startedAt).toISOString()}. Your working directory is the main workspace. Use ${JSON.stringify(directory)} for intermediate materials and retained copies as needed. Keep reusable findings and progress in ${JSON.stringify(join(directory, "MEMORY.md"))}. ${memory}`;
}

/** Task business prepares the directory, role, resources and fixed input; the runner only drives execution. */
export async function spawnTaskAgent(tx: Tx, children: SubagentRuntime, files: TaskFiles,
  agent: Agent, selection: BackgroundSelection | undefined, owner: ConversationId,
  message: string, binding: TaskBinding, source: InputSource) {
  const model = backgroundAgent(selection, agent);
  const memoryCharacters = await files.memoryCharacters(binding.taskId);
  const child = await children.spawn(tx, {
    owner, source,
    agent: {
      agent: { ...model, model: model.model ?? null, cwd: files.workspace,
        ...childScope(agent), instructions: BACKGROUND_AGENT_INSTRUCTIONS },
      resources: resources(files, binding.taskId),
    },
    message: child => prompt(message, binding, child, files.directory(binding.taskId), memoryCharacters),
    policy: child => policy(binding, child),
  });
  (await tx.doc(TaskContext, child)).binding = binding;
  return child;
}

/** Preflight runs inside the Reporter lifecycle, so a bad directory produces a failed execution, not a schedule retry loop. */
export async function prepareTaskAgent(harness: Harness, child: ConversationId, files: TaskFiles, ctx: Context) {
  const binding = (await harness.snapshot(TaskContext, child, ctx))?.binding;
  if (binding) await files.prepare(binding.taskId);
}

/** Initialize policy metadata for stored task executions without resetting their AgentDoc. */
export async function initializeTaskAgent(tx: Tx, child: ConversationId, files: TaskFiles): Promise<boolean> {
  const binding = (await tx.doc(TaskContext, child)).binding;
  if (!binding) return false;
  await initializeAgentResources(tx, child, resources(files, binding.taskId));
  const job = await tx.doc(BackgroundJob, child);
  job.policy ??= policy(binding, child);
  return true;
}

export async function markTaskInterrupted(tx: Tx, child: ConversationId) {
  const binding = (await tx.doc(TaskContext, child)).binding;
  if (binding) binding.interrupted = true;
}
