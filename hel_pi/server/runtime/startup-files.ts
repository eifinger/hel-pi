import { link, lstat, mkdir, readdir, rm, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isSnapshotId } from "../attachments/store";

async function info(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Move old assistant snapshots into the common attachment directory without invalidating IDs. */
export async function migrateSentAttachments(state: string): Promise<number> {
  const legacy = join(state, "sent-attachments");
  const old = await info(legacy);
  if (!old) return 0;
  if (!old.isDirectory()) throw new Error("Legacy attachment directory is not a directory.");
  const target = join(state, "attachments");
  await mkdir(target, { recursive: true, mode: 0o700 });
  if (!(await info(target))?.isDirectory()) throw new Error("Attachment directory is not a directory.");
  const names = await readdir(legacy);
  // Preflight the entire directory. Never overwrite a pre-existing unrelated attachment.
  for (const name of names) {
    const source = await info(join(legacy, name));
    if (!isSnapshotId(name) || !source?.isFile()) throw new Error("Unexpected legacy attachment entry.");
    const existing = await info(join(target, name));
    if (existing && (!existing.isFile() || existing.dev !== source.dev || existing.ino !== source.ino))
      throw new Error("Attachment migration encountered a conflicting file.");
  }
  for (const name of names) {
    const source = join(legacy, name), destination = join(target, name);
    // A hard link is exclusive and atomic; a crash before unlink is safe to resume by inode.
    if (!await info(destination)) await link(source, destination);
    const from = await info(source), to = await info(destination);
    if (!from?.isFile() || !to?.isFile() || from.dev !== to.dev || from.ino !== to.ino)
      throw new Error("Attachment migration encountered a conflicting file.");
    await unlink(source);
  }
  await rmdir(legacy);
  return names.length;
}

/** Run only after acquiring the backend lock and before starting any runtime work. */
export async function clearRuntimeTemp(state: string): Promise<void> {
  const directory = join(state, "tmp");
  // rm does not traverse a directory symlink, and recreating the directory avoids retaining one.
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });
}
