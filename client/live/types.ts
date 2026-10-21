/** 客户端实时流引擎的数据结构与动作定义（纯数据，无运行时依赖）。 */

export interface UsageLike {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  contextWindowMaxTokens?: number;
  contextWindowUsedTokens?: number;
}

export interface ToolDetailLike {
  type?: string;
  [key: string]: unknown;
}

export interface PermissionActionLike {
  id: string;
  label: string;
  behavior: "allow" | "deny";
  variant?: string;
}

export interface PermissionRequestLike {
  id: string;
  name?: string;
  kind?: string;
  title?: string;
  description?: string;
  input?: unknown;
  detail?: ToolDetailLike;
  actions?: PermissionActionLike[];
  [key: string]: unknown;
}

export interface RawTodoEntry {
  id?: string;
  text: string;
  completed?: boolean;
  status?: string;
}

export type RawItem =
  | { type: "user_message"; text: string; messageId?: string }
  | { type: "assistant_message"; text: string; messageId?: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool_call";
      callId: string;
      name: string;
      status: "running" | "completed" | "failed" | "canceled";
      detail?: ToolDetailLike;
      error?: unknown;
    }
  | { type: "todo"; items: RawTodoEntry[] }
  | { type: "error"; message: string }
  | { type: "notification"; level: "info" | "warning" | "error"; message: string }
  | { type: "compaction"; status: string; trigger?: string };

export type StreamEvent =
  | { type: "thread_started"; sessionId: string; provider: string }
  | { type: "turn_started"; provider: string; turnId?: string }
  | { type: "turn_completed"; provider: string; turnId?: string; usage?: UsageLike }
  | { type: "turn_failed"; provider: string; error: string; code?: string; diagnostic?: string; turnId?: string }
  | { type: "turn_canceled"; provider: string; reason: string; turnId?: string }
  | { type: "usage_updated"; provider: string; usage: UsageLike; turnId?: string }
  | { type: "timeline"; provider: string; item: RawItem; turnId?: string; timestamp?: string }
  | { type: "permission_requested"; provider: string; request: PermissionRequestLike }
  | { type: "permission_resolved"; provider: string; requestId: string; resolution: unknown };

export interface StreamPayload {
  agentId: string;
  subscriptionId?: string;
  event: StreamEvent;
}

/* ------------------------------------------------------------------ */
/* 渲染条目                                                             */
/* ------------------------------------------------------------------ */

export interface AssistantItem {
  kind: "assistant";
  key: string;
  text: string;
  phase: "streaming" | "complete";
  turnId: string | null;
  messageId?: string;
}

export interface ReasoningItem {
  kind: "reasoning";
  key: string;
  text: string;
  phase: "streaming" | "complete";
  turnId: string | null;
}

export interface UserItem {
  kind: "user";
  key: string;
  text: string;
}

export interface ToolItem {
  kind: "tool";
  key: string;
  callId: string;
  name: string;
  status: "running" | "completed" | "failed" | "canceled";
  detail: ToolDetailLike | null;
  error: unknown;
  turnId: string | null;
}

export interface TodoItem {
  kind: "todo";
  key: string;
  items: RawTodoEntry[];
  turnId: string | null;
}

export interface NoticeItem {
  kind: "notice";
  key: string;
  level: "info" | "warning" | "error";
  message: string;
}

export interface ErrorItem {
  kind: "error";
  key: string;
  message: string;
}

export interface CompactionItem {
  kind: "compaction";
  key: string;
  status: string;
}

export type LiveItem =
  | AssistantItem
  | ReasoningItem
  | UserItem
  | ToolItem
  | TodoItem
  | NoticeItem
  | ErrorItem
  | CompactionItem;

/* ------------------------------------------------------------------ */
/* 状态与动作                                                           */
/* ------------------------------------------------------------------ */

export interface TurnInfo {
  turnId: string | null;
  status: "idle" | "running" | "completed" | "failed" | "canceled";
  startedAt: number | null;
  finishedAt: number | null;
  usage: UsageLike | null;
  provider: string | null;
  error: string | null;
}

export interface PendingPermission {
  id: string;
  request: PermissionRequestLike;
  receivedAt: number;
}

export interface LiveState {
  epoch: string | null;
  items: LiveItem[];
  nextSeq: number;
  turn: TurnInfo;
  permissions: PendingPermission[];
  connection: "connecting" | "live" | "restored" | "error";
  connectionError: string | null;
}

export type LiveAction =
  | { type: "reset" }
  | { type: "refetch"; epoch: string | null; items: LiveItem[] }
  | {
      type: "turn_snapshot";
      activeTurn: { turnId: string; startedAt: string | null } | null;
      usage: UsageLike | null;
    }
  | { type: "stream"; payload: StreamPayload }
  | { type: "restored" }
  | { type: "replacement"; epoch: string }
  | { type: "connection"; status: LiveState["connection"] }
  | { type: "error"; error: string };

export function initialLiveState(): LiveState {
  return {
    epoch: null,
    items: [],
    nextSeq: 1,
    turn: {
      turnId: null,
      status: "idle",
      startedAt: null,
      finishedAt: null,
      usage: null,
      provider: null,
      error: null,
    },
    permissions: [],
    connection: "connecting",
    connectionError: null,
  };
}
