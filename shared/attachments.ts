/** 用户附件限额与分流（纯函数，客户端/服务端共用）。 */

export const MAX_ATTACHMENT_COUNT = 8;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_BASE64_CHARS = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;
export const MAX_TOTAL_BASE64_CHARS = Math.ceil(MAX_TOTAL_ATTACHMENT_BYTES / 3) * 4;

export interface UserAttachment {
  kind: "image" | "file";
  fileName: string;
  mimeType: string;
  /** base64 编码的文件字节。 */
  data: string;
}

export interface OutgoingImage {
  data: string;
  mimeType: string;
}

export interface OutgoingFile {
  fileName: string;
  mimeType: string;
  data: string;
}

export function splitUserAttachments(list: readonly UserAttachment[]): {
  images: OutgoingImage[];
  files: OutgoingFile[];
} {
  const images: OutgoingImage[] = [];
  const files: OutgoingFile[] = [];
  for (const item of list) {
    if (item.kind === "image") {
      images.push({ data: item.data, mimeType: item.mimeType });
    } else {
      files.push({ fileName: item.fileName, mimeType: item.mimeType, data: item.data });
    }
  }
  return { images, files };
}

/** 纯附件消息的兜底提问文本（用于时间线回显与线程标题）。 */
export function attachmentFallbackText(list: readonly UserAttachment[]): string {
  return `[attachments] ${list.map((item) => item.fileName).join(", ")}`;
}