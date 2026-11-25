import {
  mkdirSync,
  realpathSync,
  writeFileSync,
  lstatSync,
  readFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { defaultPikoFile } from "./config/defaults";
import { scopedDirectory } from './scoped-files';

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
  if (!lstatSync(paths.workspace).isDirectory()) throw new Error('The memory workspace must not be a symbolic link.');
  const workspace = realpathSync(paths.workspace);
  const state = realpathSync(paths.state);
  const config = join(paths.home, 'config');
  if (workspace !== paths.workspace || state !== paths.state || [state, config].some(privateDir => isWithin(workspace, privateDir) || isWithin(privateDir, workspace)))
    throw new Error('Private configuration and state must not overlap the assistant workspace or follow directory links.');
  for (const directory of ["config", "state/durable", "state/tmp"]) {
    scopedDirectory(paths.home, directory.split('/'), true, () => {});
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
    ".agents/skills",
    "memory",
    "projects",
    "artifacts",
    "wiki",
  ]) {
    scopedDirectory(workspace, directory.split('/'), true, () => {});
  }
  return { ...paths, home: realpathSync(paths.home), workspace, state };
}

/** Posts use complete memory documents or omit them, like chat. */
export function readGuidance(root: string, name: string): string {
  const path = join(root, name);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || !isWithin(realpathSync(root), realpathSync(path)))
    throw new Error(`Invalid guidance file: ${name}`);
  if (stat.size > 65_536) return '';
  return readFileSync(path, "utf8");
}
