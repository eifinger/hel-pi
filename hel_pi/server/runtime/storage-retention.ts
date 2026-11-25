import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import { logInfo, logWarn } from "../logging";
import { StorageDeletion, StorageDeletionBlocked } from "./storage-deletion";
import type { StorageMaintenance } from "./storage-maintenance";

export const STORAGE_RETENTION_INTERVAL_MS = 24 * 60 * 60_000;
export const STORAGE_RETENTION_TTL_MS = 7 * STORAGE_RETENTION_INTERVAL_MS;
export const StorageRetention = defineDoc<{ lastCheckedAt: number }>({
  kind: "piko.storage-retention", version: 1, scope: "session",
  checkpointWhen: () => true, initial: () => ({ lastCheckedAt: 0 }),
});

/** Daily, restart-stable housekeeping, not a Durable task that leaves a new execution history. */
export class StorageRetentionService {
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private closing = false;
  constructor(private readonly harness: Harness, private readonly maintenance: StorageMaintenance, private readonly now = Date.now) {}

  async start() {
    const last = await this.harness.commit(async tx => {
      const state = await tx.doc(StorageRetention);
      if (!state.lastCheckedAt) state.lastCheckedAt = this.now(); // first sweep after 24 hours, not at deployment
      return state.lastCheckedAt;
    }, ctx);
    this.arm(Math.max(0, last + STORAGE_RETENTION_INTERVAL_MS - this.now()));
  }
  private arm(delay: number) {
    if (this.closing) return;
    const run = async () => {
      let next = STORAGE_RETENTION_INTERVAL_MS;
      try { await this.tick(); }
      catch {
        if (!this.closing) logWarn("storage.retention.failed");
        next = 60 * 60_000;
      } finally { this.arm(next); }
    };
    this.timer = setTimeout(() => void run(), delay);
    this.timer.unref();
  }
  tick(): Promise<void> {
    if (this.closing) return Promise.resolve();
    return this.pending ??= this.sweep().finally(() => { this.pending = undefined; });
  }
  private async sweep() {
    const now = this.now();
    const last = (await this.harness.snapshot(StorageRetention, ctx))?.lastCheckedAt ?? now;
    if (now - last < STORAGE_RETENTION_INTERVAL_MS) return;
    const targets = await this.harness.commit(() => this.maintenance.retentionCandidates(), ctx);
    let deleted = 0, skipped = 0;
    for (const target of targets) {
      if (this.closing) return;
      try {
        // One bounded ownership tree per transaction sequence; yield between targets.
        if (await this.maintenance.eraseExpired(this.harness, target, now - STORAGE_RETENTION_TTL_MS)) deleted++;
        else skipped++;
      } catch (error) {
        if (!(error instanceof StorageDeletionBlocked) || (await this.harness.snapshot(StorageDeletion, ctx))?.pending) throw error;
        skipped++;
      }
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    await this.harness.commit(async tx => { (await tx.doc(StorageRetention)).lastCheckedAt = now; }, ctx);
    logInfo("storage.retention.completed", { deleted, skipped });
  }
  async close() {
    this.closing = true;
    clearTimeout(this.timer);
    await this.pending?.catch(() => {});
  }
}
