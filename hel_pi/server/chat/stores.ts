import type { ConversationRuntime } from "../runtime/types";
import { ConversationStore } from "./conversations";

/** One output publication line per user-visible conversation; never includes internal children. */
export class ConversationStores {
  readonly main: ConversationStore;
  private readonly sides = new Map<string, ConversationStore>();
  constructor(private readonly runtime: Pick<ConversationRuntime, "createSession">) { this.main = new ConversationStore(runtime); }
  async side(id: string) {
    // Validate even for cached stores: only user side chats may be addressed by this route.
    await this.runtime.createSession(id);
    let store = this.sides.get(id);
    if (!store) { store = new ConversationStore(this.runtime, id); this.sides.set(id, store); }
    return store;
  }
  async forget(id: string) {
    const store = this.sides.get(id);
    this.sides.delete(id);
    await store?.close();
  }
  async close() {
    await Promise.allSettled([this.main, ...this.sides.values()].map(store => store.close()));
    this.sides.clear();
  }
}
