import { Platform } from "react-native";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  MAX_TOTAL_BASE64_CHARS,
  type UserAttachment,
} from "../shared/attachments";

/** 附件选择/粘贴依赖 DOM，仅 web（桌面）端可用。 */
export function attachmentsSupported(): boolean {
  return Platform.OS === "web";
}

export type AttachmentErrorCode =
  | "tooLarge"
  | "empty"
  | "readFailed"
  | "tooMany"
  | "totalTooLarge";

export class AttachmentError extends Error {
  constructor(public readonly code: AttachmentErrorCode) {
    super(code);
  }
}

export function pickFilesFromDialog(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.display = "none";
    let settled = false;
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => finish(Array.from(input.files ?? [])));
    // 取消对话框不会触发 change；窗口重新获焦后兜底收尾。
    window.addEventListener("focus", () => setTimeout(() => finish([]), 300), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

export function clipboardFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  if (data.files && data.files.length > 0) return Array.from(data.files);
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

export async function fileToUserAttachment(file: File): Promise<UserAttachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new AttachmentError("tooLarge");
  if (file.size === 0) throw new AttachmentError("empty");
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new AttachmentError("readFailed");
  }
  const kind = file.type.startsWith("image/") ? "image" : "file";
  return {
    kind,
    fileName: file.name || (kind === "image" ? "pasted-image.png" : "pasted-file"),
    mimeType: file.type || "application/octet-stream",
    data: bytesToBase64(bytes),
  };
}

/** 追加前的数量/总量校验；返回错误码或 null。 */
export function checkAttachmentLimits(
  current: readonly UserAttachment[],
  incoming: readonly UserAttachment[],
): AttachmentErrorCode | null {
  if (current.length + incoming.length > MAX_ATTACHMENT_COUNT) return "tooMany";
  const total = [...current, ...incoming].reduce((sum, item) => sum + item.data.length, 0);
  if (total > MAX_TOTAL_BASE64_CHARS) return "totalTooLarge";
  return null;
}