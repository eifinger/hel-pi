import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isWithin } from "./workspace";
import { AssistantTaskError, taskId } from "./domain/tasks";
import { codePointLength } from "./text";

const TASK_MEMORY_TEMPLATE = "# Task memory\n\nKeep reusable findings and progress here; save intermediate materials alongside this file.\n";

/** Explicit paths, no title-derived directory names, no symlink traversal in product file APIs. */
export class TaskFiles {
  constructor(readonly workspace: string) {}
  directory(id: string) {
    return join(this.workspace, "tasks", taskId(id));
  }
  /** Best-effort character count for prompt guidance; Reporter preflight owns path failures. */
  async memoryCharacters(id: string): Promise<number | undefined> {
    const path = join(this.directory(id), "MEMORY.md");
    try {
      await this.checked(path, false);
      return codePointLength(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return codePointLength(TASK_MEMORY_TEMPLATE);
      return undefined;
    }
  }
  private async checked(path: string, directory: boolean) {
    const base = await realpath(this.workspace);
    if (!isWithin(base, resolve(path)))
      throw new AssistantTaskError("Path escapes the workspace.");
    const relative = path
      .slice(this.workspace.length)
      .split(/[\\/]/)
      .filter(Boolean);
    let current = this.workspace;
    for (const part of relative) {
      current = join(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink())
        throw new AssistantTaskError(
          "Symbolic links are not supported in task paths.",
        );
    }
    const info = await lstat(path);
    if (directory ? !info.isDirectory() : !info.isFile())
      throw new AssistantTaskError("Invalid task file type.");
    if (
      !isWithin(base, await realpath(path)) ||
      (await realpath(path)) !== resolve(path)
    )
      throw new AssistantTaskError("Path escapes its declared task location.");
    return info;
  }
  async prepare(id: string) {
    // Check each existing parent before mkdir; never follow a pre-existing directory link.
    const paths = [join(this.workspace, "tasks"), this.directory(id)];
    for (const path of paths) {
      try {
        await mkdir(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await this.checked(path, true);
    }
    const memory = join(this.directory(id), "MEMORY.md");
    try {
      const file = await open(
        memory,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        await file.writeFile(TASK_MEMORY_TEMPLATE);
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await this.checked(memory, false);
  }
  async remove(id: string) {
    const parent = join(this.workspace, "tasks");
    const directory = this.directory(id);
    try {
      await this.checked(parent, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let info;
    try {
      info = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    // Unlink a task-directory symlink itself; never follow it into another workspace.
    if (info.isSymbolicLink()) {
      await rm(directory);
      return;
    }
    await this.checked(directory, true);
    await rm(directory, { recursive: true });
  }
}
