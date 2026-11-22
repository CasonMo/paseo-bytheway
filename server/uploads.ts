import { lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { MAX_ATTACHMENT_BYTES, type UserAttachment } from "../shared/attachments";

/**
 * 附件落盘：按 线程/消息 分组写入插件数据目录。文件再以 uploaded_file 路径引用
 * 交给 daemon，侧聊 agent 用自己的文件工具读取（与 Paseo 主输入框的文件附件行为一致）；
 * 图片副本供客户端在消息气泡里回显（daemon timeline 的 user_message 不带图片）。
 */

export interface UploadedFileAttachment {
  type: "uploaded_file";
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  path: string;
}

export interface StoredAttachment {
  kind: "image" | "file";
  fileName: string;
  mimeType: string;
  /** 仅图片：base64 字节，供气泡缩略图渲染。 */
  data?: string;
}

interface ManifestEntry {
  kind: "image" | "file";
  fileName: string;
  mimeType: string;
  storedName: string;
}

const defaultBaseDir = join(homedir(), ".paseo", "plugin-data", "paseo-bytheway", "uploads");
const STALE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function sanitizeFileName(value: string): string {
  const name = basename(value)
    .replace(/[\p{Cc}\\/:*?"<>|]/gu, "_")
    .trim();
  return name.length > 0 && name !== "." && name !== ".." ? name.slice(0, 200) : "upload";
}

function messageDir(threadId: string, messageId: string, baseDir: string): string {
  return join(baseDir, sanitizeFileName(threadId), sanitizeFileName(messageId));
}

export async function saveMessageAttachments(
  threadId: string,
  messageId: string,
  attachments: readonly UserAttachment[],
  baseDir: string = defaultBaseDir,
): Promise<UploadedFileAttachment[]> {
  if (attachments.length === 0) return [];
  const dir = messageDir(threadId, messageId, baseDir);
  await mkdir(dir, { recursive: true });
  const manifest: ManifestEntry[] = [];
  const saved: UploadedFileAttachment[] = [];
  for (const [index, item] of attachments.entries()) {
    const bytes = Buffer.from(item.data, "base64");
    const id = `up_${Date.now().toString(36)}_${index}`;
    const fileName = sanitizeFileName(item.fileName);
    const storedName = `${id}-${fileName}`;
    const path = join(dir, storedName);
    await writeFile(path, bytes);
    manifest.push({ kind: item.kind, fileName, mimeType: item.mimeType, storedName });
    if (item.kind === "file") {
      saved.push({
        type: "uploaded_file",
        id,
        fileName,
        mimeType: item.mimeType,
        size: bytes.byteLength,
        path,
      });
    }
  }
  await writeFile(join(dir, "index.json"), JSON.stringify(manifest));
  return saved;
}

/** 读取某条消息的附件回显数据；目录/清单缺失返回空（旧消息无落盘副本）。 */
export async function readMessageAttachments(
  threadId: string,
  messageId: string,
  baseDir: string = defaultBaseDir,
): Promise<StoredAttachment[]> {
  const dir = messageDir(threadId, messageId, baseDir);
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(manifest)) return [];
  const out: StoredAttachment[] = [];
  for (const raw of manifest) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Partial<ManifestEntry>;
    if (entry.kind !== "image" && entry.kind !== "file") continue;
    if (typeof entry.fileName !== "string" || typeof entry.mimeType !== "string") continue;
    const fileName = sanitizeFileName(entry.fileName);
    if (entry.kind === "file") {
      out.push({ kind: "file", fileName, mimeType: entry.mimeType });
      continue;
    }
    if (!entry.mimeType.startsWith("image/")) continue;
    const storedName = basename(typeof entry.storedName === "string" ? entry.storedName : "");
    if (!storedName || storedName === "index.json") continue;
    try {
      const path = join(dir, storedName);
      // 清单可能被篡改：只读常规文件（拒绝符号链接），且不超过输入侧单文件限额。
      const info = await lstat(path);
      if (!info.isFile() || info.size > MAX_ATTACHMENT_BYTES) continue;
      const bytes = await readFile(path);
      out.push({ kind: "image", fileName, mimeType: entry.mimeType, data: bytes.toString("base64") });
    } catch {
      // 字节文件已被清扫：跳过该图
    }
  }
  return out;
}

export async function removeThreadUploads(
  threadId: string,
  baseDir: string = defaultBaseDir,
): Promise<void> {
  await rm(join(baseDir, sanitizeFileName(threadId)), { recursive: true, force: true });
}

/** 清扫遗留上传目录（线程异常退出等场景），尽力而为。 */
export async function sweepStaleUploads(
  baseDir: string = defaultBaseDir,
  maxAgeMs: number = STALE_MAX_AGE_MS,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(baseDir, entry.name);
    try {
      const info = await stat(dir);
      if (info.mtimeMs < cutoff) await rm(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}