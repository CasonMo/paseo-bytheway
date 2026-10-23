import { describe, expect, it } from "vitest";
import { convertEntries } from "./store";

function entry(seqStart: number, item: Record<string, unknown>) {
  return { seqStart, item } as never;
}

describe("convertEntries initial prompt", () => {
  it("prepends the initial prompt and keeps the agent_message row", () => {
    const items = convertEntries([
      entry(1, {
        type: "tool_call",
        callId: "agent-message-1",
        name: "agent_message",
        status: "completed",
        detail: {
          type: "plain_text",
          text: "最初的问题\n\n以下为主会话的最近上下文快照（生成于 2026-01-01）。",
        },
      }),
      entry(2, { type: "reasoning", text: "思考" }),
    ]);

    expect(items[0]).toMatchObject({ kind: "user", text: "最初的问题" });
    expect(items.some((item) => item.kind === "tool" && item.name === "agent_message")).toBe(true);
  });

  it("does not duplicate an identical user message already present in the timeline", () => {
    const items = convertEntries([
      entry(1, {
        type: "tool_call",
        callId: "agent-message-1",
        name: "agent_message",
        status: "completed",
        detail: { type: "plain_text", text: "同一个问题" },
      }),
      entry(2, { type: "user_message", text: "同一个问题" }),
    ]);

    expect(items.filter((item) => item.kind === "user" && item.text === "同一个问题")).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "user", text: "同一个问题" });
    expect(items[1]).toMatchObject({ kind: "tool", name: "agent_message" });
  });

  it("keeps a later repeated question instead of treating it as the initial prompt", () => {
    const items = convertEntries([
      entry(1, {
        type: "tool_call",
        callId: "agent-message-1",
        name: "agent_message",
        status: "completed",
        detail: { type: "plain_text", text: "重复的问题" },
      }),
      entry(2, { type: "assistant_message", text: "第一次回答" }),
      entry(3, { type: "user_message", text: "另一个问题" }),
      entry(4, { type: "assistant_message", text: "第二次回答" }),
      entry(5, { type: "user_message", text: "重复的问题" }),
    ]);

    expect(items.filter((item) => item.kind === "user" && item.text === "重复的问题")).toHaveLength(2);
  });

  it("uses a paginated initial prompt when the tail page does not contain it", () => {
    const items = convertEntries(
      [entry(450, { type: "assistant_message", text: "很早以前的回答" })],
      "很久以前的最初问题",
    );

    expect(items[0]).toMatchObject({ kind: "user", text: "很久以前的最初问题" });
    expect(items[1]).toMatchObject({ kind: "assistant", text: "很早以前的回答" });
  });
});
