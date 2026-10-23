import { extractInitialPrompt, normalizePrompt } from "./initial-prompt";
import type {
  LiveAction,
  LiveItem,
  LiveState,
  RawItem,
  StreamEvent,
  UsageLike,
} from "./types";

/**
 * 纯函数时间线 reducer：
 * 事件流（订阅）+ refetch（快照）→ 渲染状态。
 * 设计约定：
 * - assistant / reasoning 的流式事件携带「累计文本」，替换当前流式项；
 * - tool_call 按 callId 就地更新；
 * - 新的不同类条目到来或 turn 结束时，流式项转为 complete；
 * - refetch 全量替换条目（保留权限列表）。
 */

function liveKey(state: LiveState): string {
  return `live:${state.nextSeq}`;
}

function pushItem(state: LiveState, item: LiveItem): LiveState {
  return { ...state, items: [...state.items, item], nextSeq: state.nextSeq + 1 };
}

function replaceItem(state: LiveState, key: string, item: LiveItem): LiveState {
  const index = state.items.findIndex((entry) => entry.key === key);
  if (index < 0) return pushItem(state, item);
  const items = state.items.slice();
  items[index] = item;
  return { ...state, items };
}

/** 把流式中的 assistant/reasoning 标记为完成。 */
function closeStreams(state: LiveState): LiveState {
  let changed = false;
  const items = state.items.map((item) => {
    if ((item.kind === "assistant" || item.kind === "reasoning") && item.phase === "streaming") {
      changed = true;
      return { ...item, phase: "complete" as const };
    }
    return item;
  });
  return changed ? { ...state, items } : state;
}

function hasUserPrompt(items: LiveItem[], text: string): boolean {
  const target = normalizePrompt(text);
  return items.some((item) => item.kind === "user" && normalizePrompt(item.text) === target);
}

/** Update the synthetic initial-prompt bubble in place, or prepend it once. */
function upsertInitialPrompt(state: LiveState, text: string, key: string): LiveState {
  const index = state.items.findIndex(
    (item) => item.kind === "user" && item.key.startsWith("initial:"),
  );
  if (index >= 0) {
    const existing = state.items[index];
    if (existing.kind === "user" && normalizePrompt(existing.text) === normalizePrompt(text)) {
      return state;
    }
    const items = state.items.slice();
    items[index] = { kind: "user", key: existing.key, text };
    return { ...state, items };
  }
  if (hasUserPrompt(state.items, text)) return state;
  return { ...state, items: [{ kind: "user", key, text }, ...state.items] };
}

/** Only dedupe a real initial user_message that arrives beside the envelope. */
function isInitialDuplicate(items: LiveItem[], text: string): boolean {
  const target = normalizePrompt(text);
  let sawInitial = false;
  for (const item of items) {
    if (item.kind === "user" && item.key.startsWith("initial:")) {
      if (normalizePrompt(item.text) !== target) return false;
      sawInitial = true;
      continue;
    }
    if (item.kind === "tool" && item.name === "agent_message") continue;
    return false;
  }
  return sawInitial;
}

function findTool(items: LiveItem[], callId: string): Extract<LiveItem, { kind: "tool" }> | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind === "tool" && item.callId === callId) return item;
  }
  return undefined;
}

function applyTimelineItem(state: LiveState, raw: RawItem, turnId: string | null): LiveState {
  switch (raw.type) {
    case "user_message": {
      const chunk = (raw.text ?? "").replace(/\r/g, "");
      if (!/\S/.test(chunk)) return state;
      if (isInitialDuplicate(state.items, chunk)) return state;
      const next = closeStreams(state);
      return pushItem(next, { kind: "user", key: liveKey(next), text: chunk });
    }
    case "assistant_message": {
      // 官方语义：流事件是增量片段（delta），需要 text += chunk 追加。
      const chunk = (raw.text ?? "").replace(/\r/g, "");
      if (!chunk) return state;
      const hasContent = /\S/.test(chunk);
      const messageId = raw.messageId;
      const items = state.items;
      const last = items[items.length - 1];
      if (last && last.kind === "assistant" && (messageId === undefined || last.messageId === messageId)) {
        return replaceItem(state, last.key, { ...last, text: last.text + chunk, phase: "streaming" });
      }
      const prev = items[items.length - 2];
      if (
        last?.kind === "user" &&
        prev?.kind === "assistant" &&
        (messageId === undefined || prev.messageId === messageId)
      ) {
        // 流中间插入了用户消息（如 steer）：继续追加到其之前的助手消息
        const updated = { ...prev, text: prev.text + chunk, phase: "streaming" as const };
        const nextItems = items.slice();
        nextItems[items.length - 2] = updated;
        return { ...state, items: nextItems };
      }
      if (!hasContent) return state;
      const next = closeStreams(state);
      return pushItem(next, {
        kind: "assistant",
        key: liveKey(next),
        text: chunk,
        phase: "streaming",
        turnId,
        ...(messageId !== undefined ? { messageId } : {}),
      });
    }
    case "reasoning": {
      const chunk = (raw.text ?? "").replace(/\r/g, "");
      if (!chunk) return state;
      const hasContent = /\S/.test(chunk);
      const last = state.items[state.items.length - 1];
      if (last && last.kind === "reasoning") {
        return replaceItem(state, last.key, { ...last, text: last.text + chunk, phase: "streaming" });
      }
      if (!hasContent) return state;
      const next = closeStreams(state);
      return pushItem(next, {
        kind: "reasoning",
        key: liveKey(next),
        text: chunk,
        phase: "streaming",
        turnId,
      });
    }
    case "tool_call": {
      const initialPrompt = extractInitialPrompt(raw);
      const withInitialPrompt = initialPrompt
        ? upsertInitialPrompt(state, initialPrompt, `initial:${raw.callId}`)
        : state;
      const next = closeStreams(withInitialPrompt);
      const existing = findTool(next.items, raw.callId);
      const item: Extract<LiveItem, { kind: "tool" }> = {
        kind: "tool",
        key: existing?.key ?? `tool:${raw.callId}`,
        callId: raw.callId,
        name: raw.name,
        status: raw.status,
        detail: raw.detail ?? null,
        error: raw.error ?? null,
        turnId,
      };
      return existing ? replaceItem(next, existing.key, item) : pushItem(next, item);
    }
    case "todo": {
      const next = closeStreams(state);
      for (let i = next.items.length - 1; i >= 0; i -= 1) {
        const item = next.items[i];
        if (item.kind === "todo") {
          return replaceItem(next, item.key, { ...item, items: raw.items, turnId });
        }
        if (item.kind === "user") break;
      }
      return pushItem(next, { kind: "todo", key: liveKey(next), items: raw.items, turnId });
    }
    case "error": {
      const next = closeStreams(state);
      return pushItem(next, { kind: "error", key: liveKey(next), message: raw.message });
    }
    case "notification": {
      const next = closeStreams(state);
      return pushItem(next, {
        kind: "notice",
        key: liveKey(next),
        level: raw.level ?? "info",
        message: raw.message,
      });
    }
    case "compaction": {
      const next = closeStreams(state);
      return pushItem(next, { kind: "compaction", key: liveKey(next), status: raw.status });
    }
    default:
      return state;
  }
}

function finishTurn(
  state: LiveState,
  status: "completed" | "failed" | "canceled",
  usage?: UsageLike | null,
  error?: string,
): LiveState {
  const next = closeStreams(state);
  return {
    ...next,
    turn: {
      ...next.turn,
      status,
      finishedAt: Date.now(),
      usage: usage ?? next.turn.usage,
      error: error ?? next.turn.error,
    },
  };
}

function applyStream(state: LiveState, event: StreamEvent): LiveState {
  switch (event.type) {
    case "turn_started":
      return {
        ...state,
        turn: {
          turnId: event.turnId ?? null,
          status: "running",
          startedAt: Date.now(),
          finishedAt: null,
          usage: null,
          provider: event.provider,
          error: null,
        },
      };
    case "timeline":
      return applyTimelineItem(state, event.item, event.turnId ?? state.turn.turnId);
    case "turn_completed":
      return finishTurn(state, "completed", event.usage ?? null);
    case "turn_failed": {
      const next = pushItem(closeStreams(state), {
        kind: "error",
        key: liveKey(state),
        message: event.error,
      });
      return finishTurn(next, "failed", null, event.error);
    }
    case "turn_canceled": {
      const next = pushItem(closeStreams(state), {
        kind: "notice",
        key: liveKey(state),
        level: "info",
        message: `已取消（${event.reason}）`,
      });
      return finishTurn(next, "canceled");
    }
    case "usage_updated":
      return { ...state, turn: { ...state.turn, usage: event.usage } };
    case "permission_requested":
      return {
        ...state,
        permissions: [
          ...state.permissions.filter((entry) => entry.id !== event.request.id),
          { id: event.request.id, request: event.request, receivedAt: Date.now() },
        ],
      };
    case "permission_resolved":
      return {
        ...state,
        permissions: state.permissions.filter((entry) => entry.id !== event.requestId),
      };
    default:
      return state;
  }
}

export function liveReducer(state: LiveState, action: LiveAction): LiveState {
  switch (action.type) {
    case "reset":
      return {
        ...state,
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
    case "refetch":
      return { ...state, epoch: action.epoch, items: action.items };
    case "initial_prompt":
      return upsertInitialPrompt(state, action.text, "initial:prompt");
    case "turn_snapshot": {
      if (action.activeTurn) {
        const parsed = action.activeTurn.startedAt ? Date.parse(action.activeTurn.startedAt) : Number.NaN;
        const startedAt = Number.isFinite(parsed) ? parsed : Date.now();
        if (state.turn.status === "running" && state.turn.turnId === action.activeTurn.turnId) {
          return { ...state, turn: { ...state.turn, usage: action.usage ?? state.turn.usage } };
        }
        return {
          ...state,
          turn: {
            turnId: action.activeTurn.turnId,
            status: "running",
            startedAt,
            finishedAt: null,
            usage: action.usage ?? null,
            provider: state.turn.provider,
            error: null,
          },
        };
      }
      if (state.turn.status === "running") {
        return {
          ...state,
          turn: {
            ...state.turn,
            status: "completed",
            finishedAt: state.turn.finishedAt ?? Date.now(),
            usage: action.usage ?? state.turn.usage,
          },
        };
      }
      return state;
    }
    case "stream":
      return applyStream(state, action.payload.event);
    case "restored":
      return { ...state, connection: "restored" };
    case "replacement":
      return { ...state, epoch: action.epoch, items: [] };
    case "connection":
      return { ...state, connection: action.status, connectionError: null };
    case "error":
      return { ...state, connection: "error", connectionError: action.error };
    default:
      return state;
  }
}
