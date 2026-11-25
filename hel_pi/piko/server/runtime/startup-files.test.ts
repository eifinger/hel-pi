import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearRuntimeTemp, migrateSentAttachments } from "./startup-files";
import { AttachmentStore } from "../attachments/store";
import { sentAttachmentRequest } from "../attachments/sent-http";
import { attachmentRequest } from "../attachments/http";

async function temporaryState(run: (state: string) => Promise<void>) {
  const state = await mkdtemp(join(tmpdir(), "piko-storage-test-"));
  try { await run(state); }
  finally { await rm(state, { recursive: true, force: true }); }
}

describe("startup storage preparation", () => {
  test("moves old snapshots without changing their IDs or incoming files, and is repeatable", () => temporaryState(async state => {
    const old = join(state, "sent-attachments"), target = join(state, "attachments"), id = randomUUID();
    await mkdir(old); await mkdir(target);
    await writeFile(join(old, id), "old snapshot"); await writeFile(join(target, "incoming.txt"), "incoming");
    expect(await migrateSentAttachments(state)).toBe(1);
    expect(await readFile(join(target, id), "utf8")).toBe("old snapshot");
    expect(await readFile(join(target, "incoming.txt"), "utf8")).toBe("incoming");
    expect(await migrateSentAttachments(state)).toBe(0);
    await expect(lstat(old)).rejects.toThrow();
  }));

  test("resumes an interrupted move without overwriting a different file", () => temporaryState(async state => {
    const old = join(state, "sent-attachments"), target = join(state, "attachments"), id = randomUUID();
    await mkdir(old); await mkdir(target);
    await writeFile(join(old, id), "snapshot"); await link(join(old, id), join(target, id));
    expect(await migrateSentAttachments(state)).toBe(1);
    await mkdir(old); await writeFile(join(old, id), "different");
    await expect(migrateSentAttachments(state)).rejects.toThrow();
    expect(await readFile(join(old, id), "utf8")).toBe("different");
    expect(await readFile(join(target, id), "utf8")).toBe("snapshot");
  }));

  test("both incoming and assistant files use the common store and audio preview", () => temporaryState(async state => {
    const store = new AttachmentStore(join(state, "attachments"));
    const source = join(state, "tone.mp3");
    const audio = Buffer.from("ID3sample-audio");
    await writeFile(source, audio);
    const incoming = await store.save({ name: "incoming.mp3", bytes: audio });
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await utimes(incoming.path, oldDate, oldDate);
    const sent = await store.saveSnapshot(source);
    await writeFile(source, "changed original");
    expect(await store.readSnapshot(sent.id)).toEqual(audio);
    const outgoingUrl = `http://localhost/api/sent-attachments/${sent.id}?name=tone.mp3&play=1`;
    const incomingUrl = `http://localhost/api/attachments/${incoming.id}?play=1`;
    for (const [request, handle] of [[outgoingUrl, sentAttachmentRequest], [incomingUrl, attachmentRequest]] as const) {
      const response = await handle(new Request(request, { headers: { Range: "bytes=0-2" } }), store);
      expect(response?.status).toBe(206);
      expect(response?.headers.get("content-type")).toBe("audio/mpeg");
      expect((await response!.arrayBuffer()).byteLength).toBe(3);
    }
    await clearRuntimeTemp(state);
    expect(await store.readSnapshot(sent.id)).toEqual(audio);
    expect((await store.read(incoming.id))?.bytes).toEqual(new Uint8Array(audio));
  }));

  test("clears temporary content without following symlinks outside the directory", () => temporaryState(async state => {
    const temp = join(state, "tmp"), outside = join(state, "keep");
    await mkdir(temp); await mkdir(outside); await writeFile(join(outside, "file"), "keep");
    await mkdir(join(temp, "nested")); await writeFile(join(temp, "nested", "scratch"), "delete");
    await symlink(outside, join(temp, "link"));
    await clearRuntimeTemp(state);
    expect(await readFile(join(outside, "file"), "utf8")).toBe("keep");
    await expect(lstat(join(temp, "nested"))).rejects.toThrow();
    await expect(lstat(join(temp, "link"))).rejects.toThrow();
    expect((await lstat(temp)).isDirectory()).toBe(true);
    await rm(temp, { recursive: true });
    await symlink(outside, temp);
    await clearRuntimeTemp(state);
    expect(await readFile(join(outside, "file"), "utf8")).toBe("keep");
    expect((await lstat(temp)).isDirectory()).toBe(true);
  }));
});
