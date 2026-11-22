import { mkdtemp, readFile, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UserAttachment } from "../shared/attachments";
import {
  readMessageAttachments,
  removeThreadUploads,
  saveMessageAttachments,
  sweepStaleUploads,
} from "./uploads";

let baseDir: string;

const textFile = (fileName: string, text = "x"): UserAttachment => ({
  kind: "file",
  fileName,
  mimeType: "text/plain",
  data: Buffer.from(text).toString("base64"),
});

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "bytheway-uploads-"));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

describe("saveMessageAttachments", () => {
  it("writes decoded bytes and returns uploaded_file descriptors for files only", async () => {
    const data = Buffer.from("hello attachment").toString("base64");
    const saved = await saveMessageAttachments(
      "sk_test",
      "msg_1",
      [
        { kind: "file", fileName: "notes.txt", mimeType: "text/plain", data },
        { kind: "image", fileName: "pic.png", mimeType: "image/png", data },
      ],
      baseDir,
    );
    expect(saved).toHaveLength(1);
    expect(saved[0].type).toBe("uploaded_file");
    expect(saved[0].fileName).toBe("notes.txt");
    expect(saved[0].mimeType).toBe("text/plain");
    expect(saved[0].size).toBe(Buffer.from("hello attachment").byteLength);
    expect(await readFile(saved[0].path, "utf8")).toBe("hello attachment");
    expect(saved[0].path.startsWith(join(baseDir, "sk_test", "msg_1"))).toBe(true);
  });

  it("sanitizes path traversal and control characters in file names", async () => {
    const [saved] = await saveMessageAttachments(
      "sk_test",
      "msg_1",
      [textFile("../../evil:name.txt")],
      baseDir,
    );
    expect(saved.fileName).not.toContain("..");
    expect(saved.fileName).not.toContain("/");
    expect(saved.path.startsWith(join(baseDir, "sk_test", "msg_1"))).toBe(true);
  });

  it("returns empty list for no attachments without creating directories", async () => {
    expect(await saveMessageAttachments("sk_test", "msg_1", [], baseDir)).toEqual([]);
    expect(await readdir(baseDir)).toEqual([]);
  });
});

describe("readMessageAttachments", () => {
  it("round-trips images with base64 and files without bytes", async () => {
    const imageData = Buffer.from("png-bytes").toString("base64");
    await saveMessageAttachments(
      "sk_test",
      "msg_1",
      [
        { kind: "image", fileName: "pic.png", mimeType: "image/png", data: imageData },
        textFile("notes.txt", "hello"),
      ],
      baseDir,
    );
    const read = await readMessageAttachments("sk_test", "msg_1", baseDir);
    expect(read).toEqual([
      { kind: "image", fileName: "pic.png", mimeType: "image/png", data: imageData },
      { kind: "file", fileName: "notes.txt", mimeType: "text/plain" },
    ]);
  });

  it("returns empty for unknown thread or message", async () => {
    expect(await readMessageAttachments("sk_missing", "msg_1", baseDir)).toEqual([]);
    await saveMessageAttachments("sk_test", "msg_1", [textFile("a.txt")], baseDir);
    expect(await readMessageAttachments("sk_test", "msg_other", baseDir)).toEqual([]);
  });

  it("ignores traversal in a tampered manifest", async () => {
    await saveMessageAttachments("sk_test", "msg_1", [textFile("a.txt")], baseDir);
    const dir = join(baseDir, "sk_test", "msg_1");
    const manifest = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
    manifest.push({
      kind: "image",
      fileName: "evil.png",
      mimeType: "image/png",
      storedName: "../../../etc/passwd",
    });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "index.json"), JSON.stringify(manifest));
    const read = await readMessageAttachments("sk_test", "msg_1", baseDir);
    expect(read).toHaveLength(1);
    expect(read[0].kind).toBe("file");
  });

  it("skips symlinked, oversized, and non-image entries in a tampered manifest", async () => {
    const imageData = Buffer.from("png-bytes").toString("base64");
    await saveMessageAttachments(
      "sk_test",
      "msg_1",
      [{ kind: "image", fileName: "pic.png", mimeType: "image/png", data: imageData }],
      baseDir,
    );
    const dir = join(baseDir, "sk_test", "msg_1");
    const { symlink, writeFile } = await import("node:fs/promises");
    const outside = join(baseDir, "outside.png");
    await writeFile(outside, Buffer.from("outside-bytes"));
    await symlink(outside, join(dir, "link.png"));
    await writeFile(join(dir, "huge.png"), Buffer.alloc(11 * 1024 * 1024));
    const manifest = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
    manifest.push(
      { kind: "image", fileName: "link.png", mimeType: "image/png", storedName: "link.png" },
      { kind: "image", fileName: "huge.png", mimeType: "image/png", storedName: "huge.png" },
      { kind: "image", fileName: "fake.png", mimeType: "text/html", storedName: "link.png" },
    );
    await writeFile(join(dir, "index.json"), JSON.stringify(manifest));
    const read = await readMessageAttachments("sk_test", "msg_1", baseDir);
    expect(read).toEqual([
      { kind: "image", fileName: "pic.png", mimeType: "image/png", data: imageData },
    ]);
  });
});

describe("removeThreadUploads", () => {
  it("removes only the thread's upload directory", async () => {
    await saveMessageAttachments("sk_a", "msg_1", [textFile("a.txt")], baseDir);
    await saveMessageAttachments("sk_b", "msg_1", [textFile("b.txt")], baseDir);
    await removeThreadUploads("sk_a", baseDir);
    expect(await readdir(baseDir)).toEqual(["sk_b"]);
  });

  it("is a no-op for unknown threads", async () => {
    await expect(removeThreadUploads("sk_missing", baseDir)).resolves.toBeUndefined();
  });
});

describe("sweepStaleUploads", () => {
  it("removes old directories and keeps recent ones", async () => {
    const [old] = await saveMessageAttachments("sk_old", "msg_1", [textFile("a.txt")], baseDir);
    await saveMessageAttachments("sk_new", "msg_1", [textFile("b.txt")], baseDir);
    const past = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    await utimes(join(baseDir, "sk_old"), past, past);
    await sweepStaleUploads(baseDir);
    expect(await readdir(baseDir)).toEqual(["sk_new"]);
    expect(old.path).toContain("sk_old");
  });

  it("tolerates a missing base directory", async () => {
    await expect(sweepStaleUploads(join(baseDir, "missing"))).resolves.toBeUndefined();
  });
});