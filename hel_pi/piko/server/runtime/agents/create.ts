import {
  configure, type AgentChange, type ConversationId, type EntryId, type TaskId, type Tx,
} from "@earendil-works/pi-durable";
import { setAgentResources, type AgentResourcePolicy } from "./resources";

/** The caller chooses context, capabilities and role; this layer knows no task business. */
export type ChildAgentSpec = {
  history?: { conversationId: ConversationId; at: EntryId };
  agent: AgentChange & Required<Pick<AgentChange, "model" | "thinkingLevel" | "cwd" | "instructions" | "extensions" | "tools">>;
  resources: AgentResourcePolicy;
};

/** Native ownership and fork semantics; all configuration is committed before work can start. */
export async function createChildAgent(tx: Tx, owner: TaskId, spec: ChildAgentSpec): Promise<ConversationId> {
  const ownership = { kind: "task" as const, taskId: owner };
  const child = spec.history
    ? await tx.forkConversation(spec.history.conversationId, spec.history.at, { ownership })
    : await tx.createConversation({ ownership });
  // Task-owned creation and forks inherit AgentDoc. Do not accidentally keep a parent's model-tool filter.
  await configure(tx, child.id, { ...spec.agent, modelTools: spec.agent.modelTools ?? null });
  await setAgentResources(tx, child.id, spec.resources);
  return child.id;
}
