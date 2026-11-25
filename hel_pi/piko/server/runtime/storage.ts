import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { StorageMaintenance } from "./storage-maintenance";

export const STORAGE_FILE = "session.sqlite";

/** One native Durable database; no automatic import, fallback or second transcript store. */
export async function openRuntimeStorage(directory: string) {
  if (existsSync(directory) && (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory))
    throw new Error("Durable storage must be a regular directory, not a symlink.");
  if (existsSync(directory) && readdirSync(directory).some(name => name.endsWith(".jsonl")))
    throw new Error("Unsupported legacy storage found. Piko only supports Durable SQLite; use a new PIKO_HOME to start fresh.");
  const file = join(directory, STORAGE_FILE);
  if (existsSync(file) && (!lstatSync(file).isFile() || realpathSync(file) !== file))
    throw new Error("Durable SQLite storage must be a regular file, not a symlink.");
  const persisted = existsSync(file);
  if (!persisted && existsSync(directory) && readdirSync(directory).length)
    throw new Error("Durable session.sqlite is missing from a nonempty storage directory. Restore the complete database; refusing to initialize an empty session.");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const database = await openNodeSqliteDatabase(file);
  try {
    chmodSync(file, 0o600);
    for (const suffix of ["-wal", "-shm"])
      if (existsSync(file + suffix)) chmodSync(file + suffix, 0o600);
    // FULL retains the previous fsync durability intent. secure_delete covers deleted
    // database cells, not old backups, filesystem snapshots or uncheckpointed WAL.
    await database.exec("PRAGMA synchronous = FULL");
    await database.exec("PRAGMA secure_delete = ON");
    const storage = await SqliteStorage.open(database);
    return { storage, persisted, maintenance: new StorageMaintenance(database, storage) };
  } catch (error) {
    await database.close();
    throw error;
  }
}
