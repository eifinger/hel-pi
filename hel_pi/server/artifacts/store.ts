import { opendirSync, rmdirSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { contentType, lookup } from 'mime-types';
import { MAX_ATTACHMENT_BYTES } from '../../shared/chat';
import { filePreviewKind, decodePreviewText, MAX_FILE_PREVIEW_BYTES } from '../../shared/file-preview';
import type { ArtifactDeletion, ArtifactDirectory, ArtifactTextPreview } from '../../shared/artifacts';
import { HttpError } from '../http';
import { listPrivate, privateInfo, readPrivate, scopedDirectory } from '../scoped-files';

export { HttpError as ArtifactError } from '../http';

function partsOf(path: string) {
  const parts = path === '' ? [] : path.split('/');
  if (path.length > 2048 || parts.length > 12 || parts.some(p => !p || p.startsWith('.') || /[\\\x00-\x1f\x7f]/.test(p) || /^agents\.md$/i.test(p)))
    throw new HttpError('Invalid artifact path.', 400);
  return parts;
}

/** Authenticated human artifact management. Return opened bytes, never a reusable host pathname. */
export class ArtifactStore {
  private readonly directory: string;
  constructor(workspace: string) { this.directory = join(workspace, 'artifacts'); }

  async list(path = ''): Promise<ArtifactDirectory> {
    const entries = listPrivate(this.directory, partsOf(path)).flatMap(({name, info}) => {
      const child = path ? `${path}/${name}` : name;
      try { partsOf(child); } catch { return []; }
      const kind = info.isDirectory() ? 'directory' as const : 'file' as const;
      return [{name, path:child, kind, size:kind === 'file' ? info.size : null,
        modifiedAt:info.mtimeMs, preview:kind === 'file' ? filePreviewKind(name) : null}];
    });
    return {path, entries};
  }

  async preview(path: string): Promise<ArtifactTextPreview> {
    const parts = partsOf(path), preview = filePreviewKind(basename(path));
    if (!preview) throw new HttpError('This file type cannot be previewed.', 415);
    const {bytes, info} = readPrivate(this.directory, parts, MAX_FILE_PREVIEW_BYTES);
    return {path, size:bytes.length, preview, content:decodePreviewText(bytes), modifiedAt:info.mtimeMs};
  }

  async download(path: string) {
    const name = basename(path), mime = lookup(name) || 'application/octet-stream';
    const {bytes} = readPrivate(this.directory, partsOf(path), MAX_ATTACHMENT_BYTES);
    return {name, bytes, size:bytes.length, mimeType:contentType(mime) || mime};
  }

  async delete(path: string): Promise<ArtifactDeletion> {
    if (!path) throw new HttpError('The artifacts root cannot be deleted.', 400);
    const root = this.directory, parts = partsOf(path), isDirectory = privateInfo(root, parts).isDirectory();
    const plan: {parts:string[]; directory:boolean}[] = [];
    function inspect(parts: string[], directory: boolean) {
      if (directory) scopedDirectory(root, parts, false, parent => {
        const dir = opendirSync(parent);
        try {
          for (let count = 0, entry; (entry = dir.readSync()); count++) {
            if (count >= 256) throw new HttpError('Too many entries in this directory.', 413);
            const child = partsOf([...parts,entry.name].join('/'));
            inspect(child, privateInfo(root, child).isDirectory());
          }
        } finally { dir.closeSync(); }
      });
      plan.push({parts, directory});
    }
    try { inspect(parts, isDirectory); }
    catch {
      throw new HttpError('This folder contains hidden or unsupported entries, or cannot be fully inspected. Nothing was deleted.', 409);
    }
    // Inspect the whole tree before the first unlink. Never descend via the filtered browser listing.
    for (const {parts, directory} of plan) scopedDirectory(root, parts.slice(0,-1), false, dir => {
      const entry = `${dir}/${parts.at(-1)}`;
      if (directory) rmdirSync(entry); else unlinkSync(entry);
    });
    return {path, kind:isDirectory ? 'directory' : 'file'};
  }
}
