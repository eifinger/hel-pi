import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, opendirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { HttpError } from './http';

const unavailable = () => new HttpError('File or directory unavailable.', 404);
const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code;

// The add-on runs on Linux. Holding each directory descriptor while opening its child prevents a
// renamed parent or a swapped symlink from redirecting a later operation into private app data.
// O_PATH needs search, not read, permission on ancestors (notably Supervisor's /data).
const directoryFlags = 0o10000000 | constants.O_DIRECTORY | constants.O_NOFOLLOW;
export const descriptorPath = (fd: number) => `/proc/self/fd/${fd}`;

export function scopedDirectory<T>(root: string, parts: string[], create: boolean, act: (directory: string) => T): T {
  if (!isAbsolute(root) || resolve(root) !== root || parts.some(p => !p || p === '.' || p === '..' || /[\/\\\x00-\x1f\x7f]/.test(p))) throw unavailable();
  let fd = openSync('/', directoryFlags);
  try {
    const base = root.split('/').filter(Boolean);
    for (const [i, part] of [...base, ...parts].entries()) {
      const path = `${descriptorPath(fd)}/${part}`;
      if (create && i >= base.length) {
        try { mkdirSync(path, {mode:0o700}); } catch (e) { if (code(e) !== 'EEXIST') throw e; }
      }
      const child = openSync(path, directoryFlags);
      closeSync(fd); fd = child;
    }
    return act(descriptorPath(fd));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (code(e) === 'EEXIST') throw new HttpError('This file already exists. Read and edit it instead.', 409);
    throw unavailable(); // Never return host paths or OS errors to the model or HTTP client.
  } finally { closeSync(fd); }
}

function leaf(parts: string[]) {
  const name = parts.at(-1);
  if (!name || name === '.' || name === '..' || /[\/\\\x00-\x1f\x7f]/.test(name)) throw unavailable();
  return name;
}

export function privateInfo(root: string, parts: string[]) {
  const name = leaf(parts);
  return scopedDirectory(root, parts.slice(0,-1), false, dir => {
    const info = lstatSync(`${dir}/${name}`);
    if (!info.isDirectory() && !(info.isFile() && info.nlink === 1)) throw unavailable();
    return info;
  });
}

export function listPrivate(root: string, parts: string[], limit = 256) {
  return scopedDirectory(root, parts, false, directory => {
    const dir = opendirSync(directory), entries: {name:string; info:Stats}[] = [];
    try {
      for (let i = 0, entry; (entry = dir.readSync()); i++) {
        if (i >= limit) throw new HttpError('Too many entries in this directory.', 413);
        if (entry.name.startsWith('.') || !(entry.isDirectory() || entry.isFile())) continue;
        const info = lstatSync(`${directory}/${entry.name}`, {throwIfNoEntry:false});
        if (info && (info.isDirectory() || (info.isFile() && info.nlink === 1))) entries.push({name:entry.name, info});
      }
    } finally { dir.closeSync(); }
    return entries.sort((a,b) => Number(b.info.isDirectory()) - Number(a.info.isDirectory()) || a.name.localeCompare(b.name));
  });
}

/** Caller owns the descriptor. Never re-open a validated file by its original path. */
export function openPrivate(root: string, parts: string[], maxBytes: number) {
  const name = leaf(parts);
  return scopedDirectory(root, parts.slice(0,-1), false, dir => {
    const fd = openSync(`${dir}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1) throw unavailable();
      if (info.size > maxBytes) throw new HttpError(`File exceeds the ${maxBytes / 1024} KiB limit.`, 413);
      return {fd, info};
    } catch (e) { closeSync(fd); throw e; }
  });
}

export function readPrivate(root: string, parts: string[], maxBytes: number) {
  const {fd, info} = openPrivate(root, parts, maxBytes);
  try {
    const bytes = Buffer.alloc(info.size);
    for (let at = 0; at < bytes.length;) {
      const n = readSync(fd, bytes, at, bytes.length - at, at);
      if (!n) throw unavailable();
      at += n;
    }
    const after = fstatSync(fd);
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.nlink !== 1) throw unavailable();
    return {bytes, info};
  } finally { closeSync(fd); }
}

/** Atomic publication. Updates replace the directory entry, never bytes of a linked target. */
export function writePrivate(root: string, parts: string[], data: string | Uint8Array, replace = false) {
  const name = leaf(parts);
  return scopedDirectory(root, parts.slice(0,-1), true, dir => {
    const path = `${dir}/${name}`, tmp = `${dir}/.writing-${randomUUID()}`;
    if (replace) {
      const info = lstatSync(path);
      if (!info.isFile() || info.nlink !== 1) throw unavailable();
    }
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeFileSync(fd, data); fsyncSync(fd);
      if (replace) renameSync(tmp, path);
      else linkSync(tmp, path);
    } finally {
      closeSync(fd);
      try { unlinkSync(tmp); } catch (e) { if (code(e) !== 'ENOENT') throw e; }
    }
  });
}
