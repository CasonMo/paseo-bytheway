import { describe, expect, it } from "vitest";
import {
  attachmentFallbackText,
  MAX_ATTACHMENT_BASE64_CHARS,
  MAX_ATTACHMENT_COUNT,
  MAX_TOTAL_BASE64_CHARS,
  splitUserAttachments,
  type UserAttachment,
} from "./attachments";
import { threadsAsk, userAttachmentSchema, userAttachmentsSchema } from "./contracts";

function attachment(overrides: Partial<UserAttachment> = {}): UserAttachment {
  return {
    kind: "file",
    fileName: "notes.txt",
    mimeType: "text/plain",
    data: "aGVsbG8=",
    ...overrides,
  };
}

describe("userAttachmentSchema", () => {
  it("accepts image and file attachments", () => {
    expect(userAttachmentSchema.safeParse(attachment()).success).toBe(true);
    expect(
      userAttachmentSchema.safeParse(
        attachment({ kind: "image", fileName: "shot.png", mimeType: "image/png" }),
      ).success,
    ).toBe(true);
  });

  it("rejects image kind with non-image mimeType", () => {
    expect(
      userAttachmentSchema.safeParse(attachment({ kind: "image", mimeType: "text/plain" })).success,
    ).toBe(false);
  });

  it("rejects oversized base64 payload", () => {
    expect(
      userAttachmentSchema.safeParse(
        attachment({ data: "a".repeat(MAX_ATTACHMENT_BASE64_CHARS + 1) }),
      ).success,
    ).toBe(false);
  });
});

describe("userAttachmentsSchema", () => {
  it("rejects more than the count limit", () => {
    const list = Array.from({ length: MAX_ATTACHMENT_COUNT + 1 }, () => attachment());
    expect(userAttachmentsSchema.safeParse(list).success).toBe(false);
  });

  it("rejects payloads over the total size limit", () => {
    const half = "a".repeat(Math.ceil(MAX_TOTAL_BASE64_CHARS / 2));
    const list = [attachment({ data: half }), attachment({ data: half }), attachment()];
    expect(userAttachmentsSchema.safeParse(list).success).toBe(false);
  });
});

describe("threadsAsk input", () => {
  const base = { mainAgentId: "agent_1" };

  it("requires question or attachments", () => {
    expect(threadsAsk.input.safeParse({ ...base, question: "" }).success).toBe(false);
    expect(threadsAsk.input.safeParse({ ...base, question: "hi" }).success).toBe(true);
    expect(
      threadsAsk.input.safeParse({ ...base, question: "", attachments: [attachment()] }).success,
    ).toBe(true);
  });
});

describe("splitUserAttachments", () => {
  it("routes images and files to their channels", () => {
    const image = attachment({ kind: "image", fileName: "shot.png", mimeType: "image/png" });
    const file = attachment();
    const { images, files } = splitUserAttachments([image, file]);
    expect(images).toEqual([{ data: image.data, mimeType: "image/png" }]);
    expect(files).toEqual([{ fileName: "notes.txt", mimeType: "text/plain", data: file.data }]);
  });

  it("handles empty input", () => {
    expect(splitUserAttachments([])).toEqual({ images: [], files: [] });
  });
});

describe("attachmentFallbackText", () => {
  it("lists attachment names", () => {
    expect(attachmentFallbackText([attachment(), attachment({ fileName: "spec.pdf" })])).toBe(
      "[attachments] notes.txt, spec.pdf",
    );
  });
});