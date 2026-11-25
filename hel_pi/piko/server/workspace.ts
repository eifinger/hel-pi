import {
  mkdirSync,
  realpathSync,
  writeFileSync,
  lstatSync,
  readFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { defaultPikoFile } from "./config/defaults";

export type WorkspacePaths = {
  home: string;
  workspace: string;
  state: string;
  resources: string;
};

export function workspacePaths(
  home: string,
  workspace = join(home, "workspace"),
): WorkspacePaths {
  if (!isAbsolute(home) || !isAbsolute(workspace))
    throw new Error("Piko home and workspace must be absolute paths.");
  return {
    home: resolve(home),
    workspace: resolve(workspace),
    state: resolve(home, "state"),
    resources: resolve(import.meta.dir, "resources"),
  };
}

export function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  );
}

/** No overwrite: repeated startup keeps user-authored files and rejects type conflicts. */
export function initializeWorkspace(paths: WorkspacePaths): WorkspacePaths {
  mkdirSync(paths.workspace, { recursive: true });
  mkdirSync(paths.state, { recursive: true });
  const workspace = realpathSync(paths.workspace);
  const state = realpathSync(paths.state);
  if (isWithin(workspace, state))
    throw new Error("Piko state must be outside the assistant workspace.");
  for (const directory of ["config", "state/durable", "state/tmp"]) {
    const path = join(paths.home, directory);
    mkdirSync(path, { recursive: true });
    if (!isWithin(realpathSync(paths.home), realpathSync(path)))
      throw new Error(`Piko data directory escapes its root: ${directory}`);
  }
  for (const [name, value] of Object.entries({
    "piko.json": defaultPikoFile,
    "models.json": { providers: {} },
    "mcp.json": { mcpServers: {} },
  })) {
    try {
      writeFileSync(
        join(paths.home, "config", name),
        JSON.stringify(value, null, 2) + "\n",
        { flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  for (const directory of [
    ".agents",
    ".agents/skills",
    "memory",
    "projects",
    "artifacts",
  ]) {
    const path = join(workspace, directory);
    mkdirSync(path, { recursive: true });
    if (!isWithin(workspace, realpathSync(path)))
      throw new Error(`Workspace directory escapes its root: ${directory}`);
  }
  for (const name of ["AGENTS.md", "MEMORY.md"]) {
    const path = join(workspace, name);
    const template = readGuidance(join(paths.resources, "templates"), name);
    try {
      writeFileSync(path, template, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!lstatSync(path).isFile())
      throw new Error(`Workspace guidance must be a regular file: ${name}`);
  }
  return { ...paths, home: realpathSync(paths.home), workspace, state };
}

/** Read the complete validated guidance file; never silently truncate prompt text. */
export function readGuidance(root: string, name: string): string {
  const path = join(root, name);
  const stat = lstatSync(path);
  if (!stat.isFile() || !isWithin(realpathSync(root), realpathSync(path)))
    throw new Error(`Invalid guidance file: ${name}`);
  return readFileSync(path, "utf8");
}
