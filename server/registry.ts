import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ThreadRecord } from "../shared/types";

/**
 * 线程注册表：只持久化线程元数据（不存 Q&A 正文）。
 * 转录的唯一数据源是 Paseo 侧聊 agent 的 timeline。
 */

interface PersistedState {
  version: 1;
  threads: ThreadRecord[];
  /** clientRequestId → threadId（近 50 条，防重复建线程）。 */
  requestIds: Record<string, string>;
}

const dir = join(homedir(), ".paseo", "plugin-data", "paseo-bytheway");
const file = join(dir, "threads.json");
const SAVE_DEBOUNCE_MS = 300;
const MAX_REQUEST_IDS = 50;

const threads = new Map<string, ThreadRecord>();
const requestIds = new Map<string, string>();

let loadedPromise: Promise<void> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let idSeq = 0;

export function ensureLoaded(): Promise<void> {
  loadedPromise ??= (async () => {
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as PersistedState;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.threads)) return;
      for (const record of parsed.threads) {
        if (!record?.id || !record.agentId) continue;
        threads.set(record.id, {
          ...record,
          pinned: record.pinned ?? false,
          modeId: record.modeId ?? null,
          thinkingOptionId: record.thinkingOptionId ?? null,
          featureValues: record.featureValues ?? {},
          stateReason: record.stateReason ?? null,
          syncCursor: record.syncCursor ?? null,
        });
      }
      if (parsed.requestIds && typeof parsed.requestIds === "object") {
        for (const [key, value] of Object.entries(parsed.requestIds).slice(-MAX_REQUEST_IDS)) {
          requestIds.set(key, value);
        }
      }
    } catch {
      // 首次运行或数据损坏：从空状态开始
    }
  })();
  return loadedPromise;
}

function snapshot(): PersistedState {
  return {
    version: 1,
    threads: [...threads.values()],
    requestIds: Object.fromEntries([...requestIds.entries()].slice(-MAX_REQUEST_IDS)),
  };
}

export function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushSave();
  }, SAVE_DEBOUNCE_MS);
}

export async function flushSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(snapshot()), "utf8");
    await rename(tmp, file);
  } catch (error) {
    console.error("[bytheway] failed to persist registry", error);
  }
}

export function newThreadId(): string {
  idSeq += 1;
  return `sk_${Date.now().toString(36)}_${idSeq.toString(36)}`;
}

export function listThreads(mainAgentId: string): ThreadRecord[] {
  return [...threads.values()]
    .filter((thread) => thread.mainAgentId === mainAgentId)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
}

export function getThread(threadId: string): ThreadRecord | undefined {
  return threads.get(threadId);
}

export function upsertThread(record: ThreadRecord): void {
  threads.set(record.id, record);
  scheduleSave();
}

export function removeThread(threadId: string): void {
  threads.delete(threadId);
  scheduleSave();
}

/** 最近活跃的 open 线程（供 /btw 续聊）。 */
export function findLastActive(mainAgentId: string): ThreadRecord | undefined {
  return [...threads.values()]
    .filter((thread) => thread.mainAgentId === mainAgentId && thread.state === "open")
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

export function knownThreadIds(): Set<string> {
  return new Set(threads.keys());
}

/** 按 backing agent id 反查线程（供权限钩子识别本插件的 agent）。 */
export function findThreadByAgentId(agentId: string): ThreadRecord | undefined {
  for (const thread of threads.values()) {
    if (thread.agentId === agentId) return thread;
  }
  return undefined;
}

export function rememberRequestId(requestId: string, threadId: string): void {
  requestIds.set(requestId, threadId);
  while (requestIds.size > MAX_REQUEST_IDS) {
    const first = requestIds.keys().next().value;
    if (first === undefined) break;
    requestIds.delete(first);
  }
  scheduleSave();
}

export function lookupRequestId(requestId: string): string | undefined {
  return requestIds.get(requestId);
}
