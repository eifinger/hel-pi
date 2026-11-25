import { readFile, readdir, realpath, lstat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { isWithin, readGuidance, type WorkspacePaths } from "../workspace";
import { AgentResources, NO_AGENT_RESOURCES, workspaceAgentResources, type AgentResourcePolicy } from "./agents/resources";
import type { WorkspaceSkillDetail } from "./types";
import { logWarn } from "../logging";

export type WorkspaceSkill = {
  name: string;
  description: string;
  path: string;
  disableModelInvocation: boolean;
};
type GuidanceRole = "core" | "work_guidance" | "memory";
export type WorkspaceResources = {
  instructions: { role: GuidanceRole; path: string; content: string }[];
  skills: WorkspaceSkill[];
  diagnostics: { path: string; message: string }[];
};
type LoadedWorkspaceResources = {
  resources: WorkspaceResources;
  skillDetail?: WorkspaceSkillDetail;
};
const escape = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Explicit Piko roots, never ancestor instructions or personal Pi CLI resources. */
async function loadWorkspaceResourcesInternal(
  paths: WorkspacePaths,
  signal?: AbortSignal,
  detailName?: string,
  policy: AgentResourcePolicy = workspaceAgentResources(paths.workspace),
): Promise<LoadedWorkspaceResources> {
  const result: WorkspaceResources = {
    instructions: [],
    skills: [],
    diagnostics: [],
  };
  const warn = (path: string, message: string) =>
    result.diagnostics.push({ path, message });
  const instructionFiles: [string, GuidanceRole][] = [
    ...(policy.core ? [[join(paths.resources, "prompts", "core.md"), "core"] as [string, GuidanceRole]] : []),
    ...(policy.guidance ? [[join(paths.workspace, "AGENTS.md"), "work_guidance"] as [string, GuidanceRole]] : []),
    ...policy.memory.map(path => [path, "memory"] as [string, GuidanceRole]),
  ];
  for (const [path, role] of instructionFiles) {
    signal?.throwIfAborted();
    if (await realpath(dirname(path)) !== resolve(dirname(path))) throw new Error("Instruction paths must not follow directory links.");
    result.instructions.push({ role, path, content: readGuidance(dirname(path), basename(path)) });
  }
  if (Array.isArray(policy.skills) && !policy.skills.length) return { resources: result };
  const byName = new Map<string, WorkspaceSkill>();
  let skillDetail: WorkspaceSkillDetail | undefined;
  for (const root of [
    join(paths.resources, "skills"),
    join(paths.workspace, ".agents", "skills"),
  ]) {
    let canonical: string;
    let entries;
    try {
      canonical = await realpath(root);
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        warn(root, "Cannot access skills directory");
      continue;
    }
    // Fixed layout only: <root>/<directory>/SKILL.md. No recursion or linked directories.
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      signal?.throwIfAborted();
      if (
        !entry.isDirectory() ||
        entry.name.startsWith(".") ||
        entry.name === "node_modules"
      )
        continue;
      const path = join(root, entry.name, "SKILL.md");
      try {
        if (
          !(await lstat(path)).isFile() ||
          !isWithin(canonical, await realpath(path))
        ) {
          warn(path, "Invalid skill file");
          continue;
        }
        const text = (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
        const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        if (!match) {
          warn(path, "Skill requires YAML frontmatter");
          continue;
        }
        const metadata: unknown = Bun.YAML.parse(match[1]!);
        if (
          !metadata ||
          typeof metadata !== "object" ||
          Array.isArray(metadata)
        ) {
          warn(path, "Invalid skill metadata");
          continue;
        }
        const value = metadata as Record<string, unknown>;
        if (
          typeof value.name !== "string" ||
          !/^[a-z0-9][a-z0-9-]*$/.test(value.name) ||
          typeof value.description !== "string" ||
          !value.description.trim()
        ) {
          warn(path, "Skill requires a name and description");
          continue;
        }
        if (value.name !== entry.name)
          warn(path, "Skill name differs from directory name");
        if (byName.has(value.name))
          warn(path, `Overrides skill at ${byName.get(value.name)!.path}`);
        const skill = {
          name: value.name,
          description: value.description,
          path,
          disableModelInvocation: value["disable-model-invocation"] === true,
        };
        byName.set(value.name, skill);
        if (value.name === detailName) {
          skillDetail = {
            name: skill.name,
            description: skill.description,
            body: text.slice(match[0].length).replace(/^\r?\n/, ""),
            disableModelInvocation: skill.disableModelInvocation,
          };
        }
      } catch (error) {
        signal?.throwIfAborted();
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          warn(path, "Cannot parse or read skill");
      }
    }
  }
  result.skills = [...byName.values()]
    .filter(skill => policy.skills === "workspace" || policy.skills.includes(skill.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { resources: result, ...(skillDetail && { skillDetail }) };
}

export async function loadWorkspaceResources(
  paths: WorkspacePaths,
  signal?: AbortSignal,
  options: { policy?: AgentResourcePolicy } = {},
): Promise<WorkspaceResources> {
  return (
    await loadWorkspaceResourcesInternal(
      paths,
      signal,
      undefined,
      options.policy,
    )
  ).resources;
}

export async function loadWorkspaceSkill(
  paths: WorkspacePaths,
  name: string,
): Promise<WorkspaceSkillDetail | undefined> {
  return (await loadWorkspaceResourcesInternal(paths, undefined, name,
    { ...NO_AGENT_RESOURCES, skills: "workspace" })).skillDetail;
}

export function formatWorkspaceResources(
  resources: WorkspaceResources,
): string {
  const instructions = resources.instructions.map(
    (file) =>
      `<instructions_file role="${file.role}" path="${escape(file.path)}">\n${file.content}\n</instructions_file>`,
  );
  const skills = resources.skills.filter(
    (skill) => !skill.disableModelInvocation,
  );
  if (skills.length)
    instructions.push(
      `<available_skills>\n${skills.map((skill) => `<skill><name>${escape(skill.name)}</name><description>${escape(skill.description)}</description><location>${escape(skill.path)}</location></skill>`).join("\n")}\n</available_skills>`,
    );
  return instructions.join("\n\n");
}

export function createWorkspaceResources(paths: WorkspacePaths) {
  const reported = new Set<string>();
  return defineExtension({
    name: "piko-resources",
    sections: [
      section("cwd", (input) => input.agent.cwd ?? paths.workspace),
      // Date only: enough for search recency and dated notes without stale clock text in the prompt.
      section("now", () => {
        const timeZone =
          Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
        const date = new Date().toLocaleDateString("en-CA", { timeZone });
        return `Current date: ${date}
Time zone: ${timeZone}`;
      }),
      section("workspace_resources", async (input, context) => {
        const policy = (await input.read.snapshot(AgentResources, input.conversationId, context))?.policy ?? NO_AGENT_RESOURCES;
        const resources = await loadWorkspaceResources(
          paths,
          context.abortSignal,
          { policy },
        );
        for (const diagnostic of resources.diagnostics) {
          const key = `${diagnostic.path}:${diagnostic.message}`;
          if (!reported.has(key)) {
            reported.add(key);
            logWarn("workspace.resource.diagnostic", { kind: "skill" });
          }
        }
        return formatWorkspaceResources(resources);
      }),
    ],
  });
}
