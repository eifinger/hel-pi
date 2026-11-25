import type { Agent } from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/** The model a background child starts with; Piko resolves an explicit background profile or follows the global main model. */
export type BackgroundSelection = { provider: string; modelId: string; thinkingLevel: ModelThinkingLevel };

/** Without a background profile a child keeps inheriting the main conversation's selection. */
export function backgroundAgent(selection: BackgroundSelection | undefined, parent: Pick<Agent, "model" | "thinkingLevel">) {
  return selection
    ? { model: { provider: selection.provider, modelId: selection.modelId }, thinkingLevel: selection.thinkingLevel }
    : { model: parent.model, thinkingLevel: parent.thinkingLevel };
}

export const BACKGROUND_AGENT_INSTRUCTIONS = "You are a background workspace assistant delegated from a conversation. Complete the assigned work using the provided task context and available tools, then return your findings to that conversation only. You do not receive the parent conversation or its global memory. Your answer is internal; the delegating assistant decides what to tell the user.";

/** Background children never delegate or manage tasks, and never re-enter the curation task. */
const CHILD_TOOL_PREFIXES = ["subagent_", "task_", "sessions_", "posts_"];
const TASK_TOOL_PREFIXES = ["task_", "posts_"];
const CHILD_EXTENSIONS = ["piko-subagents", "piko-subagent-tools", "piko-tasks", "piko-memory-curation", "piko-wiki-curation", "piko-session-search", "piko-posts", "piko-posts-generation", "piko-sent-attachments", "piko-widgets"];
const TASK_EXTENSIONS = ["piko-tasks", "piko-memory-curation", "piko-wiki-curation", "piko-posts", "piko-posts-generation"]

/** One place for what a background child may inherit from the main agent. */
export function childScope(agent: Agent) {
  return {
    extensions: agent.extensions.filter(value => !CHILD_EXTENSIONS.includes(value.name)),
    tools: [...agent.tools, ...agent.deferred].filter(value => value.name !== "send_attachment" && value.name !== "show_widget" && !CHILD_TOOL_PREFIXES.some(prefix => value.name.startsWith(prefix))),
  };
}

/** Side chats may delegate, but cannot manage saved tasks or curate shared memory. */
export function sideChatScope(agent: Agent) {
  return {
    extensions: agent.extensions.filter(value => !TASK_EXTENSIONS.includes(value.name)),
    tools: [...agent.tools, ...agent.deferred].filter(value => !TASK_TOOL_PREFIXES.some(prefix => value.name.startsWith(prefix))),
  };
}
