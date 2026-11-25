import { HttpError } from '../http';
import { listPrivate, readPrivate } from '../scoped-files';
import type { WorkspacePaths } from '../workspace';
import type { WorkspaceSkillDetail } from './types';

export const skillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const skillBytes = 32 * 1024;
const roots = (p: WorkspacePaths): [string, string[]][] => [[p.workspace, ['.agents','skills']], [p.resources, ['skills']]];

/** A skill contributes metadata and Markdown only. Nothing in its frontmatter declares runtime capabilities. */
export function parseWorkspaceSkill(name: string, text: string): WorkspaceSkillDetail {
  const invalid = () => new HttpError('SKILL.md needs YAML frontmatter with the directory name and a description (1–512 characters), then Markdown guidance.', 422);
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match || match[1].length > 4096 || !skillName.test(name) || name.length > 64 || Buffer.byteLength(text) > skillBytes) throw invalid();
  let parsed: unknown;
  try { parsed = Bun.YAML.parse(match[1]); } catch { throw invalid(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
  const meta = parsed as Record<string, unknown>;
  const body = text.slice(match[0].length).trim();
  if (meta.name !== name || typeof meta.description !== 'string' || !meta.description.trim() || meta.description.length > 512 || !body) throw invalid();
  return {name, description:meta.description.trim(), body, disableModelInvocation:meta['disable-model-invocation'] === true};
}

function load(root: string, parts: string[], name: string) {
  try {
    const {bytes} = readPrivate(root, [...parts, name, 'SKILL.md'], skillBytes);
    const text = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(bytes);
    return {text, skill:parseWorkspaceSkill(name, text)};
  } catch { return undefined; } // One malformed or linked skill does not prevent chat startup.
}

export function workspaceSkillFile(paths: WorkspacePaths, name: string) {
  if (!skillName.test(name) || name.length > 64) return undefined;
  for (const [root, parts] of roots(paths)) {
    const file = load(root, parts, name);
    if (file) return {...file, bundled:root === paths.resources};
  }
  return undefined;
}

export function workspaceSkillIndex(paths: WorkspacePaths) {
  const found = new Map<string, Pick<WorkspaceSkillDetail, 'name' | 'description' | 'disableModelInvocation'>>();
  for (const [root, parts] of roots(paths)) {
    let entries;
    try { entries = listPrivate(root, parts); } catch { continue; }
    for (const {name, info} of entries) {
      if (found.size >= 64 || !info.isDirectory() || found.has(name) || !skillName.test(name) || name.length > 64) continue;
      const skill = load(root, parts, name)?.skill;
      if (skill) found.set(name, {name, description:skill.description, disableModelInvocation:skill.disableModelInvocation});
    }
  }
  return [...found.values()].sort((a,b) => a.name.localeCompare(b.name));
}
