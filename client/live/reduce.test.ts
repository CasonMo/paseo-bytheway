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
