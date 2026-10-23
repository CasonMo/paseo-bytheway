import { usePaseo } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { extractInitialPrompt, findInitialPromptInPages, normalizePrompt } from "./initial-prompt";
import { liveReducer } from "./reduce";
import {
  initialLiveState,
  type LiveItem,
  type LiveState,
  type RawItem,
  type StreamPayload,
  type UsageLike,
} from "./types";

type PaseoApi = ReturnType<typeof usePaseo>;
type TimelinePage = Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["timeline"]["refetch"]>>;
type TimelineEntry = TimelinePage["entries"][number];

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 快照（refetch）条目 → 渲染条目。 */
export function convertEntries(entries: TimelineEntry[], fallbackInitialPrompt?: string | null): LiveItem[] {
  const rawEntries = entries.map((entry) => ({
    entry,
    item: entry.item as unknown as RawItem,
  }));
  let initialPrompt: { callId: string | null; text: string; index: number } | null = null;
  for (const [index, { item }] of rawEntries.entries()) {
    const text = extractInitialPrompt(item);
    if (text) {
      initialPrompt = { callId: item.type === "tool_call" ? item.callId : null, text, index };
      break;
    }
  }
  if (!initialPrompt && fallbackInitialPrompt) {
    initialPrompt = { callId: null, text: fallbackInitialPrompt, index: -1 };
  }
  // Some providers may also record the initial prompt as a real user_message.
  // Replace only the message immediately beside the envelope; a later identical
  // message is a genuine repeated question.
  const duplicateUserIndex =
    initialPrompt && initialPrompt.index >= 0
      ? rawEntries.findIndex(
          ({ item }, index) =>
            item.type === "user_message" &&
            Math.abs(index - initialPrompt.index) <= 1 &&
            normalizePrompt(item.text) === normalizePrompt(initialPrompt.text),
        )
      : -1;

  const items: LiveItem[] = [];
  for (const [index, { entry, item }] of rawEntries.entries()) {
    const key = `seq:${entry.seqStart}`;
    const turnId = (entry as unknown as { turnId?: string }).turnId ?? null;
    switch (item.type) {
      case "user_message":
        if (index !== duplicateUserIndex) items.push({ kind: "user", key, text: item.text });
        break;
      case "assistant_message":
        items.push({
          kind: "assistant",
          key,
          text: item.text,
          phase: "complete",
          turnId,
          ...(typeof item.messageId === "string" ? { messageId: item.messageId } : {}),
        });
        break;
      case "reasoning":
        items.push({ kind: "reasoning", key, text: item.text, phase: "complete", turnId });
        break;
      case "tool_call": {
        const toolKey = `tool:${item.callId}`;
        const next: LiveItem = {
          kind: "tool",
          key: toolKey,
          callId: item.callId,
          name: item.name,
          status: item.status,
          detail: item.detail ?? null,
          error: item.error ?? null,
          turnId,
        };
        const existing = items.findIndex((entryItem) => entryItem.key === toolKey);
        if (existing >= 0) items[existing] = next;
        else items.push(next);
        break;
      }
      case "todo":
        items.push({ kind: "todo", key, items: item.items, turnId });
        break;
      case "error":
        items.push({ kind: "error", key, message: item.message });
        break;
      case "notification":
        items.push({ kind: "notice", key, level: item.level ?? "info", message: item.message });
        break;
      case "compaction":
        items.push({ kind: "compaction", key, status: item.status });
        break;
      default:
        // plugin 条目等暂不渲染
        break;
    }
  }
  if (initialPrompt) {
    items.unshift({
      kind: "user",
      key: `initial:${initialPrompt.callId ?? "prompt"}`,
      text: initialPrompt.text,
    });
  }
  return items;
}

export interface PermissionResponseLike {
  behavior: "allow" | "deny";
  selectedActionId?: string;
  message?: string;
  interrupt?: boolean;
  updatedInput?: Record<string, unknown>;
}

export interface ThreadStreamControls {
  state: LiveState;
  refetch: () => Promise<void>;
  respondPermission: (requestId: string, response: PermissionResponseLike) => Promise<void>;
}

/**
 * 选中线程的实时流：refetch 快照 + timeline 订阅（含断线恢复/替换处理）。
 */
export function useThreadStream(agentId: string | null): ThreadStreamControls {
  const paseo = usePaseo();
  const [state, dispatch] = useReducer(liveReducer, undefined, initialLiveState);
  const generationRef = useRef(0);
  const snapshotSeqRef = useRef(0);
  const initialPromptCacheRef = useRef<{ agentId: string; prompt: string } | null>(null);

  const resolveInitialPrompt = useCallback(
    async (targetAgentId: string, firstPage: TimelinePage): Promise<string | null> => {
      const cached = initialPromptCacheRef.current;
      if (cached?.agentId === targetAgentId) return cached.prompt;
      const prompt = await findInitialPromptInPages(
        firstPage,
        (cursor) =>
          paseo.agents.ref(targetAgentId).timeline.refetch({
            direction: "before",
            cursor: cursor as NonNullable<TimelinePage["startCursor"]>,
            limit: 200,
          }),
      );
      if (prompt) initialPromptCacheRef.current = { agentId: targetAgentId, prompt };
      return prompt;
    },
    [paseo],
  );

  const refetch = useCallback(async () => {
    if (!agentId) return;
    const gen = generationRef.current;
    const snapshot = ++snapshotSeqRef.current;
    try {
      const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 200 });
      if (generationRef.current !== gen || snapshotSeqRef.current !== snapshot) return;
      const payload = page as unknown as { epoch?: string | null; entries?: TimelineEntry[] };
      const cached =
        initialPromptCacheRef.current?.agentId === agentId
          ? initialPromptCacheRef.current.prompt
          : null;
      dispatch({
        type: "refetch",
        epoch: payload.epoch ?? null,
        items: convertEntries(payload.entries ?? [], cached),
      });
      // Initial-prompt pagination is non-blocking: render the tail immediately,
      // then upsert the prompt when the older pages resolve.
      void resolveInitialPrompt(agentId, page)
        .then((prompt) => {
          if (
            prompt &&
            generationRef.current === gen &&
            snapshotSeqRef.current === snapshot
          ) {
            dispatch({ type: "initial_prompt", text: prompt });
          }
        })
        .catch(() => {});
    } catch (error) {
      if (generationRef.current !== gen || snapshotSeqRef.current !== snapshot) return;
      dispatch({ type: "error", error: message(error) });
    }
  }, [paseo, agentId, resolveInitialPrompt]);

  useEffect(() => {
    snapshotSeqRef.current += 1;
    dispatch({ type: "reset" });
    if (!agentId) return;
    const gen = ++generationRef.current;
    let disposed = false;
    let subscription: { release: () => Promise<void> | void } | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    const isStale = () => disposed || generationRef.current !== gen;

    const syncTurnSnapshot = async (): Promise<void> => {
      try {
        const snapshot = await paseo.agents.ref(agentId).refresh();
        if (isStale()) return;
        const agent = snapshot?.agent as unknown as
          | {
              activeTurn?: { turnId?: string; startedAt?: string } | null;
              lastUsage?: UsageLike | null;
            }
          | undefined;
        const activeTurn =
          agent?.activeTurn?.turnId != null
            ? { turnId: agent.activeTurn.turnId, startedAt: agent.activeTurn.startedAt ?? null }
            : null;
        dispatch({ type: "turn_snapshot", activeTurn, usage: agent?.lastUsage ?? null });
      } catch {
        // 忽略：稍后由流事件或下次刷新补齐
      }
    };

    const load = async (): Promise<void> => {
      const snapshot = ++snapshotSeqRef.current;
      try {
        const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 200 });
        if (isStale() || snapshotSeqRef.current !== snapshot) return;
        const payload = page as unknown as { epoch?: string | null; entries?: TimelineEntry[] };
        const cached =
          initialPromptCacheRef.current?.agentId === agentId
            ? initialPromptCacheRef.current.prompt
            : null;
        dispatch({
          type: "refetch",
          epoch: payload.epoch ?? null,
          items: convertEntries(payload.entries ?? [], cached),
        });
        void resolveInitialPrompt(agentId, page)
          .then((prompt) => {
            if (prompt && !isStale() && snapshotSeqRef.current === snapshot) {
              dispatch({ type: "initial_prompt", text: prompt });
            }
          })
          .catch(() => {});
      } catch (error) {
        if (isStale() || snapshotSeqRef.current !== snapshot) return;
        dispatch({ type: "error", error: message(error) });
      }
      await syncTurnSnapshot();
    };

    const scheduleRetry = () => {
      if (isStale() || retryTimer) return;
      attempts += 1;
      const delay = Math.min(3000 + attempts * 1000, 15000);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void start();
      }, delay);
    };

    const start = async (): Promise<void> => {
      if (isStale()) return;
      try {
        const handle = paseo.agents.ref(agentId);
        const sub = handle.timeline.subscribe((event) => {
          if (isStale()) return;
          const e = event as unknown as {
            agentId: string;
            subscriptionId?: string;
            event: { type: string } & Record<string, unknown>;
          };
          switch (e.event.type) {
            case "replacement":
              dispatch({ type: "replacement", epoch: String(e.event.epoch ?? "") });
              void load();
              return;
            case "subscription_restored":
              dispatch({ type: "restored" });
              void load().then(() => {
                if (!isStale()) dispatch({ type: "connection", status: "live" });
              });
              return;
            case "error":
              dispatch({ type: "error", error: String(e.event.error ?? "订阅异常") });
              void subscription?.release();
              subscription = null;
              scheduleRetry();
              return;
            default:
              dispatch({ type: "stream", payload: e as unknown as StreamPayload });
          }
        });
        subscription = sub as unknown as { release: () => Promise<void> | void };
        await (sub as unknown as { ready?: Promise<void> }).ready?.catch(() => {});
        if (isStale()) {
          void subscription?.release();
          return;
        }
        // 先订阅后拉快照：订阅期间到达的事件不会丢失，快照作为权威基线覆盖。
        await load();
        if (isStale()) return;
        attempts = 0;
        dispatch({ type: "connection", status: "live" });
      } catch (error) {
        if (isStale()) return;
        dispatch({ type: "error", error: message(error) });
        scheduleRetry();
      }
    };

    void start();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      void subscription?.release();
    };
  }, [agentId, paseo, resolveInitialPrompt]);

  // 权限解决只走独立的 agent_permission_resolved 消息，不进 agent_stream，
  // timeline 订阅收不到，需单独订阅才能被动清除横幅。
  useEffect(() => {
    if (!agentId) return;
    const observation = paseo.observeEvents(["agent_permission_resolved"]);
    const unsubscribe = observation.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type !== "agent_permission_resolved") return;
        const payload = message.payload;
        if (payload.agentId !== agentId) return;
        dispatch({
          type: "stream",
          payload: {
            agentId,
            event: {
              type: "permission_resolved",
              provider: "",
              requestId: payload.requestId,
              resolution: payload.resolution,
            },
          } as unknown as StreamPayload,
        });
      },
    });
    return () => {
      unsubscribe();
      void observation.release().catch(() => {});
    };
  }, [paseo, agentId]);

  const respondPermission = useCallback(
    async (requestId: string, response: PermissionResponseLike) => {
      if (!agentId) return;
      await paseo.agents.ref(agentId).respondToPermission({
        requestId,
        response: response as Parameters<ReturnType<PaseoApi["agents"]["ref"]>["respondToPermission"]>[0]["response"],
      });
      // daemon 只通过独立的 agent_permission_resolved 消息通知，不进 agent_stream，
      // timeline 订阅收不到，本地立即清除。
      dispatch({
        type: "stream",
        payload: {
          agentId,
          event: { type: "permission_resolved", provider: "", requestId, resolution: response },
        } as unknown as StreamPayload,
      });
    },
    [paseo, agentId, dispatch],
  );

  return { state, refetch, respondPermission };
}
