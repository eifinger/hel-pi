import type { LiveState } from "@earendil-works/pi-durable";
import type { ConversationActivity } from "../../shared/chat";
import { summarizeToolArgs } from "./tool-activity";

/** Native Durable state restores the active tool/text; absent evidence starts with thinking. */
export function activityFromLive(live: LiveState, busy: boolean, argumentsForTool: (callId: string) => unknown = () => undefined): ConversationActivity {
  if (!busy) return { kind: "idle" };
  const tool = [...(live.tools ?? []), ...(live.nestedTools ?? [])].findLast(
    slot => slot.status === "running",
  );
  if (tool) {
    const summary = tool.name === "subagent_spawn"
      ? summarizeToolArgs(tool.name, "arguments" in tool ? tool.arguments : argumentsForTool(tool.callId)) : "";
    return { kind: "tool", name: tool.name, ...(summary ? { summary } : {}) };
  }
  if (live.generation?.retry || live.generation?.deferred) return { kind: "thinking" };
  const content = live.generation?.message?.content;
  const block = Array.isArray(content)
    ? content.findLast(block =>
        block.type === "text"
          ? !!block.text.trim()
          : block.type === "thinking"
            ? !!block.thinking.trim()
            : true,
      )
    : undefined;
  return { kind: block?.type === "text" ? "replying" : "thinking" };
}

/** Idle/thinking refreshes must not erase the last tool or reply signal. */
export class ConversationActivityProjection {
  private current: ConversationActivity = { kind: "idle" };

  constructor(
    private readonly emit: (activity: ConversationActivity) => void,
    private readonly argumentsForTool: (callId: string) => unknown = () => undefined,
  ) {}

  snapshot(live: LiveState, busy: boolean): ConversationActivity {
    const native = activityFromLive(live, busy, this.argumentsForTool);
    if (native.kind !== "thinking") return native;
    return busy && (this.current.kind === "tool" || this.current.kind === "replying")
      ? this.current : native;
  }

  restore(live: LiveState, busy: boolean) {
    this.publish(this.snapshot(live, busy));
  }

  runStarted() { this.publish({ kind: "thinking" }); }
  runEnded() { this.publish({ kind: "idle" }); }
  toolStarted(name: string, summary?: string) {
    this.publish({ kind: "tool", name, ...(name === "subagent_spawn" && summary ? { summary } : {}) });
  }
  replying() { this.publish({ kind: "replying" }); }

  private publish(activity: ConversationActivity) {
    if (JSON.stringify(this.current) === JSON.stringify(activity)) return;
    this.current = activity;
    this.emit(activity);
  }
}
