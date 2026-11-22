import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { uploadsForMessage, type StoredAttachment } from "../shared/contracts";

const cache = new Map<string, StoredAttachment[]>();
/** 回显缓存上限（FIFO 淘汰）：避免长会话里 base64 图片无限堆积。 */
const MAX_CACHE_ENTRIES = 64;

function remember(key: string, attachments: StoredAttachment[]): void {
  cache.delete(key);
  cache.set(key, attachments);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** 消息气泡的落盘附件回显；空结果也缓存（更新前的旧消息没有副本）。 */
export function useMessageAttachments(
  threadId: string | null,
  messageId?: string,
): StoredAttachment[] {
  const rpc = useRpc(uploadsForMessage);
  const key = threadId && messageId ? `${threadId}/${messageId}` : null;
  const [attachments, setAttachments] = useState<StoredAttachment[]>(() =>
    key ? (cache.get(key) ?? []) : [],
  );
  useEffect(() => {
    if (!key || !threadId || !messageId) {
      setAttachments([]);
      return;
    }
    const cached = cache.get(key);
    if (cached) {
      setAttachments(cached);
      return;
    }
    let alive = true;
    rpc({ threadId, messageId })
      .then((result) => {
        remember(key, result.attachments);
        if (alive) setAttachments(result.attachments);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [key, threadId, messageId, rpc]);
  return attachments;
}