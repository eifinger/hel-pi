import { randomUUID } from "node:crypto";
import { unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from "node:path";
import { extension as extensionForMime, lookup as lookupMime } from "mime-types";
import { MAX_ATTACHMENT_BYTES } from "../../shared/chat";
import { privateInfo, readPrivate, scopedDirectory, writePrivate } from '../scoped-files';
export { MAX_ATTACHMENT_BYTES } from "../../shared/chat";

/** One stored upload. The model reads `path`; channels share the same file. */
export type StoredAttachment = { id: string; path: string; mime: string; bytes: number };

/** Sniff the formats both the model and the image processor accept; never trust a client-supplied type. */
export function detectAttachmentMimeType(bytes: Uint8Array): string | undefined {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  if (starts(0x42, 0x4d)) return "image/bmp";
  return undefined;
}

/** Only the last path segment is used, so a client cannot choose a directory; control characters are dropped. */
export function safeAttachmentName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  let value = basename(name.replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!value || value === "." || value === "..") return undefined;
  // Filesystems cap a single name; keep the extension when trimming bytes.
  if (Buffer.byteLength(value) > 200) {
    const dot = value.lastIndexOf(".");
    const suffix = dot > 0 ? value.slice(dot) : "";
    let head = dot > 0 ? value.slice(0, dot) : value;
    while (head && Buffer.byteLength(head + suffix) > 200) head = head.slice(0, -1);
    value = head + suffix;
  }
  return value;
}

/** Downloads and app uploads land here, outside the workspace: attachments are runtime data, not user content. */
export class AttachmentStore {
  constructor(readonly directory: string, private readonly maxBytes = MAX_ATTACHMENT_BYTES) {}

  /** Any file is kept under its own name; the model decides how to inspect it. */
  async save(input: { bytes: Uint8Array; name?: string; mime?: string }): Promise<StoredAttachment> {
    const { bytes } = input;
    if (!bytes.length) throw new Error("The attachment is empty.");
    if (bytes.length > this.maxBytes) throw new Error("The attachment is too large.");
    const detected = detectAttachmentMimeType(bytes);
    const extension = nameExtension(input.name) ?? ((detected && extensionForMime(detected)) || (input.mime && extensionForMime(input.mime)) || "bin");
    const name = safeAttachmentName(input.name) ?? `attachment.${extension}`;
    const id = `${randomUUID()}/${name}`;
    const fromExtension = detectExtension(name);
    const mime = detected ?? (fromExtension !== "application/octet-stream" ? fromExtension : input.mime ?? "application/octet-stream");
    const path = this.pathOf(id);
    writePrivate(dirname(this.directory), [basename(this.directory), ...id.split('/')], bytes);
    return { id, path, mime, bytes: bytes.length };
  }

  async read(id: string): Promise<{ attachment: StoredAttachment; bytes: Uint8Array } | undefined> {
    if (!this.allowed(id)) return undefined;
    const path = this.pathOf(id);
    try {
      const bytes = new Uint8Array(readPrivate(this.directory, id.split('/'), this.maxBytes).bytes);
      return { attachment: { id, path, mime: detectAttachmentMimeType(bytes) ?? detectExtension(id), bytes: bytes.length }, bytes };
    } catch { return undefined; }
  }

  async lookup(id: string): Promise<StoredAttachment | undefined> {
    if (!this.allowed(id)) return undefined;
    const path = this.pathOf(id);
    try {
      const info = privateInfo(this.directory, id.split('/'));
      return info.isFile() && info.size <= this.maxBytes ? { id, path, mime: detectExtension(id), bytes: info.size } : undefined;
    } catch { return undefined; }
  }

  /** For trusted callers with an explicit source. Chat supplies scoped bytes, not a host path. */
  async saveSnapshot(source: string) {
    return this.saveSnapshotBytes(basename(source), readPrivate(dirname(source), [basename(source)], this.maxBytes).bytes);
  }

  saveSnapshotBytes(name: string, bytes: Uint8Array) {
    if (!bytes.length || bytes.length > this.maxBytes || safeAttachmentName(name) !== name) throw new Error('Invalid attachment.');
    const id = randomUUID();
    writePrivate(dirname(this.directory), [basename(this.directory), id], bytes);
    return { id, name, mime: detectExtension(name), bytes: bytes.length };
  }

  async readSnapshot(id: string): Promise<Uint8Array | undefined> {
    if (!isSnapshotId(id)) return undefined;
    try { return readPrivate(this.directory, [id], this.maxBytes).bytes; } catch { return undefined; }
  }

  async discardSnapshot(id: string): Promise<void> {
    if (isSnapshotId(id)) {
      try { scopedDirectory(this.directory, [], false, directory => unlinkSync(`${directory}/${id}`)); } catch { /* Already gone. */ }
    }
  }

  private pathOf(id: string): string {
    return join(this.directory, id);
  }

  private allowed(id: string): boolean {
    const parts = id.split("/");
    const valid = parts.length === 1 ? safeAttachmentName(id) === id
      : parts.length === 2 && isSnapshotId(parts[0]!) && safeAttachmentName(parts[1]) === parts[1];
    return valid && resolve(this.pathOf(id)).startsWith(resolve(this.directory) + sep);
  }
}

export function isSnapshotId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
}

function nameExtension(name: string | undefined): string | undefined {
  const value = name?.match(/\.([A-Za-z0-9]{1,8})$/)?.[1].toLowerCase();
  return value && /^[a-z0-9]+$/.test(value) ? value : undefined;
}

/** Determine MIME from a name using the shared database, falling back for unknown types. */
export function detectExtension(id: string): string {
  return lookupMime(id) || "application/octet-stream";
}
