import { lstat, readdir, readFile, realpath, rm, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { contentType, lookup } from "mime-types";
import { filePreviewKind, decodePreviewText, MAX_FILE_PREVIEW_BYTES } from "../../shared/file-preview";
import {
  type ArtifactDeletion,
  type ArtifactDirectory,
  type ArtifactEntry,
  type ArtifactTextPreview,
} from "../../shared/artifacts";
import { isWithin } from "../workspace";

export class ArtifactError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type ArtifactDownload = {
  absolutePath: string;
  name: string;
  size: number;
  mimeType: string;
};

function relativeParts(value: string | undefined): string[] {
  if (value === undefined || value === "") return [];
  if (value.length > 2048 || value.startsWith("/") || value.includes("\\") || value.includes("\0"))
    throw new ArtifactError("Invalid artifact path.", 400);
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || part.startsWith(".")))
    throw new ArtifactError("Invalid artifact path.", 400);
  return parts;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR");
}

/** Scoped file access below workspace/artifacts; never follows links. */
export class ArtifactStore {
  private readonly workspace: string;
  private readonly directory: string;

  constructor(workspace: string) {
    this.workspace = resolve(workspace);
    this.directory = join(this.workspace, "artifacts");
  }

  private async root(): Promise<string> {
    try {
      const workspace = await realpath(this.workspace);
      const info = await lstat(this.directory);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new ArtifactError("Artifacts directory is unavailable.", 503);
      const root = await realpath(this.directory);
      if (root !== resolve(this.directory) || !isWithin(workspace, root))
        throw new ArtifactError("Artifacts directory is unavailable.", 503);
      return root;
    } catch (error) {
      if (error instanceof ArtifactError) throw error;
      if (isMissing(error)) throw new ArtifactError("Artifacts directory is unavailable.", 503);
      throw error;
    }
  }

  private async resolveEntry(value: string | undefined, expected: "directory" | "file" | "entry") {
    const parts = relativeParts(value);
    if (expected === "file" && !parts.length)
      throw new ArtifactError("Artifact file not found.", 404);
    const root = await this.root();
    let current = root;
    let info = await lstat(root);
    try {
      for (const part of parts) {
        current = join(current, part);
        info = await lstat(current);
        if (info.isSymbolicLink()) throw new ArtifactError("Artifact not found.", 404);
        const canonical = await realpath(current);
        if (canonical !== current || !isWithin(root, canonical))
          throw new ArtifactError("Artifact not found.", 404);
      }
    } catch (error) {
      if (error instanceof ArtifactError) throw error;
      if (isMissing(error)) throw new ArtifactError("Artifact not found.", 404);
      throw error;
    }
    if (expected === "directory" ? !info.isDirectory()
      : expected === "file" ? !info.isFile()
        : !info.isDirectory() && !info.isFile())
      throw new ArtifactError("Artifact not found.", 404);
    return { absolutePath: current, info, root, relativePath: parts.join("/") };
  }

  async list(path = ""): Promise<ArtifactDirectory> {
    const directory = await this.resolveEntry(path, "directory");
    let names: string[];
    try {
      names = await readdir(directory.absolutePath);
    } catch (error) {
      if (isMissing(error)) throw new ArtifactError("Artifact folder not found.", 404);
      throw error;
    }
    const entries: ArtifactEntry[] = [];
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const absolutePath = join(directory.absolutePath, name);
      try {
        const info = await lstat(absolutePath);
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) continue;
        const canonical = await realpath(absolutePath);
        if (canonical !== absolutePath || !isWithin(directory.root, canonical)) continue;
        const kind = info.isDirectory() ? "directory" : "file";
        const relativePath = directory.relativePath ? `${directory.relativePath}/${name}` : name;
        entries.push({
          name,
          path: relativePath,
          kind,
          size: kind === "file" ? info.size : null,
          modifiedAt: info.mtimeMs,
          preview: kind === "file" ? filePreviewKind(name) : null,
        });
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
    }
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name, "zh-CN", { numeric: true, sensitivity: "base" });
    });
    return { path: directory.relativePath, entries };
  }

  async preview(path: string): Promise<ArtifactTextPreview> {
    const preview = filePreviewKind(basename(path));
    if (!preview) throw new ArtifactError("This file type cannot be previewed in Piko.", 415);
    const file = await this.resolveEntry(path, "file");
    if (file.info.size > MAX_FILE_PREVIEW_BYTES)
      throw new ArtifactError("This file is too large to preview in Piko. Download it to view.", 413);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(file.absolutePath));
    } catch (error) {
      if (isMissing(error)) throw new ArtifactError("Artifact file not found.", 404);
      throw error;
    }
    if (bytes.byteLength > MAX_FILE_PREVIEW_BYTES)
      throw new ArtifactError("This file is too large to preview in Piko. Download it to view.", 413);
    const content = decodePreviewText(bytes);
    return {
      path: file.relativePath,
      content,
      size: bytes.byteLength,
      modifiedAt: file.info.mtimeMs,
      preview,
    };
  }

  async download(path: string): Promise<ArtifactDownload> {
    const file = await this.resolveEntry(path, "file");
    const name = basename(file.absolutePath);
    const mime = lookup(name) || "application/octet-stream";
    return {
      absolutePath: file.absolutePath,
      name,
      size: file.info.size,
      mimeType: contentType(mime) || mime,
    };
  }

  async delete(path: string): Promise<ArtifactDeletion> {
    if (!relativeParts(path).length)
      throw new ArtifactError("The artifacts root cannot be deleted.", 400);
    const entry = await this.resolveEntry(path, "entry");
    const kind = entry.info.isDirectory() ? "directory" : "file";
    try {
      if (kind === "directory") await rm(entry.absolutePath, { recursive: true });
      else await unlink(entry.absolutePath);
    } catch (error) {
      if (isMissing(error)) throw new ArtifactError("Artifact not found.", 404);
      throw error;
    }
    return { path: entry.relativePath, kind };
  }
}
