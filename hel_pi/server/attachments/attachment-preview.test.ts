import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MAX_FILE_PREVIEW_BYTES } from "../../shared/file-preview";
import { AttachmentStore } from "./store";
import { ArtifactStore } from "../artifacts/store";
import { attachmentRequest } from "./http";
import { sentAttachmentRequest } from "./sent-http";

test("incoming and sent files share text preview rules and separate original downloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "piko-attachment-preview-"));
  try {
    const store = new AttachmentStore(join(root, "attachments"));
    const text = Buffer.from("\uFEFF# 标题\nhello\n");
    const incoming = await store.save({ name: "notes.md", bytes: text });
    const source = join(root, "笔记.md"); await writeFile(source, text);
    await mkdir(join(root, "artifacts"));
    await writeFile(join(root, "artifacts", "notes.md"), text);
    const artifact = await new ArtifactStore(root).preview("notes.md");
    expect({ content: artifact.content, preview: artifact.preview }).toEqual({ content: "# 标题\nhello\n", preview: "markdown" });
    const sent = await store.saveSnapshot(source);
    const inputUrl = `http://localhost/api/attachments/${incoming.id}`;
    const sentUrl = `http://localhost/api/sent-attachments/${sent.id}?name=${encodeURIComponent(sent.name)}`;
    for (const [url, handler] of [[inputUrl, attachmentRequest], [sentUrl, sentAttachmentRequest]] as const) {
      const separator = url.includes("?") ? "&" : "?";
      const preview = await handler(new Request(`${url}${separator}preview=1`), store);
      expect(preview?.status).toBe(200);
      expect(await preview!.json()).toEqual({ content: "# 标题\nhello\n", preview: "markdown" });
      const download = await handler(new Request(`${url}${separator}download=1`), store);
      expect(download?.headers.get("content-disposition")).toStartWith("attachment");
      expect(Buffer.from(await download!.arrayBuffer())).toEqual(text);
    }
    const unsupported = await store.save({ name: "archive.zip", bytes: Buffer.from("data") });
    expect((await attachmentRequest(new Request(`http://localhost/api/attachments/${unsupported.id}?preview=1`), store))?.status).toBe(415);
    const large = await store.save({ name: "large.txt", bytes: new Uint8Array(MAX_FILE_PREVIEW_BYTES + 1).fill(65) });
    expect((await attachmentRequest(new Request(`http://localhost/api/attachments/${large.id}?preview=1`), store))?.status).toBe(413);
    const image = await store.save({ name: "image.png", bytes: new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]) });
    const imageDownload = await attachmentRequest(new Request(`http://localhost/api/attachments/${image.id}?download=1`), store);
    expect(imageDownload?.headers.get("content-disposition")).toStartWith("attachment;");
    const normalImage = await attachmentRequest(new Request(`http://localhost/api/attachments/${image.id}`), store);
    expect(normalImage?.headers.has("content-disposition")).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
