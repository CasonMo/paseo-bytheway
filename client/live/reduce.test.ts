import { describe, expect, it } from "vitest";
import { liveReducer } from "./reduce";
import { initialLiveState, type LiveState, type StreamPayload } from "./types";

function stream(state: LiveState, event: Record<string, unknown>): LiveState {
  return liveReducer(state, {
    type: "stream",
    payload: { agentId: "a1", event } as unknown as StreamPayload,
  });
}

describe("liveReducer（增量追加语义，对齐官方运行时）", () => {
  it("assistant 增量片段累加；空片段忽略；工具调用后新片段成为新条目", () => {
    let state = initialLiveState();
    state = stream(state, { type: "turn_started", provider: "p", turnId: "t1" });
    state = stream(state, { type: "timeline", provider: "p", turnId: "t1", item: { type: "assistant_message", text: "你" } });
    state = stream(state, { type: "timeline", provider: "p", turnId: "t1", item: { type: "assistant_message", text: "好" } });
    state = stream(state, { type: "timeline", provider: "p", turnId: "t1", item: { type: "assistant_message", text: "" } });
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: "assistant", text: "你好", phase: "streaming" });

    state = stream(state, { type: "timeline", provider: "p", turnId: "t1", item: { type: "tool_call", callId: "c1", name: "shell", status: "running", detail: { type: "shell", command: "ls" } } });
    expect(state.items[0]).toMatchObject({ kind: "assistant", phase: "complete" });
    state = stream(state, { type: "timeline", provider: "p", turnId: "t1", item: { type: "tool_call", callId: "c1", name: "shell", status: "completed", detail: { type: "shell", command: "ls" } } });
    state = stream(state, { type: "timeline", provider: "p", turnId: "t1", item: { type: "assistant_message", text: "完成" } });
    state = stream(state, { type: "timeline", provider: "p", turnId: "t1", item: { type: "assistant_message", text: "了" } });
    expect(state.items).toHaveLength(3);
    expect(state.items[2]).toMatchObject({ kind: "assistant", text: "完成了", phase: "streaming" });
  });

  it("首条 agent_message 在会话顶部补上用户 prompt，同时保留工具行", () => {
    let state = initialLiveState();
    state = stream(state, {
      type: "timeline",
      provider: "p",
      item: {
        type: "tool_call",
        callId: "agent-message-1",
        name: "agent_message",
        status: "running",
        detail: {
          type: "plain_text",
          text: "最初的问题\n\n以下为主会话的最近上下文快照（生成于 2026-01-01）。",
        },
      },
    });

    expect(state.items).toHaveLength(2);
    expect(state.items[0]).toMatchObject({ kind: "user", text: "最初的问题" });
    expect(state.items[1]).toMatchObject({ kind: "tool", name: "agent_message" });

    state = stream(state, {
      type: "timeline",
      provider: "p",
      item: {
        type: "tool_call",
        callId: "agent-message-1",
        name: "agent_message",
        status: "completed",
        detail: {
          type: "plain_text",
          text: "最初的问题\n\n以下为主会话的最近上下文快照（生成于 2026-01-01）。",
        },
      },
    });
    expect(state.items).toHaveLength(2);
    expect(state.items[0]).toMatchObject({ kind: "user", text: "最初的问题" });
    expect(state.items[1]).toMatchObject({ kind: "tool", name: "agent_message", status: "completed" });
  });

  it("用户后来重复发送相同问题时不会被初始 prompt 去重吞掉", () => {
    let state = initialLiveState();
    state = stream(state, {
      type: "timeline",
      provider: "p",
      item: {
        type: "tool_call",
        callId: "agent-message-repeat",
        name: "agent_message",
        status: "completed",
        detail: { type: "plain_text", text: "同样的问题" },
      },
    });
    state = stream(state, { type: "timeline", provider: "p", item: { type: "user_message", text: "另一个问题" } });
    state = stream(state, { type: "timeline", provider: "p", item: { type: "user_message", text: "同样的问题" } });

    expect(state.items.filter((item) => item.kind === "user" && item.text === "同样的问题")).toHaveLength(2);
  });

  it("首条 agent_message 先到但文本后到时，会补上 prompt 并保留工具行", () => {
    let state = initialLiveState();
    state = stream(state, {
      type: "timeline",
      provider: "p",
      item: {
        type: "tool_call",
        callId: "agent-message-late",
        name: "agent_message",
        status: "running",
        detail: { type: "plain_text", text: "" },
      },
    });
    expect(state.items[0]).toMatchObject({ kind: "tool", name: "agent_message" });

    state = stream(state, {
      type: "timeline",
      provider: "p",
      item: {
        type: "tool_call",
        callId: "agent-message-late",
        name: "agent_message",
        status: "completed",
        detail: { type: "plain_text", text: "后到的最初问题" },
      },
    });

    expect(state.items).toHaveLength(2);
    expect(state.items[0]).toMatchObject({ kind: "user", text: "后到的最初问题" });
    expect(state.items[1]).toMatchObject({ kind: "tool", name: "agent_message", status: "completed" });
  });

  it("agent_message 的文本补全时更新同一个 prompt 气泡，不重复插入", () => {
    let state = initialLiveState();
    const item = (text: string) => ({
      type: "tool_call" as const,
      callId: "agent-message-partial",
      name: "agent_message",
      status: "running" as const,
      detail: { type: "plain_text", text },
    });
    state = stream(state, { type: "timeline", provider: "p", item: item("Q1") });
    state = stream(state, { type: "timeline", provider: "p", item: item("Q1 full") });

    expect(state.items.filter((entry) => entry.kind === "user" && entry.key.startsWith("initial:"))).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: "user", text: "Q1 full" });
  });

  it("初始 prompt 后紧跟真实同名 user_message 时不会重复", () => {
    let state = initialLiveState();
    state = stream(state, {
      type: "timeline",
      provider: "p",
      item: {
        type: "tool_call",
        callId: "agent-message-dedupe",
        name: "agent_message",
        status: "completed",
        detail: { type: "plain_text", text: "同一个问题" },
      },
    });
    state = stream(state, { type: "timeline", provider: "p", item: { type: "user_message", text: "同一个问题" } });

    expect(state.items.filter((entry) => entry.kind === "user" && entry.text === "同一个问题")).toHaveLength(1);
    expect(state.items[1]).toMatchObject({ kind: "tool", name: "agent_message" });
  });

  it("initial_prompt action 会更新顶部同一气泡", () => {
    let state = liveReducer(initialLiveState(), { type: "initial_prompt", text: "第一版问题" });
    expect(state.items[0]).toMatchObject({ kind: "user", text: "第一版问题" });

    state = liveReducer(state, { type: "initial_prompt", text: "补全后的问题" });
    expect(state.items.filter((item) => item.kind === "user" && item.key.startsWith("initial:"))).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: "user", text: "补全后的问题" });
  });

  it("messageId 不同 → 新条目；匹配 → 继续追加", () => {
    let state = initialLiveState();
    state = stream(state, { type: "timeline", provider: "p", item: { type: "assistant_message", text: "A", messageId: "m1" } });
    state = stream(state, { type: "timeline", provider: "p", item: { type: "assistant_message", text: "B", messageId: "m1" } });
    state = stream(state, { type: "timeline", provider: "p", item: { type: "assistant_message", text: "C", messageId: "m2" } });
    expect(state.items).toHaveLength(2);
    expect(state.items[0]).toMatchObject({ text: "AB", messageId: "m1" });
    expect(state.items[1]).toMatchObject({ text: "C", messageId: "m2" });
  });

  it("用户消息插在流中间时，后续片段追加回其之前的助手消息", () => {
    let state = initialLiveState();
    state = stream(state, { type: "timeline", provider: "p", item: { type: "assistant_message", text: "前", messageId: "m1" } });
    state = stream(state, { type: "timeline", provider: "p", item: { type: "user_message", text: "停一下" } });
    state = stream(state, { type: "timeline", provider: "p", item: { type: "assistant_message", text: "后", messageId: "m1" } });
    expect(state.items).toHaveLength(2);
    expect(state.items[0]).toMatchObject({ kind: "assistant", text: "前后" });
    expect(state.items[1]).toMatchObject({ kind: "user", text: "停一下" });
  });

  it("reasoning 增量累加；空白起始片段不建条目", () => {
    let state = initialLiveState();
    state = stream(state, { type: "timeline", provider: "p", item: { type: "reasoning", text: "  " } });
    expect(state.items).toHaveLength(0);
    state = stream(state, { type: "timeline", provider: "p", item: { type: "reasoning", text: "思" } });
    state = stream(state, { type: "timeline", provider: "p", item: { type: "reasoning", text: "考" } });
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: "reasoning", text: "思考", phase: "streaming" });
  });

  it("turn 完成时流式项收尾并记录用量", () => {
    let state = initialLiveState();
    state = stream(state, { type: "turn_started", provider: "p", turnId: "t1" });
    state = stream(state, { type: "timeline", provider: "p", turnId: "t1", item: { type: "assistant_message", text: "hi" } });
    state = stream(state, { type: "turn_completed", provider: "p", turnId: "t1", usage: { outputTokens: 5 } });
    expect(state.turn.status).toBe("completed");
    expect(state.turn.usage).toMatchObject({ outputTokens: 5 });
    expect((state.items[0] as { phase: string }).phase).toBe("complete");
  });

  it("权限请求增删", () => {
    let state = initialLiveState();
    state = stream(state, { type: "permission_requested", provider: "p", request: { id: "r1", title: "run ls" } });
    expect(state.permissions).toHaveLength(1);
    state = stream(state, { type: "permission_resolved", provider: "p", requestId: "r1", resolution: { behavior: "allow" } });
    expect(state.permissions).toHaveLength(0);
  });

  it("refetch 全量替换条目", () => {
    let state = initialLiveState();
    state = stream(state, { type: "timeline", provider: "p", item: { type: "assistant_message", text: "old" } });
    state = liveReducer(state, {
      type: "refetch",
      epoch: "e1",
      items: [{ kind: "user", key: "seq:1", text: "q" }],
    });
    expect(state.epoch).toBe("e1");
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: "user", text: "q" });
  });
});
