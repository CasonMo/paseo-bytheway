import { describe, expect, it } from "vitest";
import { extractInitialPrompt, findInitialPromptInPages } from "./initial-prompt";
import type { RawItem } from "./types";

function tool(text: unknown, name = "agent_message", detailType = "plain_text"): RawItem {
  return {
    type: "tool_call",
    callId: "call-1",
    name,
    status: "completed",
    detail: { type: detailType, text },
  };
}

describe("extractInitialPrompt", () => {
  it("returns a plain initial prompt", () => {
    expect(extractInitialPrompt(tool("请帮我检查这个问题"))).toBe("请帮我检查这个问题");
  });

  it("cuts the passive context snapshot from the prompt", () => {
    expect(
      extractInitialPrompt(
        tool("请检查登录问题\n\n以下为主会话的最近上下文快照（生成于 2026-01-01）。\n### 最近消息\n助手: ..."),
      ),
    ).toBe("请检查登录问题");
  });

  it("extracts the user question from a continuation wrapper", () => {
    expect(
      extractInitialPrompt(
        tool(
          "这是一条接续的侧聊线程（用户更换了模型或模式）。请先调用 MCP 工具 get_agent_activity 读取 agent a1 的最近活动，了解先前对话的结论与语气，然后处理：\n\n新模型下继续分析这个问题",
        ),
      ),
    ).toBe("新模型下继续分析这个问题");
  });

  it("extracts the user question from an active rebuild wrapper", () => {
    expect(
      extractInitialPrompt(
        tool("这是一条被重建的侧聊线程。请先读取旧活动。然后继续处理：\n\n继续查这个 bug"),
      ),
    ).toBe("继续查这个 bug");
  });

  it("extracts the user question from a passive rebuild wrapper", () => {
    expect(extractInitialPrompt(tool("这是一条被重建的侧聊线程。\n\n继续查这个 bug"))).toBe(
      "继续查这个 bug",
    );
  });

  it("cuts the rebuilt-thread history summary", () => {
    expect(
      extractInitialPrompt(
        tool("继续查这个 bug\n\n以下为该侧聊线程被重建前的历史摘要（可能不完整）：\n助手: ..."),
      ),
    ).toBe("继续查这个 bug");
  });

  it("ignores unrelated tools and malformed details", () => {
    expect(extractInitialPrompt(tool("x", "shell", "shell"))).toBeNull();
    expect(extractInitialPrompt(tool(undefined))).toBeNull();
    expect(extractInitialPrompt(null)).toBeNull();
    expect(extractInitialPrompt({ type: "tool_call", name: "agent_message" })).toBeNull();
  });

  it("walks backwards when the initial prompt is outside the tail page", async () => {
    let calls = 0;
    const prompt = await findInitialPromptInPages(
      {
        entries: [{ item: { type: "assistant_message", text: "tail" } }],
        hasOlder: true,
        startCursor: { seq: 200 },
      },
      async () => {
        calls += 1;
        return {
          entries: [{ item: tool("很久以前的最初问题") }],
          hasOlder: false,
          startCursor: null,
        };
      },
    );

    expect(prompt).toBe("很久以前的最初问题");
    expect(calls).toBe(1);
  });

  it("stops if the timeline returns a repeated cursor", async () => {
    let calls = 0;
    const cursor = { seq: 20 };
    const prompt = await findInitialPromptInPages(
      { entries: [], hasOlder: true, startCursor: cursor },
      async () => {
        calls += 1;
        return { entries: [], hasOlder: true, startCursor: cursor };
      },
    );

    expect(prompt).toBeNull();
    expect(calls).toBe(1);
  });
 });
