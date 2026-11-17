import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  featuresToValues,
  type PaseoApi,
} from "./context";

describe("featuresToValues", () => {
  it("提取 toggle/select 的值并跳过未设置的项", () => {
    const values = featuresToValues([
      { id: "auto_accept", value: true },
      { id: "some_select", value: "high" },
      { id: "unset_select", value: null },
    ]);
    expect(values).toEqual({ auto_accept: true, some_select: "high" });
  });

  it("容忍空输入", () => {
    expect(featuresToValues(undefined)).toEqual({});
    expect(featuresToValues(null)).toEqual({});
    expect(featuresToValues([])).toEqual({});
  });
});

describe("buildSystemPrompt", () => {
  it("defers to provider permissions when no explicit provider mode is selected", () => {
    const prompt = buildSystemPrompt({
      mainAgentId: "agent-1",
      mode: "provider",
      toolsAvailable: true,
      passive: false,
    });
    expect(prompt).toContain("遵循当前 Paseo provider mode 的权限约束");
    expect(prompt).not.toContain("只读建议模式");
  });

  it("keeps an explicit plan/read-only mode explicit", () => {
    const prompt = buildSystemPrompt({
      mainAgentId: "agent-1",
      mode: "ask",
      toolsAvailable: true,
      passive: false,
    });
    expect(prompt).toContain("只读建议模式");
  });
});
