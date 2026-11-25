import { join, resolve } from "node:path";

/** Piko owns these files; the workspace and Pi CLI profile are separate. */
export function runtimePaths(home: string) {
  const root = resolve(home);
  return { root, config: join(root, "config"), sessions: join(root, "state", "durable"),
    tmp: join(root, "state", "tmp") };
}
