import { join } from "node:path";
import { defineDoc, type ConversationId, type Tx } from "@earendil-works/pi-durable";

/** Prompt inputs only. These choices do not restrict file, network or credential access. */
export type AgentResourcePolicy = {
  core: boolean;
  guidance: boolean;
  /** Explicit guidance-file paths; not a second copy of their contents. */
  memory: string[];
  /** Workspace skill index, an explicit name allowlist, or [] for no skills. */
  skills: "workspace" | string[];
};

export const NO_AGENT_RESOURCES: AgentResourcePolicy = {
  core: false, guidance: false, memory: [], skills: [],
};

export function workspaceAgentResources(workspace: string): AgentResourcePolicy {
  return { core: true, guidance: true, memory: [join(workspace, "MEMORY.md")], skills: "workspace" };
}

/** AgentDoc remains the authority for model, cwd, instructions, extensions and tools. */
export const AgentResources = defineDoc<{ policy: AgentResourcePolicy | null }>({
  kind: "piko.agent-resources", version: 1, scope: "conversation", history: "latest", fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ policy: null }),
});

export async function setAgentResources(tx: Tx, child: ConversationId, policy: AgentResourcePolicy) {
  (await tx.doc(AgentResources, child)).policy = {
    ...policy, memory: [...policy.memory], skills: policy.skills === "workspace" ? "workspace" : [...policy.skills],
  };
}

/** Bootstrap missing policy metadata without replacing an agent's established choices. */
export async function initializeAgentResources(tx: Tx, child: ConversationId, policy: AgentResourcePolicy) {
  if (!(await tx.doc(AgentResources, child)).policy) await setAgentResources(tx, child, policy);
}
